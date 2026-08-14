/**
 * Rollout switch for AI-derived per-platform posting times
 * (`backend/marketing/posting-time-advisor.ts`).
 *
 * OFF (default): posting times are byte-identical to today — the auto-schedule
 * slot computation uses the hardcoded PLATFORM_POSTING_DEFAULTS, no derivation
 * runs, and no marketing_posting_times rows are read or written.
 *
 * ON: tenant 15's content-generation starts derive per-platform posting times
 * (own-analytics first, competitor research as the cold-start fallback) and
 * its auto-schedule paths prefer those rows over the defaults.
 *
 * Treat 1/true/yes/on as enabled, matching the
 * ARIES_SYNTHESIZE_ON_PUBLISH_SKIP_ENABLED convention. The process flag is
 * deliberately capped to the tenant-15 canary until its four-week comparison
 * proves value; a caller without a valid tenant id fails closed.
 */

type Env = Partial<Record<string, string | undefined>>;

export const AI_POSTING_TIMES_CANARY_TENANT_ID = 15;

export function isAiPostingTimesEnabled(
  env: Env = process.env,
  tenantId?: number | string | null,
): boolean {
  const v = env.ARIES_AI_POSTING_TIMES_ENABLED?.trim().toLowerCase();
  const enabled = v === '1' || v === 'true' || v === 'yes' || v === 'on';
  if (!enabled) return false;
  const normalized = typeof tenantId === 'string' && /^\d+$/.test(tenantId.trim())
    ? Number.parseInt(tenantId.trim(), 10)
    : tenantId;
  return normalized === AI_POSTING_TIMES_CANARY_TENANT_ID;
}
