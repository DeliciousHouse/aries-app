/**
 * Rollout flag for the per-tenant MARKETING LAYER — burning each tenant's own
 * copy (hook/value/CTA), logo, brand colors, and a license-safe music bed onto
 * generated creatives so they read as ads, not abstract art.
 *
 * Default OFF: when unset/off, ingest is byte-identical to today (the raw
 * generated visual). Flip per the rollout checklist after screenshot-verifying
 * a live tenant. Process-wide; reads each tenant's OWN brand kit + post copy, so
 * enabling it never paints one tenant's branding onto another.
 */
export function isMarketingLayerEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = (env.ARIES_MARKETING_LAYER_ENABLED ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}
