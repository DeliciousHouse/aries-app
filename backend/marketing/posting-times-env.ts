/**
 * Rollout switch for AI-derived per-platform posting times
 * (`backend/marketing/posting-time-advisor.ts`).
 *
 * OFF (default): posting times are byte-identical to today — the auto-schedule
 * slot computation uses the hardcoded PLATFORM_POSTING_DEFAULTS, no derivation
 * runs, and no marketing_posting_times rows are read or written.
 *
 * ON: every content-generation start derives per-platform posting times for
 * the tenant (own-analytics first, competitor research as the cold-start
 * fallback) and the auto-schedule paths prefer those rows over the defaults.
 *
 * Treat 1/true/yes/on as enabled, matching the
 * ARIES_SYNTHESIZE_ON_PUBLISH_SKIP_ENABLED convention. Process-wide; default
 * OFF.
 */

type Env = Partial<Record<string, string | undefined>>;

export function isAiPostingTimesEnabled(env: Env = process.env): boolean {
  const v = env.ARIES_AI_POSTING_TIMES_ENABLED?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}
