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
  },
  growth: {
    tier: 'growth',
    displayName: 'Growth (Medium)',
    monthlyTaskAllowance: 5000,
    monthlyTokenAllowance: 10_000_000,
    costPerMillionTokensCents: 1200,
  },
  scale: {
    tier: 'scale',
    displayName: 'Scale (Large)',
    monthlyTaskAllowance: 25_000,
    monthlyTokenAllowance: 50_000_000,
    costPerMillionTokensCents: 1000,
  },
  enterprise: {
    tier: 'enterprise',
    displayName: 'Enterprise (Custom)',
    monthlyTaskAllowance: null,
    monthlyTokenAllowance: null,
    costPerMillionTokensCents: null,
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
