/**
 * Rollout gate for biasing the weekly production image brief toward the learned
 * per-tenant taste profile (marketing_taste_profile, user_id IS NULL row). When
 * ON, the Hermes port preloads loadTasteForBriefByTenant(tenantId) and
 * buildProductionResumeContext folds high-confidence taste descriptors into the
 * per-image prompt (style / voice / audience / must-avoid). When OFF (default)
 * the brief is byte-identical to today — the read path stays dormant.
 *
 * Treat 1/true/yes/on as enabled, matching the ARIES_FEED_LOGO_COMPOSITE_ENABLED
 * convention. Process-wide; default OFF.
 */
type Env = Partial<Record<string, string | undefined>>;

export function isTasteBriefInjectionEnabled(env: Env = process.env): boolean {
  const v = env.ARIES_TASTE_BRIEF_INJECTION_ENABLED?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}
