/**
 * Shared truthiness for {@link ARIES_RESEARCH_ENABLED} across onboarding seed,
 * marketing research dispatch, and post-login hooks.
 */
export function isAriesResearchEnabled(
  env: Partial<Record<string, string | undefined>> = process.env,
): boolean {
  const v = env.ARIES_RESEARCH_ENABLED?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}
