/**
 * Sub-gate for dispatching research jobs to Hermes via
 * {@link submitMarketingResearchMemoryJob}. Requires {@link HONCHO_ENABLED}
 * to also be true — see honcho-env.ts for the master Honcho gate.
 */
export function isAriesResearchEnabled(
  env: Partial<Record<string, string | undefined>> = process.env,
): boolean {
  const v = env.ARIES_RESEARCH_ENABLED?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}
