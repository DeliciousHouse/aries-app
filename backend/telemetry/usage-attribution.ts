/**
 * AA-165 — cross-company usage & cost attribution, for INTERNAL ops/finance.
 *
 * A deliberate SIBLING of backend/telemetry/usage-analytics.ts (AA-166), not a
 * parameterization of it. That module is tenant-scoped by construction: every
 * query takes a positive company id and filters on it. Adding an
 * "all companies" mode there would turn a structural safety property into a
 * runtime argument, one bad call away from leaking a customer's usage into a
 * customer-facing surface. Here company is an optional FILTER, and the access
 * check that guards it (lib/internal-ops-access.ts) is a different mechanism
 * entirely — staff allow-list, not tenant role.
 *
 * The AC's filter set — Company, Date Range, User, Task Type — is exactly the
 * grain `usage_rollup_daily` already keys on
 * (bucket_start, tenant_id, user_id, execution_engine, task_key), so no new
 * table, no new aggregate, and no migration are needed for the reporting half.
 *
 * `company_id = 0` (the AA-161 "not scoped" sentinel: system sweeps, cron, the
 * reconciler, Hermes callbacks) is KEPT and labelled here, unlike the
 * customer-facing view which excludes it. Platform efficiency is one of the
 * questions this dashboard answers, and unattributed work is a real part of the
 * answer — hiding it would make the totals stop reconciling with the raw log.
 */

import { pool } from '@/lib/db';

import { projectMargin } from '@/backend/billing/margin';
import {
  DEFAULT_PLAN_TIER,
  isPlanTier,
  parseRateCents,
  resolveBilledPriceCents,
} from '@/backend/billing/rate-cards';

import { resolveUsageWindow } from './usage-analytics';
import { ROLLUP_STATE_ID, SELECT_WATERMARK_SQL } from './usage-rollups';

export type Queryable = {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: unknown[]; rowCount?: number | null }>;
};

export const EXECUTION_ENGINES = ['AI_LLM', 'DETERMINISTIC_RULE', 'LOCAL_EDGE'] as const;
export type ExecutionEngine = (typeof EXECUTION_ENGINES)[number];

export function isExecutionEngine(value: unknown): value is ExecutionEngine {
  return typeof value === 'string' && (EXECUTION_ENGINES as readonly string[]).includes(value);
}

/** Row caps. Generous, and every response reports whether it hit them. */
export const DEFAULT_COMPANY_LIMIT = 200;
export const DEFAULT_BREAKDOWN_LIMIT = 25;

export type UsageAttributionFilters = {
  /** null = all companies. 0 is a valid value: the unscoped-system bucket. */
  companyId: number | null;
  userId: number | null;
  taskKey: string | null;
  engine: ExecutionEngine | null;
  /** Inclusive UTC day, YYYY-MM-DD. */
  from: string;
  /** Inclusive UTC day, YYYY-MM-DD. */
  to: string;
};

export type FilterParseResult =
  | { ok: true; filters: UsageAttributionFilters }
  | { ok: false; error: string };

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseDay(value: string): Date | null {
  if (!DAY_PATTERN.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  // Round-trip guard: '2026-02-31' parses to March 3 without this.
  return parsed.toISOString().slice(0, 10) === value ? parsed : null;
}

function parseIdParam(value: string | null, allowZero: boolean): number | null | 'invalid' {
  if (value === null || value.trim() === '') return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return 'invalid';
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed)) return 'invalid';
  if (parsed === 0 && !allowZero) return 'invalid';
  return parsed;
}

/**
 * Validate the AC's filter set from query params. Rejects rather than silently
 * ignoring an unparseable filter: a finance figure that quietly answered a
 * different question than the one on screen is the worst failure this surface
 * has.
 */
export function parseUsageAttributionFilters(
  params: URLSearchParams,
  now: Date = new Date(),
): FilterParseResult {
  const defaults = resolveUsageWindow('daily', now);
  const defaultFrom = defaults.rangeStart.toISOString().slice(0, 10);
  // rangeEnd is exclusive; the inclusive last day is the day before it.
  const defaultTo = new Date(defaults.rangeEnd.getTime() - 86_400_000).toISOString().slice(0, 10);

  const rawFrom = params.get('from');
  const rawTo = params.get('to');
  const from = rawFrom && rawFrom.trim() ? rawFrom.trim() : defaultFrom;
  const to = rawTo && rawTo.trim() ? rawTo.trim() : defaultTo;

  const fromDate = parseDay(from);
  const toDate = parseDay(to);
  if (!fromDate) return { ok: false, error: 'invalid_from' };
  if (!toDate) return { ok: false, error: 'invalid_to' };
  if (fromDate.getTime() > toDate.getTime()) return { ok: false, error: 'invalid_range' };

  // 0 is meaningful for company (the unscoped bucket) and for user (userless
  // cron/sidecar work), so both accept it — unlike a tenant-scoped surface.
  const companyId = parseIdParam(params.get('companyId'), true);
  if (companyId === 'invalid') return { ok: false, error: 'invalid_company' };
  const userId = parseIdParam(params.get('userId'), true);
  if (userId === 'invalid') return { ok: false, error: 'invalid_user' };

  const rawEngine = params.get('engine');
  const engine = rawEngine && rawEngine.trim() ? rawEngine.trim() : null;
  if (engine !== null && !isExecutionEngine(engine)) return { ok: false, error: 'invalid_engine' };

  const rawTaskKey = params.get('taskKey');
  const taskKey = rawTaskKey && rawTaskKey.trim() ? rawTaskKey.trim() : null;
  if (taskKey !== null && taskKey.length > 128) return { ok: false, error: 'invalid_task_key' };

  return { ok: true, filters: { companyId, userId, taskKey, engine, from, to } };
}

/**
 * The shared WHERE clause. Every value is a bound parameter — a task key is
 * operator-supplied text and is never interpolated into SQL.
 *
 * The date bounds are always present, so no query can accidentally scan the
 * whole table. `to` is an inclusive day, converted to an exclusive upper bound.
 */
export function buildUsageFilterClause(
  filters: UsageAttributionFilters,
  columnPrefix = '',
): { clause: string; params: unknown[] } {
  const col = (name: string) => `${columnPrefix}${name}`;
  const params: unknown[] = [];
  const conditions: string[] = [];

  params.push(new Date(`${filters.from}T00:00:00.000Z`));
  conditions.push(`${col('bucket_start')} >= $${params.length}`);
  params.push(new Date(new Date(`${filters.to}T00:00:00.000Z`).getTime() + 86_400_000));
  conditions.push(`${col('bucket_start')} < $${params.length}`);

  if (filters.companyId !== null) {
    params.push(filters.companyId);
    conditions.push(`${col('tenant_id')} = $${params.length}`);
  }
  if (filters.userId !== null) {
    params.push(filters.userId);
    conditions.push(`${col('user_id')} = $${params.length}`);
  }
  if (filters.engine !== null) {
    params.push(filters.engine);
    conditions.push(`${col('execution_engine')} = $${params.length}`);
  }
  if (filters.taskKey !== null) {
    params.push(filters.taskKey);
    conditions.push(`${col('task_key')} = $${params.length}`);
  }

  return { clause: conditions.join(' AND '), params };
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export type CompanyUsageRow = {
  companyId: number;
  /** null for the unscoped sentinel and for a deleted org. */
  companyName: string | null;
  isUnscoped: boolean;
  tier: string | null;
  tierLabel: string | null;
  tasks: number;
  aiTasks: number;
  aiTasksWithUsage: number;
  totalTokens: number | null;
  totalDurationMs: number | null;
  billedPriceCents: number | null;
  costCents: number | null;
  costBasis: 'measured' | 'modeled' | 'unavailable';
  measuredCostCents: number | null;
  modeledCostCents: number | null;
  marginCents: number | null;
  marginPercent: number | null;
};

export type EngineUsageRow = {
  engine: string;
  tasks: number;
  /** Share of the filtered total, 0-100. */
  sharePercent: number;
  totalTokens: number | null;
  totalDurationMs: number | null;
  measuredCostCents: number | null;
};

export type UserUsageRow = {
  userId: number;
  isSystem: boolean;
  name: string | null;
  companyId: number;
  companyName: string | null;
  tasks: number;
  aiTasks: number;
  totalTokens: number | null;
  totalDurationMs: number | null;
};

export type TaskUsageRow = {
  taskKey: string;
  engine: string;
  executions: number;
  totalDurationMs: number | null;
  avgDurationMs: number | null;
  totalTokens: number | null;
};

export type UsageAttribution = {
  /** False when the rollup has never run — every array is empty, not zeroed. */
  metered: boolean;
  filters: UsageAttributionFilters;
  companies: CompanyUsageRow[];
  /** True when the company cap was hit — never a silent truncation. */
  companiesTruncated: boolean;
  engines: EngineUsageRow[];
  users: UserUsageRow[];
  tasks: TaskUsageRow[];
  totalTasks: number;
  totalAiTasks: number;
  totalAiTasksWithUsage: number;
  /** Sum over the returned companies; null when nothing is priced. */
  totalBilledPriceCents: number | null;
  totalCostCents: number | null;
  totalMarginCents: number | null;
  /** True when ANY returned company's cost is an assumption rather than a measurement. */
  anyModeledCost: boolean;
};

// ---------------------------------------------------------------------------
// SQL builders (exported so the tests assert the exact shapes)
// ---------------------------------------------------------------------------

export function companyUsageSql(clause: string, limitPlaceholder: number): string {
  return `SELECT r.tenant_id                        AS company_id,
       o.name                                AS company_name,
       s.tier_key                            AS tier_key,
       c.display_name                        AS tier_label,
       s.monthly_price_cents_override        AS monthly_price_cents_override,
       c.monthly_price_cents                 AS monthly_price_cents,
       c.cost_per_task_cents                 AS cost_per_task_cents,
       sum(r.events)::bigint                 AS tasks,
       sum(r.ai_events)::bigint              AS ai_tasks,
       sum(r.ai_events_with_usage)::bigint   AS ai_tasks_with_usage,
       sum(r.total_tokens)::bigint           AS total_tokens,
       sum(r.duration_ms_sum)::bigint        AS total_duration_ms,
       sum(r.cost_cents)                     AS measured_cost_cents
     FROM usage_rollup_daily r
     LEFT JOIN organizations o        ON o.id = r.tenant_id
     LEFT JOIN company_subscriptions s ON s.company_id = r.tenant_id
     LEFT JOIN plan_rate_cards c       ON c.tier_key = s.tier_key
    WHERE ${clause}
    GROUP BY 1, 2, 3, 4, 5, 6, 7
    ORDER BY sum(r.events) DESC
    LIMIT $${limitPlaceholder}`;
}

export function engineUsageSql(clause: string): string {
  return `SELECT execution_engine             AS execution_engine,
       sum(events)::bigint          AS tasks,
       sum(total_tokens)::bigint    AS total_tokens,
       sum(duration_ms_sum)::bigint AS total_duration_ms,
       sum(ai_events)::bigint       AS ai_tasks,
       sum(ai_events_with_usage)::bigint AS ai_tasks_with_usage,
       sum(cost_cents)              AS measured_cost_cents
     FROM usage_rollup_daily
    WHERE ${clause}
    GROUP BY 1
    ORDER BY 2 DESC`;
}

export function userUsageSql(clause: string, limitPlaceholder: number): string {
  return `SELECT r.user_id                      AS user_id,
       r.tenant_id                    AS company_id,
       o.name                         AS company_name,
       u.full_name                    AS full_name,
       u.email                        AS email,
       sum(r.events)::bigint          AS tasks,
       sum(r.ai_events)::bigint       AS ai_tasks,
       sum(r.total_tokens)::bigint    AS total_tokens,
       sum(r.duration_ms_sum)::bigint AS total_duration_ms
     FROM usage_rollup_daily r
     LEFT JOIN users u         ON u.id = r.user_id
     LEFT JOIN organizations o ON o.id = r.tenant_id
    WHERE ${clause}
    GROUP BY 1, 2, 3, 4, 5
    ORDER BY sum(r.events) DESC
    LIMIT $${limitPlaceholder}`;
}

export function taskUsageSql(clause: string, limitPlaceholder: number): string {
  return `SELECT task_key                      AS task_key,
       execution_engine              AS execution_engine,
       sum(events)::bigint           AS executions,
       sum(duration_ms_sum)::bigint  AS total_duration_ms,
       sum(total_tokens)::bigint     AS total_tokens
     FROM usage_rollup_daily
    WHERE ${clause}
    GROUP BY 1, 2
    ORDER BY sum(events) DESC
    LIMIT $${limitPlaceholder}`;
}

// ---------------------------------------------------------------------------
// Coercion
// ---------------------------------------------------------------------------

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

function asCount(value: unknown): number {
  return asNumberOrNull(value) ?? 0;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function sumOrNull(values: (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length ? known.reduce((total, value) => total + value, 0) : null;
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

export type LoadUsageAttributionOptions = {
  db?: Queryable;
  companyLimit?: number;
  breakdownLimit?: number;
};

/**
 * Build the internal attribution payload. Throws on a DB error — the dashboard
 * shows an error rather than a confidently empty finance report.
 */
export async function loadUsageAttribution(
  filters: UsageAttributionFilters,
  options: LoadUsageAttributionOptions = {},
): Promise<UsageAttribution> {
  const db = options.db ?? pool;
  const companyLimit = options.companyLimit ?? DEFAULT_COMPANY_LIMIT;
  const breakdownLimit = options.breakdownLimit ?? DEFAULT_BREAKDOWN_LIMIT;

  const empty: UsageAttribution = {
    metered: false,
    filters,
    companies: [],
    companiesTruncated: false,
    engines: [],
    users: [],
    tasks: [],
    totalTasks: 0,
    totalAiTasks: 0,
    totalAiTasksWithUsage: 0,
    totalBilledPriceCents: null,
    totalCostCents: null,
    totalMarginCents: null,
    anyModeledCost: false,
  };

  // Same watermark contract as the customer-facing surface: with the rollup
  // worker off, the aggregates are empty, and a zeroed finance dashboard is a
  // wrong number rather than a missing one.
  const watermarkRes = await db.query(SELECT_WATERMARK_SQL, [ROLLUP_STATE_ID]);
  const watermarkRow = watermarkRes.rows[0] as { rolled_through?: unknown } | undefined;
  if (!watermarkRow || watermarkRow.rolled_through === null || watermarkRow.rolled_through === undefined) {
    return empty;
  }

  // Strictly sequential, never Promise.all (guardrail #1).
  const companyFilter = buildUsageFilterClause(filters, 'r.');
  const flatFilter = buildUsageFilterClause(filters);

  // One over the cap, so truncation is detected and reported rather than
  // silently changing what the totals mean.
  const companiesRes = await db.query(
    companyUsageSql(companyFilter.clause, companyFilter.params.length + 1),
    [...companyFilter.params, companyLimit + 1],
  );
  const enginesRes = await db.query(engineUsageSql(flatFilter.clause), flatFilter.params);
  const usersRes = await db.query(userUsageSql(companyFilter.clause, companyFilter.params.length + 1), [
    ...companyFilter.params,
    breakdownLimit,
  ]);
  const tasksRes = await db.query(taskUsageSql(flatFilter.clause, flatFilter.params.length + 1), [
    ...flatFilter.params,
    breakdownLimit,
  ]);

  const companyRows = companiesRes.rows as Record<string, unknown>[];
  const companiesTruncated = companyRows.length > companyLimit;
  const companies = companyRows.slice(0, companyLimit).map(toCompanyRow);

  // Totals come from the ENGINE query, which has no row cap, so a truncated
  // company list can never understate the platform total.
  const engineRows = enginesRes.rows as Record<string, unknown>[];
  const totalTasks = engineRows.reduce((total, row) => total + asCount(row.tasks), 0);
  const totalAiTasks = engineRows.reduce((total, row) => total + asCount(row.ai_tasks), 0);
  const totalAiTasksWithUsage = engineRows.reduce(
    (total, row) => total + asCount(row.ai_tasks_with_usage),
    0,
  );

  return {
    metered: true,
    filters,
    companies,
    companiesTruncated,
    engines: engineRows.map((row) => toEngineRow(row, totalTasks)),
    users: (usersRes.rows as Record<string, unknown>[]).map(toUserRow),
    tasks: (tasksRes.rows as Record<string, unknown>[]).map(toTaskRow),
    totalTasks,
    totalAiTasks,
    totalAiTasksWithUsage,
    totalBilledPriceCents: sumOrNull(companies.map((row) => row.billedPriceCents)),
    totalCostCents: sumOrNull(companies.map((row) => row.costCents)),
    totalMarginCents: sumOrNull(companies.map((row) => row.marginCents)),
    anyModeledCost: companies.some((row) => row.costBasis === 'modeled'),
  };
}

function toCompanyRow(row: Record<string, unknown>): CompanyUsageRow {
  const companyId = asCount(row.company_id);
  const tasks = asCount(row.tasks);
  const aiTasksWithUsage = asCount(row.ai_tasks_with_usage);
  const tier = asTrimmedString(row.tier_key);
  const margin = projectMargin({
    billedPriceCents: resolveBilledPriceCents(row, isPlanTier(tier) ? tier : DEFAULT_PLAN_TIER),
    measuredCostCents: asNumberOrNull(row.measured_cost_cents),
    usageReportedEvents: aiTasksWithUsage,
    tasks,
    costPerTaskCents: parseRateCents(row.cost_per_task_cents),
  });

  return {
    companyId,
    companyName: asTrimmedString(row.company_name),
    // 0 is the AA-161 sentinel. Surfaced and labelled, not dropped: unattributed
    // platform work is part of the efficiency picture this dashboard answers.
    isUnscoped: companyId === 0,
    tier,
    tierLabel: asTrimmedString(row.tier_label),
    tasks,
    aiTasks: asCount(row.ai_tasks),
    aiTasksWithUsage,
    totalTokens: asNumberOrNull(row.total_tokens),
    totalDurationMs: asNumberOrNull(row.total_duration_ms),
    ...margin,
  };
}

function toEngineRow(row: Record<string, unknown>, totalTasks: number): EngineUsageRow {
  const tasks = asCount(row.tasks);
  return {
    engine: asTrimmedString(row.execution_engine) ?? 'UNKNOWN',
    tasks,
    sharePercent: totalTasks > 0 ? Math.round((tasks / totalTasks) * 100) : 0,
    totalTokens: asNumberOrNull(row.total_tokens),
    totalDurationMs: asNumberOrNull(row.total_duration_ms),
    measuredCostCents: asNumberOrNull(row.measured_cost_cents),
  };
}

function toUserRow(row: Record<string, unknown>): UserUsageRow {
  const userId = asCount(row.user_id);
  return {
    userId,
    isSystem: userId === 0,
    name: asTrimmedString(row.full_name) ?? asTrimmedString(row.email),
    companyId: asCount(row.company_id),
    companyName: asTrimmedString(row.company_name),
    tasks: asCount(row.tasks),
    aiTasks: asCount(row.ai_tasks),
    totalTokens: asNumberOrNull(row.total_tokens),
    totalDurationMs: asNumberOrNull(row.total_duration_ms),
  };
}

function toTaskRow(row: Record<string, unknown>): TaskUsageRow {
  const executions = asCount(row.executions);
  const totalDurationMs = asNumberOrNull(row.total_duration_ms);
  return {
    taskKey: asTrimmedString(row.task_key) ?? '',
    engine: asTrimmedString(row.execution_engine) ?? 'UNKNOWN',
    executions,
    totalDurationMs,
    avgDurationMs:
      totalDurationMs !== null && executions > 0 ? Math.round(totalDurationMs / executions) : null,
    totalTokens: asNumberOrNull(row.total_tokens),
  };
}
