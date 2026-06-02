/**
 * Rollout gate for the onboarding first-post variant board → taste-profile flow.
 *
 * When OFF (default), onboarding runs the existing single weekly job with no
 * board (byte-identical to today). When ON, the first onboarding job fans out
 * 3 variant runs for slot 0, shows the board, and writes taste signals to the
 * Aries `marketing_taste_profile` table and to Honcho (the latter still
 * additionally gated by HONCHO_WRITE_PREFERENCES_ENABLED).
 *
 * Treat 1/true/yes/on as enabled, matching the ARIES_VIDEO_PUBLISH_ENABLED /
 * ARIES_AUTO_APPROVE_MARKETING_PIPELINE convention. Process-wide (all tenants
 * in the container). Exported (with an injectable `env`) for unit tests; not
 * part of any public module API.
 */

type Env = Partial<Record<string, string | undefined>>;

export function isOnboardingVariantBoardEnabled(env: Env = process.env): boolean {
  const v = env.ARIES_ONBOARDING_VARIANT_BOARD_ENABLED?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}
