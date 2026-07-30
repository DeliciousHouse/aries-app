/**
 * AA-166 — the one place the customer-facing usage reporting queries live.
 *
 * Feeds `/dashboard/usage`: consumption over time (daily / weekly / monthly),
 * top users, slowest tasks, and the AI vs. local-automation split — all scoped
 * to ONE company.
 *
 * Metric choice, and why this is not "tokens" despite the ticket wording:
 *   every AI_LLM row carries NULL tokens because Hermes owns model routing and
 *   does not report usage back to Aries (AA-159/158). A tokens-only surface
 *   would draw a flat zero line and an all-zero "top spenders" table for every
 *   customer. So TASKS — the unit AA-163 enforces on and AA-164 displays, so
 *   what a customer is shown, alerted at, and cut off at cannot drift — is the
 *   primary measure, and every row carries its tokens beside it. `tokensReported`
 *   says whether any AI work in the window reported usage at all, so the UI can
 *   say "not reported yet" instead of rendering a confident 0. The moment Hermes
 *   emits the protocol 1.3.0 `usage` block, the token views fill in with no
 *   change here.
 *
 * Source: usage_rollup_daily for EVERY grain, including monthly. Reading one
 * table means the chart and the three tables cannot disagree with each other,
 * and daily is never touched by the retention sweep, so the history is complete
 * even after the raw rows are purged. Weekly is a read-time date_trunc — a
 * fourth rollup table would be a second thing to keep correct for no gain.
 *
 * Honesty contract, shared with AA-164's quota card: with no rollup watermark
 * the aggregates are empty because metering has never run, so this reports
 * `metered: false` with empty series rather than a confident zero.
 *
 * Tenant scoping: every query filters `tenant_id = $1` with a positive company
 * id, so the AA-161 `0` "not scoped" sentinel (system sweeps, cron, callbacks)
 * is excluded by construction and never lands in a customer-facing payload.
 */

import { pool } from '@/lib/db';

import { ROLLUP_STATE_ID, SELECT_WATERMARK_SQL } from './usage-rollups';

export type Queryable = {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: unknown[]; rowCount?: number | null }>;
};

export type UsageGranularity = 'daily' | 'weekly' | 'monthly';

export const USAGE_GRANULARITIES: readonly UsageGranularity[] = ['daily', 'weekly', 'monthly'];

export function isUsageGranularity(value: unknown): value is UsageGranularity {
  return typeof value === 'string' && (USAGE_GRANULARITIES as readonly string[]).includes(value);
}

/** How many buckets each grain shows, and the date_trunc unit it maps to. */
const GRANULARITY_BUCKETS: Record<UsageGranularity, number> = {
  daily: 30,
  weekly: 12,
  monthly: 12,
};

const GRANULARITY_TRUNC_UNIT: Record<UsageGranularity, 'day' | 'week' | 'month'> = {
  daily: 'day',
  weekly: 'week',
  monthly: 'month',
};

/** Rows returned per table. Small on purpose — this is a summary, not an export. */
export const DEFAULT_TABLE_LIMIT = 10;

export type UsageSeriesPoint = {
  /** UTC bucket start, YYYY-MM-DD. */
  bucketStart: string;
  tasks: number;
  aiTasks: number;
  /** How many of aiTasks actually reported usage — the anti-"$0 means free" denominator. */
  aiTasksWithUsage: number;
  /** null = not reported, never "free". */
  totalTokens: number | null;
  totalDurationMs: number | null;
};

export type UsageUserRow = {
  /** 0 is the AA-161 "not scoped" sentinel: userless cron/sidecar/callback work. */
  userId: number;
  isSystem: boolean;
  /** Display name, null when the id no longer resolves to a member of this company. */
  name: string | null;
  tasks: number;
  aiTasks: number;
  aiTasksWithUsage: number;
  totalTokens: number | null;
  totalDurationMs: number | null;
};

export type UsageTaskRow = {
  taskKey: string;
  executions: number;
  totalDurationMs: number;
  /** Mean wall-clock ms per execution. The rollups keep sums, so no p95 is available. */
  avgDurationMs: number;
};

export type UsageEngineRow = {
  engine: string;
  tasks: number;
  totalTokens: number | null;
  totalDurationMs: number | null;
};

export type UsageAnalytics = {
  /** False when the rollup has never run — the arrays are empty, not zeroed. */
  metered: boolean;
  granularity: UsageGranularity;
  /** Inclusive window start, YYYY-MM-DD (UTC). */
  rangeStart: string;
  /** Exclusive window end, YYYY-MM-DD (UTC). */
  rangeEnd: string;
  series: UsageSeriesPoint[];
  topUsers: UsageUserRow[];
  slowestTasks: UsageTaskRow[];
  engineSplit: UsageEngineRow[];
  totalTasks: number;
  totalAiTasks: number;
  totalAiTasksWithUsage: number;
  totalTokens: number | null;
  /** True only when some AI work in this window reported its usage. */
  tokensReported: boolean;
};

// ---------------------------------------------------------------------------
// SQL (exported so the unit test asserts the exact strings the route runs)
// ---------------------------------------------------------------------------

// $1 = company id, $2 = range start (inclusive), $3 = range end (exclusive),
// $4 = date_trunc unit.
export const SELECT_USAGE_SERIES_SQL = `SELECT
       to_char(date_trunc($4, bucket_start AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS bucket_start,
       sum(events)::bigint               AS tasks,
       sum(ai_events)::bigint            AS ai_tasks,
       sum(ai_events_with_usage)::bigint AS ai_tasks_with_usage,
       sum(total_tokens)::bigint         AS total_tokens,
       sum(duration_ms_sum)::bigint      AS total_duration_ms
     FROM usage_rollup_daily
    WHERE tenant_id = $1 AND bucket_start >= $2 AND bucket_start < $3
    GROUP BY 1
    ORDER BY 1`;

/**
 * $4 = row limit.
 *
 * Ordered by token spend with tasks as the tie-break, so this IS "top users by
 * token spend" the moment usage is reported, and degrades to "by task volume"
 * today when every token sum is NULL (NULLS LAST collapses them into one tie).
 *
 * The users join is guarded by company membership so a stale user_id can never
 * surface another workspace's name or email; an unresolvable id renders as the
 * id alone. Both membership shapes are accepted — the legacy single pointer and
 * an active organization_memberships row — because either one is a real member.
 */
export const SELECT_USAGE_TOP_USERS_SQL = `SELECT
       r.user_id                           AS user_id,
       u.full_name                         AS full_name,
       u.email                             AS email,
       sum(r.events)::bigint               AS tasks,
       sum(r.ai_events)::bigint            AS ai_tasks,
       sum(r.ai_events_with_usage)::bigint AS ai_tasks_with_usage,
       sum(r.total_tokens)::bigint         AS total_tokens,
       sum(r.duration_ms_sum)::bigint      AS total_duration_ms
     FROM usage_rollup_daily r
     LEFT JOIN users u
       ON u.id = r.user_id
      AND (u.organization_id = $1
           OR EXISTS (SELECT 1 FROM organization_memberships m
                       WHERE m.user_id = u.id
                         AND m.organization_id = $1
                         AND m.status = 'active'))
    WHERE r.tenant_id = $1 AND r.bucket_start >= $2 AND r.bucket_start < $3
    GROUP BY 1, 2, 3
    ORDER BY sum(r.total_tokens) DESC NULLS LAST, sum(r.events) DESC
    LIMIT $4`;

/**
 * $4 = row limit. Slowest by MEAN wall-clock per execution, not by total time —
 * otherwise the answer is always "whatever ran most often". Buckets with no
 * duration recorded are excluded rather than counted as instant.
 */
export const SELECT_USAGE_SLOWEST_TASKS_SQL = `SELECT
       task_key                       AS task_key,
       sum(events)::bigint            AS executions,
       sum(duration_ms_sum)::bigint   AS total_duration_ms
     FROM usage_rollup_daily
    WHERE tenant_id = $1 AND bucket_start >= $2 AND bucket_start < $3
    GROUP BY 1
   HAVING sum(duration_ms_sum) IS NOT NULL AND sum(events) > 0
    ORDER BY sum(duration_ms_sum)::numeric / sum(events) DESC
    LIMIT $4`;

export const SELECT_USAGE_ENGINE_SPLIT_SQL = `SELECT
       execution_engine             AS execution_engine,
       sum(events)::bigint          AS tasks,
       sum(total_tokens)::bigint    AS total_tokens,
       sum(duration_ms_sum)::bigint AS total_duration_ms
     FROM usage_rollup_daily
    WHERE tenant_id = $1 AND bucket_start >= $2 AND bucket_start < $3
    GROUP BY 1
    ORDER BY 2 DESC`;

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addUtcDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * The reporting window for a grain, as whole UTC buckets ending with the current
 * (still partial) one.
 *
 * Weeks are Monday-anchored to match Postgres `date_trunc('week', ...)`, so a
 * bucket the UI labels cannot straddle two of the server's.
 *
 * Exported pure so the bucket arithmetic — month lengths, week anchoring, the
 * current partial bucket — is testable without a database.
 */
export function resolveUsageWindow(
  granularity: UsageGranularity,
  now: Date = new Date(),
): { rangeStart: Date; rangeEnd: Date } {
  const buckets = GRANULARITY_BUCKETS[granularity];
  const today = startOfUtcDay(now);

  if (granularity === 'daily') {
    const rangeEnd = addUtcDays(today, 1);
    return { rangeStart: addUtcDays(rangeEnd, -buckets), rangeEnd };
  }

  if (granularity === 'weekly') {
    // getUTCDay(): 0=Sunday. Days elapsed since the Monday that opens this week.
    const sinceMonday = (today.getUTCDay() + 6) % 7;
    const rangeEnd = addUtcDays(today, 7 - sinceMonday);
    return { rangeStart: addUtcDays(rangeEnd, -buckets * 7), rangeEnd };
  }

  // Date.UTC normalizes an out-of-range month, so month arithmetic needs no
  // special casing at a year boundary.
  const rangeEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
  const rangeStart = new Date(
    Date.UTC(rangeEnd.getUTCFullYear(), rangeEnd.getUTCMonth() - buckets, 1),
  );
  return { rangeStart, rangeEnd };
}

function utcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Row coercion
// ---------------------------------------------------------------------------

/**
 * pg returns bigint/numeric aggregates as strings. NULL stays null — it means
 * "not reported", and turning it into 0 here is exactly the lie the whole
 * ai_events_with_usage denominator exists to prevent.
 */
function asNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** For counts, which are `count(*)`-derived and never legitimately NULL. */
function asCount(value: unknown): number {
  return asNumberOrNull(value) ?? 0;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function toSeriesPoint(row: Record<string, unknown>): UsageSeriesPoint {
  return {
    bucketStart: typeof row.bucket_start === 'string' ? row.bucket_start : '',
    tasks: asCount(row.tasks),
    aiTasks: asCount(row.ai_tasks),
    aiTasksWithUsage: asCount(row.ai_tasks_with_usage),
    totalTokens: asNumberOrNull(row.total_tokens),
    totalDurationMs: asNumberOrNull(row.total_duration_ms),
  };
}

function toUserRow(row: Record<string, unknown>): UsageUserRow {
  const userId = asCount(row.user_id);
  return {
    userId,
    isSystem: userId === 0,
    // full_name first, email as the fallback identity. Null when the join found
    // no member — the UI shows the id rather than inventing a name.
    name: asTrimmedString(row.full_name) ?? asTrimmedString(row.email),
    tasks: asCount(row.tasks),
    aiTasks: asCount(row.ai_tasks),
    aiTasksWithUsage: asCount(row.ai_tasks_with_usage),
    totalTokens: asNumberOrNull(row.total_tokens),
    totalDurationMs: asNumberOrNull(row.total_duration_ms),
  };
}

function toTaskRow(row: Record<string, unknown>): UsageTaskRow {
  const executions = asCount(row.executions);
  const totalDurationMs = asCount(row.total_duration_ms);
  return {
    taskKey: typeof row.task_key === 'string' ? row.task_key : '',
    executions,
    totalDurationMs,
    // The HAVING clause already excludes executions = 0; guard anyway so a
    // malformed row can never put Infinity/NaN on a customer's dashboard.
    avgDurationMs: executions > 0 ? Math.round(totalDurationMs / executions) : 0,
  };
}

function toEngineRow(row: Record<string, unknown>): UsageEngineRow {
  return {
    engine: typeof row.execution_engine === 'string' ? row.execution_engine : 'UNKNOWN',
    tasks: asCount(row.tasks),
    totalTokens: asNumberOrNull(row.total_tokens),
    totalDurationMs: asNumberOrNull(row.total_duration_ms),
  };
}

function sumOrNull(values: (number | null)[]): number | null {
  const reported = values.filter((value): value is number => value !== null);
  return reported.length ? reported.reduce((total, value) => total + value, 0) : null;
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

export type LoadUsageAnalyticsOptions = {
  granularity?: UsageGranularity;
  db?: Queryable;
  now?: () => Date;
  limit?: number;
};

/**
 * Build the reporting payload for one company.
 *
 * Throws on a DB error: the page shows an error state rather than a confidently
 * empty breakdown, matching loadQuotaSummary.
 */
export async function loadUsageAnalytics(
  companyId: number,
  options: LoadUsageAnalyticsOptions = {},
): Promise<UsageAnalytics> {
  const db = options.db ?? pool;
  const granularity = options.granularity ?? 'daily';
  const limit = options.limit ?? DEFAULT_TABLE_LIMIT;
  const { rangeStart, rangeEnd } = resolveUsageWindow(granularity, (options.now ?? (() => new Date()))());

  const empty: UsageAnalytics = {
    metered: false,
    granularity,
    rangeStart: utcDateString(rangeStart),
    rangeEnd: utcDateString(rangeEnd),
    series: [],
    topUsers: [],
    slowestTasks: [],
    engineSplit: [],
    totalTasks: 0,
    totalAiTasks: 0,
    totalAiTasksWithUsage: 0,
    totalTokens: null,
    tokensReported: false,
  };

  // The watermark is the "is usage being metered at all?" signal. With the
  // rollup worker off (its default) the aggregates are empty, and reporting that
  // as a zeroed dashboard would be a wrong number rather than a missing one.
  const watermarkRes = await db.query(SELECT_WATERMARK_SQL, [ROLLUP_STATE_ID]);
  const watermarkRow = watermarkRes.rows[0] as { rolled_through?: unknown } | undefined;
  if (!watermarkRow || watermarkRow.rolled_through === null || watermarkRow.rolled_through === undefined) {
    return empty;
  }

  // Strictly sequential, never Promise.all: four small reads on one pooled
  // client beat four connections contending for the pool (guardrail #1).
  const window = [companyId, rangeStart, rangeEnd];
  const seriesRes = await db.query(SELECT_USAGE_SERIES_SQL, [
    ...window,
    GRANULARITY_TRUNC_UNIT[granularity],
  ]);
  const usersRes = await db.query(SELECT_USAGE_TOP_USERS_SQL, [...window, limit]);
  const tasksRes = await db.query(SELECT_USAGE_SLOWEST_TASKS_SQL, [...window, limit]);
  const enginesRes = await db.query(SELECT_USAGE_ENGINE_SPLIT_SQL, window);

  const series = (seriesRes.rows as Record<string, unknown>[]).map(toSeriesPoint);
  const totalAiTasksWithUsage = series.reduce((total, point) => total + point.aiTasksWithUsage, 0);

  return {
    metered: true,
    granularity,
    rangeStart: utcDateString(rangeStart),
    rangeEnd: utcDateString(rangeEnd),
    series,
    topUsers: (usersRes.rows as Record<string, unknown>[]).map(toUserRow),
    slowestTasks: (tasksRes.rows as Record<string, unknown>[]).map(toTaskRow),
    engineSplit: (enginesRes.rows as Record<string, unknown>[]).map(toEngineRow),
    totalTasks: series.reduce((total, point) => total + point.tasks, 0),
    totalAiTasks: series.reduce((total, point) => total + point.aiTasks, 0),
    totalAiTasksWithUsage,
    totalTokens: sumOrNull(series.map((point) => point.totalTokens)),
    // Not "totalTokens > 0": a real reported spend of 0 is still reported. The
    // denominator is what distinguishes "nothing spent" from "nothing told us".
    tokensReported: totalAiTasksWithUsage > 0,
  };
}
