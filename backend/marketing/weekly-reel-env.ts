/**
 * Rollout gate for WEEKLY REEL — fires a dedicated one-off reel job as a
 * companion to each weekly_social_content job so the Reel production never
 * contends with the weekly image pipeline's single production-stage slot.
 *
 * Effective only when ARIES_VIDEO_PUBLISH_ENABLED is also on (the upstream
 * video gate must be open for the clip to render and publish). Having this
 * separate flag lets the reel companion be toggled independently of the
 * broader video-publishing switch.
 *
 * Treat 1/true/yes/on as enabled, matching the ARIES_IMAGE_EDIT_ENABLED /
 * ARIES_FEED_LOGO_COMPOSITE_ENABLED convention. Process-wide; default OFF.
 */
type Env = Partial<Record<string, string | undefined>>;

export function isWeeklyReelEnabled(env: Env = process.env): boolean {
  const v = env.ARIES_WEEKLY_REEL_ENABLED?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}
