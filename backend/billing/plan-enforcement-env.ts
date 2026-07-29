/**
 * AA-163 — rollout gate for plan-limit enforcement.
 *
 * When OFF (default) `assertUsageWithinPlan` returns allowed immediately: no DB
 * round-trip, no behavior change on any job-create path. The rate-card tables
 * still ship and are still configurable — only the gate is dormant.
 *
 * Treat 1/true/yes/on as enabled, matching ARIES_TASK_TELEMETRY_ENABLED /
 * ARIES_USAGE_ROLLUP_ENABLED. Process-wide; default OFF.
 */

/**
 * Which metric the gate enforces on.
 *
 * 'tasks' is the default and the only one that enforces anything today: task
 * counts are recorded accurately for every execution, while every AI_LLM row has
 * NULL tokens because Hermes owns model routing and does not report usage back.
 * Setting 'tokens' before that changes is safe but inert — an unmetered metric
 * always allows (see assertUsageWithinPlan), it never denies on absent data.
 */
export const PLAN_ENFORCEMENT_METRICS = ['tasks', 'tokens'] as const;
export type PlanEnforcementMetric = (typeof PLAN_ENFORCEMENT_METRICS)[number];

export const DEFAULT_PLAN_ENFORCEMENT_METRIC: PlanEnforcementMetric = 'tasks';

type Env = Partial<Record<string, string | undefined>>;

export function isPlanEnforcementEnabled(env: Env = process.env): boolean {
  const v = env.ARIES_PLAN_ENFORCEMENT_ENABLED?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** Unrecognized values fall back to the default rather than failing a job create. */
export function resolvePlanEnforcementMetric(env: Env = process.env): PlanEnforcementMetric {
  const raw = env.ARIES_PLAN_ENFORCEMENT_METRIC?.trim().toLowerCase();
  return (PLAN_ENFORCEMENT_METRICS as readonly string[]).includes(raw ?? '')
    ? (raw as PlanEnforcementMetric)
    : DEFAULT_PLAN_ENFORCEMENT_METRIC;
}
