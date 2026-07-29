/**
 * AA-161 — config for the usage time-series rollup + retention layer.
 *
 * Two independent gates, both default OFF, matching every other sweep in this
 * repo (draft-expiry, hermes-gc):
 *
 *   ARIES_USAGE_ROLLUP_ENABLED    — refresh the hourly/daily/monthly rollups.
 *   ARIES_USAGE_RETENTION_ENABLED — purge aggregated raw rows past their window.
 *
 * Separate on purpose: an operator must be able to run aggregation for weeks
 * before anything is ever deleted. Retention is the only destructive half, so it
 * also carries a dry-run, exactly like the draft-expiry sweep.
 *
 * 1/true/yes/on is enabled, matching the ARIES_DRAFT_EXPIRY_ENABLED /
 * ARIES_TASK_TELEMETRY_ENABLED convention.
 */

export const DEFAULT_USAGE_ROLLUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
/**
 * Hours rolled per pass. Bounds the FIRST pass (and any catch-up after downtime)
 * so it never scans the whole log at once — it converges over ticks instead, the
 * same reasoning as the Hermes reconciler's mtime window. 168h = 7 days.
 */
export const DEFAULT_USAGE_ROLLUP_MAX_HOURS_PER_PASS = 168;
/**
 * How far back the very first pass may start when there is no watermark row yet.
 * Matches the raw retention window: rolling up rows that are about to be purged
 * anyway is wasted work, and rolling up rows OLDER than the retention window
 * would produce aggregates for data that is already gone in spirit.
 */
export const DEFAULT_USAGE_ROLLUP_MAX_BACKFILL_DAYS = 90;
/**
 * Buckets at the top of the window are re-rolled on the next pass so a raw row
 * that landed a moment after its bucket closed is still counted. Cheap because
 * each bucket is a full recompute + UPSERT (idempotent), not an increment.
 */
export const DEFAULT_USAGE_ROLLUP_REROLL_HOURS = 1;

export const DEFAULT_USAGE_RAW_RETENTION_DAYS = 90;
/**
 * Hourly detail is the middle tier: too big to keep forever, too useful to drop
 * with the raw rows. Daily and monthly are never swept (AC: "daily aggregations
 * kept indefinitely").
 */
export const DEFAULT_USAGE_HOURLY_RETENTION_DAYS = 400;
export const DEFAULT_USAGE_RETENTION_BATCH_SIZE = 5000;
/** Backstop on the delete loop: 1000 x 5000 = 5M rows per tick, far past any real backlog. */
export const DEFAULT_USAGE_RETENTION_MAX_BATCHES = 1000;

type Env = Partial<Record<string, string | undefined>>;

function parseFlag(raw: string | undefined): boolean {
  const v = (raw ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function parsePositiveInt(value: string | undefined): number | null {
  const trimmed = value?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** True when ARIES_USAGE_ROLLUP_ENABLED is truthy. Default OFF. */
export function usageRollupEnabled(env: Env = process.env): boolean {
  return parseFlag(env.ARIES_USAGE_ROLLUP_ENABLED);
}

/** True when ARIES_USAGE_RETENTION_ENABLED is truthy. Default OFF. */
export function usageRetentionEnabled(env: Env = process.env): boolean {
  return parseFlag(env.ARIES_USAGE_RETENTION_ENABLED);
}

/**
 * When truthy the retention sweep runs read-only: it counts what it WOULD delete
 * and logs it, but deletes nothing. The safe first prod cycle before any usage
 * history is destroyed.
 */
export function usageRetentionDryRun(env: Env = process.env): boolean {
  return parseFlag(env.ARIES_USAGE_RETENTION_DRY_RUN);
}

export function resolveUsageRollupIntervalMs(env: Env = process.env): number {
  return parsePositiveInt(env.ARIES_USAGE_ROLLUP_INTERVAL_MS) ?? DEFAULT_USAGE_ROLLUP_INTERVAL_MS;
}

export function resolveUsageRollupMaxHoursPerPass(env: Env = process.env): number {
  return (
    parsePositiveInt(env.ARIES_USAGE_ROLLUP_MAX_HOURS_PER_PASS) ??
    DEFAULT_USAGE_ROLLUP_MAX_HOURS_PER_PASS
  );
}

export function resolveUsageRollupMaxBackfillDays(env: Env = process.env): number {
  return (
    parsePositiveInt(env.ARIES_USAGE_ROLLUP_MAX_BACKFILL_DAYS) ??
    DEFAULT_USAGE_ROLLUP_MAX_BACKFILL_DAYS
  );
}

export function resolveUsageRawRetentionDays(env: Env = process.env): number {
  return parsePositiveInt(env.ARIES_USAGE_RAW_RETENTION_DAYS) ?? DEFAULT_USAGE_RAW_RETENTION_DAYS;
}

export function resolveUsageHourlyRetentionDays(env: Env = process.env): number {
  return (
    parsePositiveInt(env.ARIES_USAGE_HOURLY_RETENTION_DAYS) ??
    DEFAULT_USAGE_HOURLY_RETENTION_DAYS
  );
}
