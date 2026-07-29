/**
 * AA-161 — retention half of the usage time-series layer.
 *
 * Policy (AC 3):
 *   task_execution_log   raw events  -> ARIES_USAGE_RAW_RETENTION_DAYS    (default 90)
 *   usage_rollup_hourly  hourly      -> ARIES_USAGE_HOURLY_RETENTION_DAYS (default 400)
 *   usage_rollup_daily   daily       -> kept indefinitely (never swept)
 *   usage_rollup_monthly monthly     -> kept indefinitely (never swept)
 *
 * The load-bearing safety contract is the WATERMARK INTERLOCK: nothing is ever
 * deleted at or above (rolled_through - reroll overlap). Consequences:
 *   - a raw row that has not been aggregated yet can never be purged, so usage
 *     history cannot be lost between two ticks;
 *   - a bucket the rollup may still re-roll can never lose its source rows, so a
 *     re-roll can never overwrite a correct aggregate with a zeroed one.
 * With no watermark row at all (the rollup has never run) the sweep deletes
 * NOTHING and reports why. Deleting usage history that was never aggregated is
 * the one unrecoverable mistake available here, so it fails closed.
 *
 * Gated by ARIES_USAGE_RETENTION_ENABLED (default OFF) and separately by
 * ARIES_USAGE_RETENTION_DRY_RUN, which makes a pass strictly read-only — the same
 * observe-then-commit path the draft-expiry sweep ships with.
 *
 * Deliberately NOT wrapped in withTaskExecutionLog: a purge that meters itself
 * writes a new row into the table it is purging on every tick.
 */

import {
  DEFAULT_USAGE_HOURLY_RETENTION_DAYS,
  DEFAULT_USAGE_RAW_RETENTION_DAYS,
  DEFAULT_USAGE_RETENTION_BATCH_SIZE,
  DEFAULT_USAGE_RETENTION_MAX_BATCHES,
  DEFAULT_USAGE_ROLLUP_REROLL_HOURS,
} from './usage-rollup-env';
import { ROLLUP_STATE_ID, SELECT_WATERMARK_SQL, type Queryable } from './usage-rollups';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

export const COUNT_EXPIRED_RAW_SQL = `SELECT count(*)::bigint AS n
     FROM task_execution_log
    WHERE started_at < $1`;

export const COUNT_EXPIRED_HOURLY_SQL = `SELECT count(*)::bigint AS n
     FROM usage_rollup_hourly
    WHERE bucket_start < $1`;

/**
 * $1 = cutoff, $2 = batch size. Batched so a first purge of a large backlog never
 * takes one long lock on the append-only log the live writers are inserting into.
 * Oldest-first, served by idx_task_execution_log_started_at.
 */
export const DELETE_EXPIRED_RAW_SQL = `DELETE FROM task_execution_log
      WHERE id IN (
        SELECT id FROM task_execution_log
         WHERE started_at < $1
         ORDER BY started_at
         LIMIT $2
      )`;

/** Same batching; the hourly table has no surrogate key, so it deletes by ctid. */
export const DELETE_EXPIRED_HOURLY_SQL = `DELETE FROM usage_rollup_hourly
      WHERE ctid IN (
        SELECT ctid FROM usage_rollup_hourly
         WHERE bucket_start < $1
         LIMIT $2
      )`;

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

export type UsageRetentionOptions = {
  dryRun: boolean;
  rawRetentionDays?: number;
  hourlyRetentionDays?: number;
  rerollHours?: number;
  batchSize?: number;
  maxBatches?: number;
  now?: () => Date;
};

export type UsageRetentionReport = {
  dryRun: boolean;
  /** Effective cutoffs after the watermark interlock, ISO; null when nothing ran. */
  rawCutoff: string | null;
  hourlyCutoff: string | null;
  rawCandidates: number;
  rawDeleted: number;
  hourlyCandidates: number;
  hourlyDeleted: number;
  batches: number;
  /** True when the delete loop hit maxBatches with work remaining. */
  truncated: boolean;
  /** Set when the sweep declined to run; null when it ran. */
  skippedReason: 'no_rollup_watermark' | null;
};

function asNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function rowsAffected(result: { rowCount?: number | null; rows?: unknown[] }): number {
  if (typeof result.rowCount === 'number') return result.rowCount;
  return Array.isArray(result.rows) ? result.rows.length : 0;
}

/**
 * Delete in bounded batches until the predicate is exhausted or the backstop
 * trips. Returns the rows removed and whether work remains.
 */
async function deleteInBatches(
  db: Queryable,
  sql: string,
  cutoffIso: string,
  batchSize: number,
  maxBatches: number,
): Promise<{ deleted: number; batches: number; truncated: boolean }> {
  let deleted = 0;
  let batches = 0;
  while (batches < maxBatches) {
    const res = await db.query(sql, [cutoffIso, batchSize]);
    const n = rowsAffected(res);
    batches += 1;
    deleted += n;
    if (n < batchSize) {
      return { deleted, batches, truncated: false };
    }
  }
  return { deleted, batches, truncated: true };
}

/**
 * One retention pass. Dependency-injected (db, now) so a test can drive it
 * against a real client-in-a-transaction or a fake pool.
 *
 * dryRun=true issues ONLY the count queries — zero deletes — so it is safe to run
 * against the production database for inspection.
 */
export async function runUsageRetentionSweep(
  db: Queryable,
  opts: UsageRetentionOptions,
): Promise<UsageRetentionReport> {
  const now = opts.now ?? (() => new Date());
  const rawDays =
    opts.rawRetentionDays && opts.rawRetentionDays > 0
      ? opts.rawRetentionDays
      : DEFAULT_USAGE_RAW_RETENTION_DAYS;
  const hourlyDays =
    opts.hourlyRetentionDays && opts.hourlyRetentionDays > 0
      ? opts.hourlyRetentionDays
      : DEFAULT_USAGE_HOURLY_RETENTION_DAYS;
  const rerollHours =
    opts.rerollHours !== undefined && opts.rerollHours >= 0
      ? opts.rerollHours
      : DEFAULT_USAGE_ROLLUP_REROLL_HOURS;
  const batchSize =
    opts.batchSize && opts.batchSize > 0 ? opts.batchSize : DEFAULT_USAGE_RETENTION_BATCH_SIZE;
  const maxBatches =
    opts.maxBatches && opts.maxBatches > 0 ? opts.maxBatches : DEFAULT_USAGE_RETENTION_MAX_BATCHES;

  const report: UsageRetentionReport = {
    dryRun: opts.dryRun,
    rawCutoff: null,
    hourlyCutoff: null,
    rawCandidates: 0,
    rawDeleted: 0,
    hourlyCandidates: 0,
    hourlyDeleted: 0,
    batches: 0,
    truncated: false,
    skippedReason: null,
  };

  const stateRes = await db.query(SELECT_WATERMARK_SQL, [ROLLUP_STATE_ID]);
  const watermark = asDate(
    (stateRes.rows[0] as { rolled_through?: unknown } | undefined)?.rolled_through,
  );
  if (!watermark) {
    // Fail closed: with no proof that anything has been aggregated, deleting raw
    // usage history would destroy it outright.
    report.skippedReason = 'no_rollup_watermark';
    return report;
  }

  // The interlock: never delete at or above the point the rollup may still
  // re-read. Everything below it is aggregated AND final.
  const safeUpperBound = watermark.getTime() - rerollHours * HOUR_MS;
  const rawCutoffMs = Math.min(now().getTime() - rawDays * DAY_MS, safeUpperBound);
  const hourlyCutoffMs = Math.min(now().getTime() - hourlyDays * DAY_MS, safeUpperBound);

  const rawCutoff = new Date(rawCutoffMs).toISOString();
  const hourlyCutoff = new Date(hourlyCutoffMs).toISOString();
  report.rawCutoff = rawCutoff;
  report.hourlyCutoff = hourlyCutoff;

  const rawCountRes = await db.query(COUNT_EXPIRED_RAW_SQL, [rawCutoff]);
  report.rawCandidates = asNumber((rawCountRes.rows[0] as { n?: unknown } | undefined)?.n);

  const hourlyCountRes = await db.query(COUNT_EXPIRED_HOURLY_SQL, [hourlyCutoff]);
  report.hourlyCandidates = asNumber((hourlyCountRes.rows[0] as { n?: unknown } | undefined)?.n);

  if (opts.dryRun) {
    return report; // strictly read-only
  }

  const raw = await deleteInBatches(db, DELETE_EXPIRED_RAW_SQL, rawCutoff, batchSize, maxBatches);
  report.rawDeleted = raw.deleted;
  report.batches += raw.batches;
  report.truncated = raw.truncated;

  const hourly = await deleteInBatches(
    db,
    DELETE_EXPIRED_HOURLY_SQL,
    hourlyCutoff,
    batchSize,
    maxBatches,
  );
  report.hourlyDeleted = hourly.deleted;
  report.batches += hourly.batches;
  report.truncated = report.truncated || hourly.truncated;

  return report;
}
