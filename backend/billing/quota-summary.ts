/**
 * AA-164 — the one place quota math lives.
 *
 * Feeds the dashboard card, the threshold alerts, and (through the shared
 * allowance resolver) agrees by construction with the enforcement gate. The
 * number a customer is shown and the number they are cut off at must never
 * disagree.
 *
 * The honesty contract, and the reason `metered` exists:
 *   consumption comes from the AA-161/162 rollups, which are empty until the
 *   rollup worker runs. Reading that as "0 used, 0% consumed" would show every
 *   customer a confident, wrong number and would make the 80/95% alerts
 *   unreachable. When there is no rollup watermark the summary reports
 *   `metered: false` with NULL usage, and the card says so instead of drawing an
 *   empty progress bar.
 *
 * percentUsed is deliberately NOT clamped at 100: a company that overshot during
 * the rollup lag is at 104%, and rounding that down to 100 would hide the
 * overage from the person paying for it.
 */

import { pool } from '@/lib/db';

import { SELECT_CREDIT_BALANCE_SQL } from './credit-ledger';
import {
  DEFAULT_PLAN_TIER,
  isPlanTier,
  rateCardForTier,
  resolveIncludedAllowance,
  type PlanTier,
} from './rate-cards';
import {
  resolvePlanEnforcementMetric,
  type PlanEnforcementMetric,
} from './plan-enforcement-env';
import { SELECT_CONSUMPTION_SQL, SELECT_SUBSCRIPTION_SQL, billingPeriodStart } from './usage-entitlement';

export type Queryable = {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: unknown[]; rowCount?: number | null }>;
};

export type QuotaSummary = {
  /** False when the rollup has never run — usage figures are NULL, not zero. */
  metered: boolean;
  metric: PlanEnforcementMetric;
  tier: PlanTier;
  tierLabel: string;
  /** Monthly allowance from the plan; null = unlimited. */
  includedAllowance: number | null;
  /** Unexpired purchased credits, which stack on top and do not reset monthly. */
  purchasedCredits: number;
  /** included + purchased; null = unlimited. */
  totalAllowance: number | null;
  /** Consumption this period; null when unmetered. */
  used: number | null;
  /** null when unmetered or unlimited. Never negative. */
  remaining: number | null;
  /** 0-100+, null when unmetered or unlimited. Not clamped — 104% is real. */
  percentUsed: number | null;
  /** First day of the current billing period (UTC calendar month), YYYY-MM-DD. */
  periodStart: string;
};

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Pure projection, exported so the percentage rules can be tested without a
 * database. `used` null means unmetered; `totalAllowance` null means unlimited.
 */
export function computeQuotaFigures(
  used: number | null,
  totalAllowance: number | null,
): { remaining: number | null; percentUsed: number | null } {
  if (used === null || totalAllowance === null) {
    return { remaining: null, percentUsed: null };
  }
  const remaining = Math.max(0, totalAllowance - used);
  if (totalAllowance <= 0) {
    // A zero ceiling is fully consumed the moment anything is used. Guarding the
    // division here keeps Infinity/NaN out of the dashboard.
    return { remaining, percentUsed: used > 0 ? 100 : 0 };
  }
  return { remaining, percentUsed: Math.round((used / totalAllowance) * 100) };
}

export type LoadQuotaSummaryOptions = {
  db?: Queryable;
  env?: Partial<Record<string, string | undefined>>;
  now?: () => Date;
};

/**
 * Build the summary for one company. Throws on a DB error: the dashboard shows
 * an error state rather than a confidently wrong balance, and the alert sweep
 * isolates the failure per company.
 */
export async function loadQuotaSummary(
  companyId: number,
  options: LoadQuotaSummaryOptions = {},
): Promise<QuotaSummary> {
  const db = options.db ?? pool;
  const metric = resolvePlanEnforcementMetric(options.env ?? process.env);
  const periodStart = billingPeriodStart((options.now ?? (() => new Date()))());

  // Sequential, never Promise.all: three small reads on one pooled client beat
  // three connections contending for the pool (guardrail #1).
  const subRes = await db.query(SELECT_SUBSCRIPTION_SQL, [companyId]);
  const subRow = subRes.rows[0] as Record<string, unknown> | undefined;
  const tier: PlanTier = isPlanTier(subRow?.tier_key) ? subRow.tier_key : DEFAULT_PLAN_TIER;
  const includedAllowance = resolveIncludedAllowance(subRow, metric, tier);

  const creditRes = await db.query(SELECT_CREDIT_BALANCE_SQL, [companyId]);
  const purchasedCredits = asNumber((creditRes.rows[0] as { balance?: unknown } | undefined)?.balance) ?? 0;

  const usageRes = await db.query(SELECT_CONSUMPTION_SQL, [companyId, periodStart]);
  const usageRow = usageRes.rows[0] as Record<string, unknown> | undefined;
  const metered = Boolean(usageRow && usageRow.rolled_through !== null && usageRow.rolled_through !== undefined);
  const rawUsed = metered
    ? asNumber(metric === 'tasks' ? usageRow?.tasks_used : usageRow?.tokens_used)
    : null;
  // A NULL metric total (the tokens case today) is "not reported", so the whole
  // summary reports unmetered rather than inventing a 0.
  const used = rawUsed;

  // Purchased credits raise the ceiling; unlimited stays unlimited.
  const totalAllowance = includedAllowance === null ? null : includedAllowance + purchasedCredits;
  const { remaining, percentUsed } = computeQuotaFigures(used, totalAllowance);

  return {
    metered: metered && used !== null,
    metric,
    tier,
    tierLabel: rateCardForTier(tier).displayName,
    includedAllowance,
    purchasedCredits,
    totalAllowance,
    used,
    remaining,
    percentUsed,
    periodStart,
  };
}
