/**
 * AA-161 — usage time-series aggregation over `task_execution_log`.
 *
 * The raw usage event table is `task_execution_log` (AA-159 rows + AA-158
 * token/timing/attribution columns), aliased read-only as the view `usage_events`
 * (company_id -> tenant_id, created_at -> started_at). This module is the
 * aggregation half of the layer on top of it; usage-retention.ts is the purge.
 *
 * Why rollup TABLES and not MATERIALIZED VIEWs:
 *   1. An MV can only be refreshed WHOLE — a full rescan of a high-volume log on
 *      every refresh, and REFRESH CONCURRENTLY additionally needs a unique index.
 *      This module rolls only the buckets that changed.
 *   2. Decisive: an MV over raw rows is destroyed by the 90-day raw purge, while
 *      the AC requires daily aggregates kept indefinitely. Real tables outlive
 *      their source rows.
 *
 * Shape of a pass (all sequential — guardrail #1 forbids Promise.all fan-out
 * over a pooled connection):
 *   1. read the watermark (exclusive upper bound of the last rolled window);
 *   2. roll [from, to) into usage_rollup_hourly — a full recompute of each bucket
 *      UPSERTed, so re-running a window is idempotent, never additive;
 *   3. rebuild the WHOLE days / months those hours touch from the hourly table;
 *   4. advance the watermark, which never moves backwards.
 *
 * Every bucket is UTC. Per-tenant local-time reporting is a read-time concern
 * (the same choice the posting-time advisor makes), and a UTC bucket is the only
 * one that stays stable when the session TimeZone differs between the app
 * container, a worker, and a psql session.
 *
 * Deliberately NOT wrapped in withTaskExecutionLog: a metering pass that meters
 * itself appends a row to the very table it aggregates on every tick, forever —
 * self-referential noise in every cost report.
 */

import {
  DEFAULT_USAGE_ROLLUP_MAX_BACKFILL_DAYS,
  DEFAULT_USAGE_ROLLUP_MAX_HOURS_PER_PASS,
  DEFAULT_USAGE_ROLLUP_REROLL_HOURS,
} from './usage-rollup-env';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Watermark row id. One row; the rollup is a single logical stream. */
export const ROLLUP_STATE_ID = 'hourly';

/**
 * Sentinel written into the rollups' NOT NULL key columns for a raw row whose
 * tenant_id / user_id is NULL. A NULL inside a PRIMARY KEY would break UPSERT
 * idempotency (NULL <> NULL, so ON CONFLICT never matches and every pass would
 * insert a duplicate). Both id sequences start at 1, so 0 cannot collide with a
 * real organization or user. 0 reads as "not scoped": system sweeps have no
 * tenant, and cron/sidecar/reconciler/callback work is userless BY DESIGN.
 */
export const UNSCOPED_ID = 0;

export type Queryable = {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: unknown[]; rowCount?: number | null }>;
};

// ---------------------------------------------------------------------------
// SQL (exported so the unit test asserts their shape and the requires-infra test
// runs the exact strings the worker runs)
// ---------------------------------------------------------------------------

export const SELECT_WATERMARK_SQL = `SELECT rolled_through
     FROM usage_rollup_state
    WHERE id = $1`;

export const SELECT_OLDEST_EVENT_SQL = `SELECT min(started_at) AS oldest
     FROM task_execution_log`;

/**
 * Advance the watermark. The WHERE guard makes it monotonic: a stale or
 * concurrent pass can never rewind it and cause already-purged rows to be
 * "re-rolled" into zeroed aggregates.
 */
export const UPSERT_WATERMARK_SQL = `INSERT INTO usage_rollup_state (id, rolled_through, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (id) DO UPDATE
        SET rolled_through = EXCLUDED.rolled_through,
            updated_at     = now()
      WHERE usage_rollup_state.rolled_through < EXCLUDED.rolled_through`;

/**
 * The measure list, shared verbatim by all three grains so hourly, daily and
 * monthly can never drift apart in what they count.
 *
 * Token/cost columns are SUMmed and stay NULLable — SUM skips NULLs, and NULL
 * means "not reported" (Hermes does not report usage back to Aries yet), never
 * "free". That is exactly why `ai_events_with_usage` exists next to `ai_events`:
 * it is the denominator that stops a $0 bucket from being read as "no spend"
 * when the truth is "nothing reported its spend".
 */
const HOURLY_MEASURES = `
       count(*),
       count(*) FILTER (WHERE status = 'succeeded'),
       count(*) FILTER (WHERE status = 'failed'),
       count(*) FILTER (WHERE status = 'retry'),
       count(*) FILTER (WHERE execution_engine = 'AI_LLM'),
       count(*) FILTER (WHERE execution_engine = 'AI_LLM' AND total_tokens IS NOT NULL),
       sum(prompt_tokens),
       sum(completion_tokens),
       sum(total_tokens),
       sum(cost_cents),
       sum(duration_ms),
       sum(cpu_ms),
       min(started_at),
       max(started_at),
       now()`;

const ROLLUP_COLUMNS = `bucket_start, tenant_id, user_id, execution_engine, task_key,
     events, succeeded, failed, retries, ai_events, ai_events_with_usage,
     prompt_tokens, completion_tokens, total_tokens, cost_cents,
     duration_ms_sum, cpu_ms_sum, first_event_at, last_event_at, updated_at`;

/**
 * DO UPDATE SET = EXCLUDED (never `+=`). Each pass recomputes a bucket from
 * scratch, so re-rolling an overlapping window converges instead of double
 * counting — the reconciler-re-delivery over-count trap this repo has been bitten
 * by before.
 */
const ROLLUP_UPSERT_TAIL = `ON CONFLICT (bucket_start, tenant_id, user_id, execution_engine, task_key) DO UPDATE
        SET events               = EXCLUDED.events,
            succeeded            = EXCLUDED.succeeded,
            failed               = EXCLUDED.failed,
            retries              = EXCLUDED.retries,
            ai_events            = EXCLUDED.ai_events,
            ai_events_with_usage = EXCLUDED.ai_events_with_usage,
            prompt_tokens        = EXCLUDED.prompt_tokens,
            completion_tokens    = EXCLUDED.completion_tokens,
            total_tokens         = EXCLUDED.total_tokens,
            cost_cents           = EXCLUDED.cost_cents,
            duration_ms_sum      = EXCLUDED.duration_ms_sum,
            cpu_ms_sum           = EXCLUDED.cpu_ms_sum,
            first_event_at       = EXCLUDED.first_event_at,
            last_event_at        = EXCLUDED.last_event_at,
            updated_at           = now()`;

// $1 = window start (inclusive), $2 = window end (exclusive).
export const ROLLUP_HOURLY_SQL = `INSERT INTO usage_rollup_hourly (${ROLLUP_COLUMNS})
     SELECT date_trunc('hour', started_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
            COALESCE(tenant_id, ${UNSCOPED_ID}),
            COALESCE(user_id, ${UNSCOPED_ID}),
            execution_engine,
            task_key,${HOURLY_MEASURES}
       FROM task_execution_log
      WHERE started_at >= $1 AND started_at < $2
      GROUP BY 1, 2, 3, 4, 5
     ${ROLLUP_UPSERT_TAIL}`;

/**
 * Derived grains re-aggregate the HOURLY table, not the raw log — so they keep
 * working (and keep being correct) after the raw rows are purged.
 *
 * The window is widened to WHOLE periods: a pass that rolled 14:00-15:00 must
 * rebuild that entire day, or the day row would be overwritten with one hour's
 * worth of totals. The current day/month is therefore partial until its last hour
 * lands, and is corrected by the next pass that touches it.
 */
function derivedRollupSql(table: string, unit: 'day' | 'month'): string {
  return `INSERT INTO ${table} (${ROLLUP_COLUMNS})
     SELECT date_trunc('${unit}', bucket_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
            tenant_id,
            user_id,
            execution_engine,
            task_key,
            sum(events),
            sum(succeeded),
            sum(failed),
            sum(retries),
            sum(ai_events),
            sum(ai_events_with_usage),
            sum(prompt_tokens),
            sum(completion_tokens),
            sum(total_tokens),
            sum(cost_cents),
            sum(duration_ms_sum),
            sum(cpu_ms_sum),
            min(first_event_at),
            max(last_event_at),
            now()
       FROM usage_rollup_hourly
      WHERE bucket_start >= date_trunc('${unit}', $1::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        AND bucket_start <  (date_trunc('${unit}', ($2::timestamptz - interval '1 microsecond') AT TIME ZONE 'UTC') + interval '1 ${unit}') AT TIME ZONE 'UTC'
      GROUP BY 1, 2, 3, 4, 5
     ${ROLLUP_UPSERT_TAIL}`;
}

export const ROLLUP_DAILY_SQL = derivedRollupSql('usage_rollup_daily', 'day');
export const ROLLUP_MONTHLY_SQL = derivedRollupSql('usage_rollup_monthly', 'month');

// ---------------------------------------------------------------------------
// Pass
// ---------------------------------------------------------------------------

export type UsageRollupOptions = {
  maxHoursPerPass?: number;
  maxBackfillDays?: number;
  rerollHours?: number;
  now?: () => Date;
};

export type UsageRollupReport = {
  /** Window start (inclusive), ISO; null when nothing was rolled. */
  from: string | null;
  /** Window end (exclusive), ISO; null when nothing was rolled. */
  to: string | null;
  /** True when the pass found no closed hour to roll and wrote no rollup rows. */
  skipped: boolean;
  hourlyRows: number;
  dailyRows: number;
  monthlyRows: number;
  /** Watermark after the pass, ISO; null when it was not advanced. */
  rolledThrough: string | null;
  /** True when the window was clamped by maxHoursPerPass (more remains; next tick continues). */
  truncated: boolean;
  /**
   * True when the pass wanted to start EARLIER than maxBackfillDays allows, so
   * events older than that bound will never be aggregated. Harmless at the
   * default (the bound equals the raw retention window, so the skipped rows were
   * due for deletion anyway) but a real gap if the retention window has been
   * widened without widening this one — hence loud rather than silent.
   */
  backfillClamped: boolean;
};

function floorToHour(date: Date): Date {
  return new Date(Math.floor(date.getTime() / HOUR_MS) * HOUR_MS);
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
 * One aggregation pass. Dependency-injected (db, now) so a test can drive it
 * against a real client-in-a-transaction or a fake pool.
 *
 * Only CLOSED hours are rolled: the upper bound is the current hour boundary, so
 * the in-progress hour is never aggregated half-finished and then left stale.
 */
export async function runUsageRollup(
  db: Queryable,
  opts: UsageRollupOptions = {},
): Promise<UsageRollupReport> {
  const now = opts.now ?? (() => new Date());
  const maxHours =
    opts.maxHoursPerPass && opts.maxHoursPerPass > 0
      ? opts.maxHoursPerPass
      : DEFAULT_USAGE_ROLLUP_MAX_HOURS_PER_PASS;
  const maxBackfillDays =
    opts.maxBackfillDays && opts.maxBackfillDays > 0
      ? opts.maxBackfillDays
      : DEFAULT_USAGE_ROLLUP_MAX_BACKFILL_DAYS;
  const rerollHours =
    opts.rerollHours !== undefined && opts.rerollHours >= 0
      ? opts.rerollHours
      : DEFAULT_USAGE_ROLLUP_REROLL_HOURS;

  const report: UsageRollupReport = {
    from: null,
    to: null,
    skipped: true,
    hourlyRows: 0,
    dailyRows: 0,
    monthlyRows: 0,
    rolledThrough: null,
    truncated: false,
    backfillClamped: false,
  };

  // Exclusive upper bound: the boundary of the hour currently in progress.
  const boundary = floorToHour(now());
  // Nothing older than this may ever start a pass — see maxBackfillDays.
  const earliest = new Date(boundary.getTime() - maxBackfillDays * DAY_MS);

  const stateRes = await db.query(SELECT_WATERMARK_SQL, [ROLLUP_STATE_ID]);
  const watermark = asDate((stateRes.rows[0] as { rolled_through?: unknown } | undefined)?.rolled_through);

  let desiredFrom: Date;
  if (watermark) {
    // Re-roll the trailing buckets so a raw row that landed just after its bucket
    // closed is still counted. Safe because each bucket is a full recompute.
    desiredFrom = new Date(watermark.getTime() - rerollHours * HOUR_MS);
  } else {
    // First ever pass: start at the oldest event, bounded by the backfill window.
    const oldestRes = await db.query(SELECT_OLDEST_EVENT_SQL);
    const oldest = asDate((oldestRes.rows[0] as { oldest?: unknown } | undefined)?.oldest);
    if (!oldest) {
      // Empty log. Stamp the watermark so the next pass starts here instead of
      // re-scanning for a minimum that does not exist.
      await db.query(UPSERT_WATERMARK_SQL, [ROLLUP_STATE_ID, boundary.toISOString()]);
      report.rolledThrough = boundary.toISOString();
      return report;
    }
    desiredFrom = oldest;
  }

  // Loud, not silent: a worker that was down longer than the backfill window
  // would otherwise skip that stretch of events with no trace.
  report.backfillClamped = desiredFrom.getTime() < earliest.getTime();
  const from = floorToHour(new Date(Math.max(desiredFrom.getTime(), earliest.getTime())));

  if (from.getTime() >= boundary.getTime()) {
    return report; // no closed hour to roll yet
  }

  let to = boundary;
  if (to.getTime() - from.getTime() > maxHours * HOUR_MS) {
    to = new Date(from.getTime() + maxHours * HOUR_MS);
    report.truncated = true; // caught-up over the next ticks
  }

  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  report.from = fromIso;
  report.to = toIso;
  report.skipped = false;

  // Sequential by design: three aggregate writes over the same pool client are
  // cheaper in series than contending for connections (guardrail #1).
  report.hourlyRows = rowsAffected(await db.query(ROLLUP_HOURLY_SQL, [fromIso, toIso]));
  report.dailyRows = rowsAffected(await db.query(ROLLUP_DAILY_SQL, [fromIso, toIso]));
  report.monthlyRows = rowsAffected(await db.query(ROLLUP_MONTHLY_SQL, [fromIso, toIso]));

  // Advanced only after every grain has landed: a crash mid-pass leaves the
  // watermark where it was, so the next pass redoes the window (idempotently)
  // rather than skipping it.
  await db.query(UPSERT_WATERMARK_SQL, [ROLLUP_STATE_ID, toIso]);
  report.rolledThrough = toIso;

  return report;
}
