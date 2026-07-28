/**
 * AA-163 — the pre-execution plan gate.
 *
 * "Enforces balance checks against active subscription limits before task
 * execution": resolve the company's subscription, read its consumption for the
 * current billing period from the AA-161/162 usage rollups, and refuse to start
 * new work once the allowance is spent.
 *
 * Enforced on TASK COUNTS. Every AI_LLM row carries NULL tokens because Hermes
 * owns model routing and does not report usage back to Aries, so a token gate
 * would compare a ceiling against a permanently-zero counter and never deny
 * anything. `ARIES_PLAN_ENFORCEMENT_METRIC=tokens` flips the metric with no
 * migration the moment that changes; until then it is inert by construction
 * (an unmetered metric always allows — see below).
 *
 * Failure discipline, deliberately asymmetric: this gate FAILS OPEN on every
 * uncertainty — flag off, non-company work, no rollup watermark, unreadable
 * subscription, unreadable usage, unlimited allowance. It denies only when it
 * positively knows the company is over a known ceiling. A metering outage must
 * never look like a paywall to a paying customer, and that matches the repo's
 * existing guard convention (the publish guards fail open on any DB error).
 *
 * Consumption is read from `daily_company_usage`, which the rollup worker
 * refreshes hourly, so the gate lags real usage by up to one refresh interval. A
 * company can overshoot by at most that much. Exact metering is not achievable
 * while tokens are unreported anyway, and putting a raw-log scan on the
 * job-create path would trade a real latency cost for precision we cannot use
 * (guardrail #1).
 */

import { pool } from '@/lib/db';

import { loadCreditBalance } from './credit-ledger';
import {
  DEFAULT_PLAN_TIER,
  resolveIncludedAllowance,
  type PlanTier,
  isPlanTier,
} from './rate-cards';
import {
  isPlanEnforcementEnabled,
  resolvePlanEnforcementMetric,
  type PlanEnforcementMetric,
} from './plan-enforcement-env';

export type Queryable = {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: unknown[]; rowCount?: number | null }>;
};

/** Why the gate let the work through. Every value except the last is fail-open. */
export type PlanAllowReason =
  | 'enforcement_disabled'
  | 'not_company_scoped'
  | 'unlimited_allowance'
  | 'usage_not_metered'
  | 'usage_unavailable'
  | 'subscription_unavailable'
  | 'credits_unavailable'
  | 'within_allowance';

export type PlanEnforcementDecision =
  | {
      allowed: true;
      reason: PlanAllowReason;
      tier: PlanTier | null;
      metric: PlanEnforcementMetric;
      used: number | null;
      allowance: number | null;
    }
  | {
      allowed: false;
      code: 'plan_limit_exceeded';
      tier: PlanTier;
      metric: PlanEnforcementMetric;
      used: number;
      allowance: number;
    };

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/**
 * The company's subscription joined to its tier's card. The override columns win
 * over the card, which is what makes Enterprise/Custom a negotiated ceiling
 * rather than a bespoke code path.
 */
export const SELECT_SUBSCRIPTION_SQL = `SELECT s.tier_key,
            s.monthly_task_allowance_override,
            s.monthly_token_allowance_override,
            c.monthly_task_allowance,
            c.monthly_token_allowance
       FROM company_subscriptions s
       JOIN plan_rate_cards c ON c.tier_key = s.tier_key
      WHERE s.company_id = $1`;

/**
 * Period-to-date consumption plus the rollup watermark, in ONE round trip on the
 * job-create path. The watermark is the "is usage being metered at all?" signal:
 * with the rollup worker off (its default), the aggregates are empty and a naive
 * read would report 0 used and silently enforce against nothing.
 *
 * total_tokens stays NULL when nothing reported usage — that NULL is what keeps
 * the tokens metric inert instead of denying on absent data.
 */
export const SELECT_CONSUMPTION_SQL = `SELECT
       (SELECT rolled_through FROM usage_rollup_state WHERE id = 'hourly') AS rolled_through,
       (SELECT COALESCE(sum(total_tasks), 0)::bigint FROM daily_company_usage
         WHERE company_id = $1 AND usage_date >= $2::date) AS tasks_used,
       (SELECT sum(total_tokens)::bigint FROM daily_company_usage
         WHERE company_id = $1 AND usage_date >= $2::date) AS tokens_used`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * First day of the current UTC calendar month, as `YYYY-MM-01`.
 *
 * A calendar month, not a per-company anchor date: a real billing anchor belongs
 * to the payments work that will own subscription lifecycle, and inventing one
 * here would be a second source of truth to migrate later.
 */
export function billingPeriodStart(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}-01`;
}

/** Company ids are integers; anything else is not company-scoped work. */
function companyIdOf(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return Number.isInteger(value) && value > 0 ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function usedCount(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export type AssertUsageWithinPlanOptions = {
  db?: Queryable;
  env?: Partial<Record<string, string | undefined>>;
  now?: () => Date;
};

/**
 * Decide whether `companyId` may start another task. Never throws: every failure
 * path resolves to an allow with the reason recorded, so a caller can log why it
 * was permitted without having to catch anything.
 */
export async function assertUsageWithinPlan(
  companyId: string | number | null | undefined,
  options: AssertUsageWithinPlanOptions = {},
): Promise<PlanEnforcementDecision> {
  const env = options.env ?? process.env;
  const metric = resolvePlanEnforcementMetric(env);

  const allow = (
    reason: PlanAllowReason,
    extra: Partial<{ tier: PlanTier | null; used: number | null; allowance: number | null }> = {},
  ): PlanEnforcementDecision => ({
    allowed: true,
    reason,
    metric,
    tier: extra.tier ?? null,
    used: extra.used ?? null,
    allowance: extra.allowance ?? null,
  });

  if (!isPlanEnforcementEnabled(env)) {
    return allow('enforcement_disabled');
  }

  const company = companyIdOf(companyId);
  if (company === null) {
    // System sweeps, the reconciler and the weekly cron are not billed to anyone.
    return allow('not_company_scoped');
  }

  const db = options.db ?? pool;

  // 1. Subscription + tier card. A company with no row of its own is treated as
  //    the entry tier rather than as unmetered, so a workspace created after the
  //    backfill is still covered without waiting for a container restart.
  let tier: PlanTier = DEFAULT_PLAN_TIER;
  let allowance: number | null;
  try {
    const res = await db.query(SELECT_SUBSCRIPTION_SQL, [company]);
    const row = res.rows[0] as Record<string, unknown> | undefined;
    if (row && isPlanTier(row.tier_key)) {
      tier = row.tier_key;
    }
    // Shared with the dashboard summary, so the number a customer is SHOWN and
    // the number they are CUT OFF at cannot drift apart.
    allowance = resolveIncludedAllowance(row, metric, tier);
  } catch (error) {
    console.warn('[plan-gate] subscription lookup failed — allowing', {
      companyId: company,
      error: error instanceof Error ? error.message : String(error),
    });
    return allow('subscription_unavailable');
  }

  // NULL allowance is UNLIMITED (Enterprise, or a tier with no ceiling), never a
  // zero that would deny everything.
  if (allowance === null) {
    return allow('unlimited_allowance', { tier });
  }

  // AA-164: purchased credits stack on top of the monthly allowance and do not
  // reset with the calendar month. Fail-open on an unreadable balance — a
  // customer who just paid for capacity must never be denied because the ledger
  // read hiccuped.
  try {
    allowance += await loadCreditBalance(company, db);
  } catch (error) {
    console.warn('[plan-gate] credit balance lookup failed — allowing', {
      companyId: company,
      error: error instanceof Error ? error.message : String(error),
    });
    return allow('credits_unavailable', { tier, allowance });
  }

  // 2. Period-to-date consumption.
  const periodStart = billingPeriodStart((options.now ?? (() => new Date()))());
  let usageRow: Record<string, unknown> | undefined;
  try {
    const res = await db.query(SELECT_CONSUMPTION_SQL, [company, periodStart]);
    usageRow = res.rows[0] as Record<string, unknown> | undefined;
  } catch (error) {
    console.warn('[plan-gate] usage lookup failed — allowing', {
      companyId: company,
      error: error instanceof Error ? error.message : String(error),
    });
    return allow('usage_unavailable', { tier, allowance });
  }

  // No watermark means the rollup has never run, so the aggregates are empty and
  // "0 used" would be an artifact of metering being off, not a real measurement.
  if (!usageRow || usageRow.rolled_through === null || usageRow.rolled_through === undefined) {
    return allow('usage_not_metered', { tier, allowance });
  }

  const used = usedCount(metric === 'tasks' ? usageRow.tasks_used : usageRow.tokens_used);
  if (used === null) {
    // The metric itself is unreported — the tokens case until Hermes emits usage.
    return allow('usage_not_metered', { tier, allowance });
  }

  if (used >= allowance) {
    return { allowed: false, code: 'plan_limit_exceeded', tier, metric, used, allowance };
  }

  return allow('within_allowance', { tier, used, allowance });
}

/**
 * Gate wrapper for callers that surface failures as coded Error messages (the
 * orchestrator's convention, e.g. `unsupported_job_type:<type>`). The thrown code
 * is mapped to a 402 by lib/marketing-create-errors.ts.
 *
 * Detail after the colon is server-derived (tier + metric), never operator input.
 */
export async function enforcePlanLimitOrThrow(
  companyId: string | number | null | undefined,
  options: AssertUsageWithinPlanOptions = {},
): Promise<PlanEnforcementDecision> {
  const decision = await assertUsageWithinPlan(companyId, options);
  if (!decision.allowed) {
    console.warn('[plan-gate] denied: plan limit exceeded', {
      companyId,
      tier: decision.tier,
      metric: decision.metric,
      used: decision.used,
      allowance: decision.allowance,
    });
    throw new Error(`plan_limit_exceeded:${decision.tier}:${decision.metric}`);
  }
  return decision;
}
