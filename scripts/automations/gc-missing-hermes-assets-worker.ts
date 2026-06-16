/**
 * Missing-Hermes-asset GC worker — standing process that marks `creative_assets`
 * rows orphaned once their Hermes image-cache file has been evicted, so the
 * dashboard stops emitting dead `/api/internal/hermes/media/<id>` URLs that 404
 * (the "Posts page preview images 404" symptom — qa-defect #599; the failing
 * assets are ~1 month old and the read-only cache mount evicted them while the
 * DB rows survived).
 *
 * The sweep logic (runGcMissingHermesAssets) already exists and is correct;
 * `queryProductionCreativeAssets` already filters `orphaned_at IS NULL`, so once
 * a row is marked it stops being surfaced → no URL emitted → no 404. This worker
 * is what actually *runs* the sweep on a cadence (previously nothing did).
 *
 * Gated by ARIES_HERMES_GC_ENABLED (default OFF). Mirrors the draft-expiry /
 * weekly-trigger / scheduled-posts workers: a single-replica docker-compose
 * service, self-scheduling on an interval, talking only to its own Postgres pool
 * plus the read-only Hermes image-cache mount (HERMES_IMAGE_CACHE_MOUNT) it needs
 * to tell "evicted" from "unreadable".
 *
 * Safety:
 *   - default OFF; ships dormant. When off the container idles cleanly (no
 *     restart loop), exactly like the draft-expiry worker.
 *   - ARIES_HERMES_GC_DRY_RUN=1 makes every tick read-only (lists candidates,
 *     mutates nothing) so an operator can observe one cycle in prod before
 *     committing. Recommended first step when enabling.
 *   - the sweep only ever touches `storage_kind='runtime_asset'` rows whose file
 *     is confirmed missing AND older than the grace window; operator uploads /
 *     composed stories ('ingested_asset', persisted under DATA_ROOT) are never
 *     touched. Idempotent (an orphaned row leaves the predicate). Without the
 *     mount it is a no-op (fail-safe).
 */
import 'dotenv/config';

import pg from 'pg';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  runGcMissingHermesAssets,
  gcEnabled,
  gcDryRun,
  resolveGcIntervalMs,
  resolveGcMaxAgeDays,
  type GcMissingStats,
} from '@/scripts/gc-missing-hermes-assets';
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

function summarize(stats: GcMissingStats): Record<string, unknown> {
  return {
    scanned: stats.scanned,
    rows_orphaned: stats.rowsOrphaned,
    file_still_present: stats.fileStillPresent,
    too_new: stats.tooNew,
    errors: stats.errors,
  };
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

let running = false;
let intervalHandle: NodeJS.Timeout | null = null;

async function tickSafe(pool: pg.Pool): Promise<void> {
  if (running) {
    console.warn('[hermes-gc-worker] previous tick still running; skipping');
    return;
  }
  running = true;
  try {
    const dryRun = gcDryRun();
    const maxAgeDays = resolveGcMaxAgeDays();
    const stats = await runGcMissingHermesAssets({ dryRun, db: pool, maxAgeDays });
    if (stats.candidates.length > 0 || stats.rowsOrphaned > 0 || stats.errors > 0) {
      console.log(`[hermes-gc-worker] summary ${JSON.stringify(summarize(stats))}`);
    }
  } catch (error) {
    console.error('[hermes-gc-worker] tick error', error);
  } finally {
    running = false;
  }
}

async function main(): Promise<void> {
  if (!gcEnabled()) {
    // IDLE, do not exit. This runs as a docker-compose service with
    // `restart: unless-stopped`; a clean exit(0) makes Docker restart-loop the
    // container. Staying alive doing nothing leaves it cleanly "up" when the
    // flag is off. Set the flag and restart the service to enable. (Same pattern
    // as the draft-expiry worker.)
    console.log(
      '[hermes-gc-worker] ARIES_HERMES_GC_ENABLED is off; idling (no work). Set the flag and restart to enable.',
    );
    if (process.env.ARIES_HERMES_GC_RUN_ONCE?.trim() === '1') {
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

  const intervalMs = resolveGcIntervalMs();
  const maxAgeDays = resolveGcMaxAgeDays();
  const dryRun = gcDryRun();
  const pool = buildPool();
  console.log(
    `[hermes-gc-worker] starting; interval=${intervalMs}ms max_age_days=${maxAgeDays} dry_run=${dryRun}`,
  );

  await tickSafe(pool);

  if (process.env.ARIES_HERMES_GC_RUN_ONCE?.trim() === '1') {
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
