/**
 * Draft-expiry sweep worker — standing process that expires STRANDED pre-publish
 * posts on a cadence so they stop accumulating (the "36 stranded approved IG
 * posts" symptom). De-risks widening the weekly trigger (Piece B): without it, a
 * weekly cron generating content for many tenants grows the unscheduled-approved
 * backlog without bound.
 *
 * Gated by ARIES_DRAFT_EXPIRY_ENABLED (default OFF). Mirrors the
 * weekly-job-trigger / scheduled-posts workers: a single-replica
 * docker-compose service, self-scheduling on an interval, talking only to its
 * own Postgres pool. The expiry logic lives in
 * backend/marketing/draft-expiry-sweep.ts (runDraftExpirySweep) — this file is
 * just the loop + config + logging.
 *
 * Safety:
 *   - default OFF; ships dormant. When off the container idles cleanly (no
 *     restart loop), exactly like the weekly-trigger worker.
 *   - ARIES_DRAFT_EXPIRY_DRY_RUN=1 makes every tick read-only (counts + logs,
 *     mutates nothing) so an operator can observe one cycle in prod before
 *     committing. Recommended first step when enabling.
 *   - the sweep only ever touches posts that never reached the publish queue and
 *     never went live (see draft-expiry-sweep.ts), and is idempotent.
 */
import 'dotenv/config';

import pg from 'pg';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  runDraftExpirySweep,
  draftExpiryEnabled,
  draftExpiryDryRun,
  resolveDraftExpiryIntervalMs,
  resolveDraftExpiryAgeDays,
  type DraftExpirySweepReport,
} from '@/backend/marketing/draft-expiry-sweep';
import { parsePoolMax, WORKER_POOL_MAX } from '@/lib/db-pool-config';

// ---------------------------------------------------------------------------
// DB
// ---------------------------------------------------------------------------

export function buildPool(): pg.Pool {
  return new pg.Pool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'aries_user',
    password: process.env.DB_PASSWORD || 'aries_pass',
    database: process.env.DB_NAME || 'aries_dev',
    max: parsePoolMax(process.env.DB_POOL_MAX, WORKER_POOL_MAX),
  });
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function summarize(report: DraftExpirySweepReport): Record<string, unknown> {
  return {
    dry_run: report.dryRun,
    age_days: report.ageDays,
    cutoff: report.cutoff,
    candidates: report.candidates,
    expired: report.expired,
    batches: report.batches,
    truncated: report.truncated,
    // Top tenants only, so a wide fan-out doesn't flood the log line.
    top_tenants: report.byTenant.slice(0, 10),
  };
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

let running = false;
let intervalHandle: NodeJS.Timeout | null = null;

async function tickSafe(pool: pg.Pool): Promise<void> {
  if (running) {
    console.warn('[draft-expiry-sweep-worker] previous tick still running; skipping');
    return;
  }
  running = true;
  try {
    const dryRun = draftExpiryDryRun();
    const ageDays = resolveDraftExpiryAgeDays();
    const report = await runDraftExpirySweep(pool, { dryRun, ageDays });
    if (report.candidates > 0 || report.expired > 0 || report.truncated) {
      console.log(`[draft-expiry-sweep-worker] summary ${JSON.stringify(summarize(report))}`);
    }
    if (report.truncated) {
      // Loud: a backlog larger than one tick can drain. Not an error (it
      // resumes next tick), but worth surfacing so an operator can investigate
      // why so many posts stranded.
      console.warn(
        '[draft-expiry-sweep-worker] sweep truncated at maxBatches; backlog remains, resuming next tick',
        { candidates: report.candidates, expired: report.expired },
      );
    }
  } catch (error) {
    console.error('[draft-expiry-sweep-worker] tick error', error);
  } finally {
    running = false;
  }
}

async function main(): Promise<void> {
  if (!draftExpiryEnabled()) {
    // IDLE, do not exit. This runs as a docker-compose service with
    // `restart: unless-stopped`; a clean exit(0) makes Docker restart-loop the
    // container. Staying alive doing nothing leaves it cleanly "up" when the
    // flag is off, while still responding to `docker stop`. Set the flag and
    // restart the service to enable. (Same pattern as the weekly-trigger
    // worker — see its main() for the full rationale.)
    console.log(
      '[draft-expiry-sweep-worker] ARIES_DRAFT_EXPIRY_ENABLED is off; idling (no work). Set the flag and restart to enable.',
    );
    if (process.env.ARIES_DRAFT_EXPIRY_RUN_ONCE?.trim() === '1') {
      process.exit(0); // one-shot / smoke invocations must not hang
    }
    const idle = setInterval(() => {}, 1 << 30); // ~12 days; just keeps the event loop alive
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        clearInterval(idle);
        process.exit(0);
      });
    }
    return;
  }

  const intervalMs = resolveDraftExpiryIntervalMs();
  const ageDays = resolveDraftExpiryAgeDays();
  const dryRun = draftExpiryDryRun();
  const pool = buildPool();
  console.log(
    `[draft-expiry-sweep-worker] starting; interval=${intervalMs}ms age_days=${ageDays} dry_run=${dryRun}`,
  );

  await tickSafe(pool);

  if (process.env.ARIES_DRAFT_EXPIRY_RUN_ONCE?.trim() === '1') {
    await pool.end();
    process.exit(0);
  }

  intervalHandle = setInterval(() => void tickSafe(pool), intervalMs);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, async () => {
      if (intervalHandle) clearInterval(intervalHandle);
      await pool.end().catch(() => {});
      process.exit(0);
    });
  }
}

// Only auto-start when run directly; importing this module (e.g. from a unit
// test for buildPool) must not spin up the worker loop.
const isDirectRun =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  void main();
}
