/**
 * Rollout gate for compositing the REAL brand logo onto the rendered feed image
 * (post-generation, via backend/creative-memory/frame-overlay) instead of asking
 * the image model to draw a logo. When ON:
 *  - production ingest composites the materialized brand-kit logo onto eligible
 *    single-image feed creatives (frame-overlay border-off + conditional scrim);
 *  - the production prompt drops the "Brand logo:" instruction so the model does
 *    not also render a second, fake logo into the image.
 *
 * Treat 1/true/yes/on as enabled, matching the ARIES_VIDEO_PUBLISH_ENABLED /
 * ARIES_DRAFT_EXPIRY_ENABLED convention. Process-wide; default OFF.
 */
type Env = Partial<Record<string, string | undefined>>;

export function isFeedLogoCompositeEnabled(env: Env = process.env): boolean {
  const v = env.ARIES_FEED_LOGO_COMPOSITE_ENABLED?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}
