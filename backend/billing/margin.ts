/**
 * AA-165 — margin per client, for the INTERNAL usage & cost dashboard.
 *
 * The whole module exists to keep one distinction visible: what we MEASURED
 * versus what we ASSUMED.
 *
 * Measured cost is `sum(task_execution_log.cost_cents)`. It is a hard 0 on the
 * DETERMINISTIC_RULE and LOCAL_EDGE engines by construction, and NULL on every
 * AI_LLM row, because Hermes owns model routing and does not report usage back
 * to Aries. SUM skips NULLs — so a company whose entire spend is AI work sums to
 * a perfectly confident **0**, and a naive margin would report 100% for every
 * client on the platform. That is the specific wrong number this module refuses
 * to produce: measured cost counts only when `usageReportedEvents > 0` says
 * something actually reported it.
 *
 * Modeled cost is `tasks x cost_per_task_cents` from the rate card — an
 * explicitly configured assumption. It is what makes the dashboard usable today,
 * and it is labelled `costBasis: 'modeled'` at every surface so nobody mistakes
 * it for a measurement.
 *
 * The basis flips to 'measured' on its own the moment Hermes emits the protocol
 * 1.3.0 `usage` block. No further change is needed here.
 *
 * Nothing in this module is read by the enforcement gate or by any
 * customer-facing surface, and `daily_company_usage.total_cogs_cents` remains
 * `sum(cost_cents)` — no bill is synthesized from a rate card.
 */

/** Where the cost figure came from. 'unavailable' is a real, reportable state. */
export type CostBasis = 'measured' | 'modeled' | 'unavailable';

export type MarginInput = {
  /** Configured monthly price for the company; null = no configured price. */
  billedPriceCents: number | null;
  /** sum(cost_cents) over the window; meaningless unless usageReportedEvents > 0. */
  measuredCostCents: number | null;
  /** How many AI events actually reported usage. The measured-cost denominator. */
  usageReportedEvents: number;
  /** Task count in the window, for the modeled basis. */
  tasks: number;
  /** Configured modeled cost per task; null = no modeled basis available. */
  costPerTaskCents: number | null;
};

export type MarginProjection = {
  billedPriceCents: number | null;
  /** The cost actually used for the margin below, per costBasis. */
  costCents: number | null;
  costBasis: CostBasis;
  measuredCostCents: number | null;
  modeledCostCents: number | null;
  /** billed - cost. null whenever either side is unknown — never price - 0. */
  marginCents: number | null;
  /** 0-100, or negative for a loss-making client. null when margin is null. */
  marginPercent: number | null;
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Project one company's margin for one window.
 *
 * Deliberate asymmetry: every unknown propagates as null rather than collapsing
 * to 0. An unpriced client is "unknown margin", not "100% loss"; an unmeasured
 * cost is "unknown cost", not "free". A finance dashboard that guesses is worse
 * than one that abstains.
 */
export function projectMargin(input: MarginInput): MarginProjection {
  const measuredUsable =
    input.usageReportedEvents > 0 &&
    input.measuredCostCents !== null &&
    Number.isFinite(input.measuredCostCents);

  const modeledCostCents =
    input.costPerTaskCents !== null && Number.isFinite(input.costPerTaskCents)
      ? round2(input.tasks * input.costPerTaskCents)
      : null;

  // Measured always wins when it exists: the moment Hermes reports usage, the
  // dashboard stops showing an assumption without anyone editing this file.
  const costBasis: CostBasis = measuredUsable
    ? 'measured'
    : modeledCostCents !== null
      ? 'modeled'
      : 'unavailable';

  const costCents =
    costBasis === 'measured'
      ? round2(input.measuredCostCents as number)
      : costBasis === 'modeled'
        ? modeledCostCents
        : null;

  const billedPriceCents =
    input.billedPriceCents !== null && Number.isFinite(input.billedPriceCents)
      ? input.billedPriceCents
      : null;

  const marginCents =
    billedPriceCents !== null && costCents !== null ? round2(billedPriceCents - costCents) : null;

  // A zero-priced client has no meaningful percentage — guarding the division
  // keeps Infinity/NaN off the dashboard. Negative margin is NOT clamped: a
  // loss-making client is exactly what this dashboard exists to surface.
  const marginPercent =
    marginCents !== null && billedPriceCents !== null && billedPriceCents > 0
      ? Math.round((marginCents / billedPriceCents) * 100)
      : null;

  return {
    billedPriceCents,
    costCents,
    costBasis,
    measuredCostCents: measuredUsable ? round2(input.measuredCostCents as number) : null,
    modeledCostCents,
    marginCents,
    marginPercent,
  };
}
