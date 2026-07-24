/**
 * Rollout gate for the task-execution telemetry log (AA-159).
 *
 * When ON, every classified task execution (AI_LLM / DETERMINISTIC_RULE /
 * LOCAL_EDGE) appends one row to `task_execution_log` so an analyst can compare
 * paid AI inference against zero-cost deterministic and local/edge work.
 *
 * When OFF (default) NOTHING is written — no DB round-trip, no pool pressure,
 * no behavior change on any wrapped task. Every worker in this repo carries its
 * own small DB_POOL_MAX (guardrail #1), so the log must be opt-in and must never
 * hold a pooled client across a gateway call.
 *
 * Treat 1/true/yes/on as enabled, matching the ARIES_NATIVE_REPLY_ENABLED /
 * ARIES_IMAGE_EDIT_ENABLED convention. Process-wide; default OFF.
 */
type Env = Partial<Record<string, string | undefined>>;

export function isTaskTelemetryEnabled(env: Env = process.env): boolean {
  const v = env.ARIES_TASK_TELEMETRY_ENABLED?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}
