/**
 * Rollout gate for IMAGE EDIT (route a user-supplied edit instruction for an
 * existing creative to the Hermes image-edit endpoint instead of a fresh
 * regenerate).
 *
 * When ON, `POST /api/social-content/jobs/[jobId]/creatives/[creativeId]/edit`
 * submits a Hermes run carrying the edit instruction + the source image so the
 * content-generator profile calls `image_generate` on that source image
 * (image-to-image edit) rather than generating from scratch.
 *
 * When OFF (default) the route is invisible — it returns a real 404, touches no
 * DB and no Hermes gateway — byte-identical to the route not existing. This
 * mirrors the `isNativeReplyEnabled` invisible-endpoint convention.
 *
 * Treat 1/true/yes/on as enabled, matching the ARIES_NATIVE_REPLY_ENABLED /
 * ARIES_FEED_LOGO_COMPOSITE_ENABLED convention. Process-wide; default OFF.
 */
type Env = Partial<Record<string, string | undefined>>;

export function isImageEditEnabled(env: Env = process.env): boolean {
  const v = env.ARIES_IMAGE_EDIT_ENABLED?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}
