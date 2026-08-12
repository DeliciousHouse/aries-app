/**
 * AA-161 usage rollup + retention worker — the standing process that keeps the
 * usage time-series aggregates fresh and applies the retention policy.
 *
 * Postgres has no built-in scheduler in this stack (no pg_cron, no Timescale), so
 * "materialized views refreshed on a cadence" is a sidecar in this repo: a
 * single-replica docker-compose service, self-scheduling on an interval, talking
 * only to its own small Postgres pool. Same shape as the draft-expiry and
 * hermes-gc workers. The logic lives in backend/telemetry/usage-rollups.ts and
 * backend/telemetry/usage-retention.ts — this file is just the loop.
 *
 * Two independent gates:
 *   ARIES_USAGE_ROLLUP_ENABLED    (default OFF) — the whole worker idles without it.
 *   ARIES_USAGE_RETENTION_ENABLED (default OFF) — aggregation runs, nothing is
 *     ever deleted. Aggregate for as long as you like before enabling the only
 *     destructive half, and run it with ARIES_USAGE_RETENTION_DRY_RUN=1 first.
 *
 * Ordering within a tick is load-bearing: roll up FIRST, purge second. The purge
 * refuses to delete anything at or above the rollup watermark, so a raw row can
 * never be destroyed before it has been aggregated.
 */
import 'dotenv/config';

import pg from 'pg';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  resolveUsageHourlyRetentionDays,
  resolveUsageRawRetentionDays,
  resolveUsageRollupIntervalMs,
  resolveUsageRollupMaxBackfillDays,
  resolveUsageRollupMaxHoursPerPass,
  usageRetentionDryRun,
  usageRetentionEnabled,
  usageRollupEnabled,
} from '@/backend/telemetry/usage-rollup-env';
import { runQuotaThresholdAlerts } from '@/backend/billing/quota-alerts';
import {
  connectionNudgesEnabled,
  runConnectionHealthNudges,
} from '@/backend/tenant/connection-health-nudges';
import {
  runUsageRetentionSweep,
  type UsageRetentionReport,
} from '@/backend/telemetry/usage-retention';
import { runUsageRollup, type UsageRollupReport } from '@/backend/telemetry/usage-rollups';
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

function summarizeRollup(report: UsageRollupReport): Record<string, unknown> {
  return {
    from: report.from,
    to: report.to,
    hourly_rows: report.hourlyRows,
    daily_rows: report.dailyRows,
    monthly_rows: report.monthlyRows,
    rolled_through: report.rolledThrough,
    truncated: report.truncated,
    daily_company_usage_refreshed: report.dailyCompanyUsageRefreshed,
  };
}

function summarizeRetention(report: UsageRetentionReport): Record<string, unknown> {
  return {
    dry_run: report.dryRun,
    raw_cutoff: report.rawCutoff,
    hourly_cutoff: report.hourlyCutoff,
    raw_candidates: report.rawCandidates,
    raw_deleted: report.rawDeleted,
    hourly_candidates: report.hourlyCandidates,
    hourly_deleted: report.hourlyDeleted,
    batches: report.batches,
    truncated: report.truncated,
    skipped_reason: report.skippedReason,
  };
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

let running = false;
let intervalHandle: NodeJS.Timeout | null = null;

async function runConnectionHealthNudgeTick(pool: pg.Pool): Promise<void> {
  try {
    const nudges = await runConnectionHealthNudges(pool);
    if (nudges.emailsSent > 0 || nudges.errors > 0) {
      console.log(`[usage-rollup-worker] connection nudges ${JSON.stringify(nudges)}`);
    }
  } catch (error) {
    console.error('[usage-rollup-worker] connection nudge error', error);
  }
}

/**
 * Overlap-guarded tick. The guard is released in `finally`, so a failed tick
 * (e.g. Postgres not up yet) retries next interval instead of wedging the worker
 * — the 2026-06-09 insights-sync wedge.
 */
export async function tickSafe(pool: pg.Pool): Promise<void> {
  if (running) {
    console.warn('[usage-rollup-worker] previous tick still running; skipping');
    return;
  }
  running = true;
  try {
    if (!usageRollupEnabled()) {
      await runConnectionHealthNudgeTick(pool);
      return;
    }

    const rollup = await runUsageRollup(pool, {
      maxHoursPerPass: resolveUsageRollupMaxHoursPerPass(),
      maxBackfillDays: resolveUsageRollupMaxBackfillDays(),
    });
    if (!rollup.skipped) {
      console.log(`[usage-rollup-worker] rollup ${JSON.stringify(summarizeRollup(rollup))}`);
    }
    if (rollup.backfillClamped) {
      // Events older than ARIES_USAGE_ROLLUP_MAX_BACKFILL_DAYS are never
      // aggregated. Harmless at the defaults (that bound equals the raw
      // retention window), a real gap once retention has been widened past it.
      console.warn(
        '[usage-rollup-worker] window clamped by the backfill bound; older events will not be aggregated',
        { from: rollup.from, max_backfill_days: resolveUsageRollupMaxBackfillDays() },
      );
    }
    if (rollup.truncated) {
      // Not an error — a catch-up window larger than one pass. Loud so an
      // operator can tell "still backfilling" from "steady state".
      console.warn('[usage-rollup-worker] rollup window clamped; continuing next tick', {
        from: rollup.from,
        to: rollup.to,
      });
    }

    // AA-164: quota-threshold alerts ride this tick — it already recomputes the
    // numbers an alert needs, so a separate schedule would add operations
    // surface for no extra freshness. Isolated: an email outage must not stop
    // aggregation or retention.
    try {
      const alerts = await runQuotaThresholdAlerts(pool);
      if (alerts.alertsSent > 0 || alerts.errors > 0) {
        console.log(`[usage-rollup-worker] quota alerts ${JSON.stringify(alerts)}`);
      }
    } catch (error) {
      console.error('[usage-rollup-worker] quota alert error', error);
    }

    await runConnectionHealthNudgeTick(pool);

    if (!usageRetentionEnabled()) {
      return;
    }
    // Isolated from the rollup: a retention failure must not stop aggregation
    // from advancing on the next tick (and vice versa).
    try {
      const retention = await runUsageRetentionSweep(pool, {
        dryRun: usageRetentionDryRun(),
        rawRetentionDays: resolveUsageRawRetentionDays(),
        hourlyRetentionDays: resolveUsageHourlyRetentionDays(),
      });
      if (
        retention.skippedReason ||
        retention.rawCandidates > 0 ||
        retention.hourlyCandidates > 0
      ) {
        console.log(
          `[usage-rollup-worker] retention ${JSON.stringify(summarizeRetention(retention))}`,
        );
      }
    } catch (error) {
      console.error('[usage-rollup-worker] retention error', error);
    }
  } catch (error) {
    console.error('[usage-rollup-worker] tick error', error);
  } finally {
    running = false;
  }
}

async function main(): Promise<void> {
  if (!usageRollupEnabled() && !connectionNudgesEnabled()) {
    // IDLE, do not exit. This runs as a docker-compose service with
    // `restart: unless-stopped`; a clean exit(0) makes Docker restart-loop the
    // container. Staying alive doing nothing leaves it cleanly "up" when the
    // flag is off, while still responding to `docker stop`.
    console.log(
      '[usage-rollup-worker] usage rollups and connection nudges are off; idling (no work). Set a flag and restart to enable.',
    );
    if (process.env.ARIES_USAGE_ROLLUP_RUN_ONCE?.trim() === '1') {
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

  const intervalMs = resolveUsageRollupIntervalMs();
  const pool = buildPool();
  console.log(
    `[usage-rollup-worker] starting; interval=${intervalMs}ms rollup=${usageRollupEnabled()} connection_nudges=${connectionNudgesEnabled()} retention=${usageRetentionEnabled()} retention_dry_run=${usageRetentionDryRun()} raw_retention_days=${resolveUsageRawRetentionDays()}`,
  );

  await tickSafe(pool);

  if (process.env.ARIES_USAGE_ROLLUP_RUN_ONCE?.trim() === '1') {
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
// test for buildPool/tickSafe) must not spin up the worker loop.
const isDirectRun =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  void main();
}
