/**
 * AA-163 — tiered plan rate cards.
 *
 * Four tiers: Starter (Small), Growth (Medium), Scale (Large), Enterprise
 * (Custom). The DB table `plan_rate_cards` is the configurable source of truth —
 * the AC is "As a Product Manager I want to configure thresholds and rates", so
 * they must be editable without a deploy. The constants here are the SEED for
 * that table and the last-resort fallback when a row cannot be read, which keeps
 * the shipped defaults diffable in git.
 *
 * Two boundaries this module holds:
 *
 *   1. `costPerMillionTokensCents` is DECLARATIVE. It records configured pricing
 *      and nothing multiplies by it. `daily_company_usage.total_cogs_cents` stays
 *      `sum(cost_cents)` from the raw log — which is NULL until Hermes reports
 *      usage — so a bill is never synthesized from a rate card.
 *   2. A NULL allowance means UNLIMITED, not zero. That is how Enterprise/Custom
 *      is expressed: the tier itself is unlimited and a negotiated ceiling comes
 *      from the per-company override columns, so "Custom" needs no bespoke code
 *      path.
 */

export const PLAN_TIERS = ['starter', 'growth', 'scale', 'enterprise'] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];

/** Tier assigned to a company that has no subscription row of its own. */
export const DEFAULT_PLAN_TIER: PlanTier = 'starter';

export type RateCard = {
  tier: PlanTier;
  displayName: string;
  /** Monthly task-execution ceiling; null = unlimited. */
  monthlyTaskAllowance: number | null;
  /** Monthly token ceiling; null = unlimited. Inert until Hermes reports usage. */
  monthlyTokenAllowance: number | null;
  /** Configured price. Declarative only — never used to compute a charge. */
  costPerMillionTokensCents: number | null;
  /**
   * AA-165: what the customer is billed for this tier, per month. The billed
   * side of margin on the INTERNAL dashboard. null = no configured price
   * (Enterprise, whose price is negotiated per company), which renders as
   * unknown — never as a free client.
   */
  monthlyPriceCents: number | null;
  /**
   * AA-165: the MODELED cost of running one task. An explicitly configured
   * assumption, not a measurement: `task_execution_log.cost_cents` is a hard 0
   * on the zero-cost engines and NULL on every AI row until Hermes reports
   * usage, so a margin built on measured cost reads "100%" for every client.
   * Surfaced only as `costBasis: 'modeled'`, and superseded automatically the
   * moment real usage is reported (see backend/billing/margin.ts).
   */
  costPerTaskCents: number | null;
};

/**
 * Shipped defaults. Starting values sized for the current production profile
 * (~50 users); a PM is expected to tune them in `plan_rate_cards`, and an edited
 * row is never overwritten by a redeploy (the seed is ON CONFLICT DO NOTHING).
 */
export const DEFAULT_RATE_CARDS: Record<PlanTier, RateCard> = {
  starter: {
    tier: 'starter',
    displayName: 'Starter (Small)',
    monthlyTaskAllowance: 1000,
    monthlyTokenAllowance: 2_000_000,
    costPerMillionTokensCents: 1500,
    monthlyPriceCents: 9900,
    costPerTaskCents: 2,
  },
  growth: {
    tier: 'growth',
    displayName: 'Growth (Medium)',
    monthlyTaskAllowance: 5000,
    monthlyTokenAllowance: 10_000_000,
    costPerMillionTokensCents: 1200,
    monthlyPriceCents: 29900,
    costPerTaskCents: 2,
  },
  scale: {
    tier: 'scale',
    displayName: 'Scale (Large)',
    monthlyTaskAllowance: 25_000,
    monthlyTokenAllowance: 50_000_000,
    costPerMillionTokensCents: 1000,
    monthlyPriceCents: 99900,
    costPerTaskCents: 2,
  },
  enterprise: {
    tier: 'enterprise',
    displayName: 'Enterprise (Custom)',
    monthlyTaskAllowance: null,
    monthlyTokenAllowance: null,
    costPerMillionTokensCents: null,
    // Negotiated per company via company_subscriptions.monthly_price_cents_override.
    monthlyPriceCents: null,
    costPerTaskCents: 2,
  },
};

export function isPlanTier(value: unknown): value is PlanTier {
  return typeof value === 'string' && (PLAN_TIERS as readonly string[]).includes(value);
}

/**
 * The shipped card for a tier. An unrecognized tier falls back to the default
 * tier rather than throwing: a stray value in one row must not take down job
 * creation for the company that holds it.
 */
export function rateCardForTier(tier: unknown): RateCard {
  return isPlanTier(tier) ? DEFAULT_RATE_CARDS[tier] : DEFAULT_RATE_CARDS[DEFAULT_PLAN_TIER];
}

/**
 * The included monthly allowance for one subscription row, for one metric:
 * a per-company override beats the tier's card, which is what makes
 * Enterprise/Custom a negotiated ceiling instead of a bespoke code path.
 *
 * Shared by the enforcement gate and the dashboard summary so the number a
 * customer is shown and the number they are cut off at can never disagree.
 * Returns null for "unlimited"; a row-less company falls back to the entry
 * tier's card.
 */
export function resolveIncludedAllowance(
  row: Record<string, unknown> | undefined,
  metric: 'tasks' | 'tokens',
  tier: PlanTier,
): number | null {
  if (!row) {
    const card = rateCardForTier(tier);
    return metric === 'tasks' ? card.monthlyTaskAllowance : card.monthlyTokenAllowance;
  }
  const override = parseAllowance(
    metric === 'tasks' ? row.monthly_task_allowance_override : row.monthly_token_allowance_override,
  );
  const carded = parseAllowance(
    metric === 'tasks' ? row.monthly_task_allowance : row.monthly_token_allowance,
  );
  return override ?? carded;
}

/**
 * A BIGINT arrives from `pg` as a string. Anything that is not a non-negative
 * integer — including NULL — reads as "unlimited", never as a 0 ceiling that
 * would deny every request.
 */
export function parseAllowance(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
  }
  if (typeof value === 'bigint') {
    return value >= 0n ? Number(value) : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * AA-165 — a NUMERIC money/rate column, which `pg` returns as a string
 * ('9900.0000'). Unlike parseAllowance this keeps the fractional part, and a
 * NULL or unparseable value stays null: "no configured price" is not "free",
 * and a 0 would silently turn an unpriced client into 100% loss (or 100%
 * margin) on the finance dashboard.
 */
export function parseRateCents(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value === 'bigint') return value >= 0n ? Number(value) : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
    const parsed = Number.parseFloat(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * AA-165 — the monthly price a company is billed, from one joined
 * subscription+card row. A per-company override beats the tier's card, the same
 * shape resolveIncludedAllowance uses, so a negotiated Enterprise price needs no
 * bespoke code path. null = no configured price (rendered as unknown).
 *
 * INTERNAL surfaces only. Nothing customer-facing and nothing in the enforcement
 * gate reads this — a price must never become a ceiling.
 */
export function resolveBilledPriceCents(
  row: Record<string, unknown> | undefined,
  tier: PlanTier,
): number | null {
  if (!row) return rateCardForTier(tier).monthlyPriceCents;
  return (
    parseRateCents(row.monthly_price_cents_override) ?? parseRateCents(row.monthly_price_cents)
  );
}
