/**
 * Rollout gate for synthesizing reviewable `posts` on the publish-SKIP terminal
 * path (a weekly/social job that completes with `publishingRequested=false`).
 *
 * Background: a weekly job whose runtime `publishingRequested` is false goes
 * terminal straight from the production `approve_publish` callback. That path
 * ingests the rendered images into `creative_assets` but never synthesizes
 * `posts`, so the operator is left with images and NO captions/hashtags and NO
 * "Publish" / "Approve" control anywhere (the publish queue + review queue both
 * read from synthesized posts). See backend/marketing/hermes-callbacks.ts.
 *
 * When ON: the publish-skip path also calls
 * `synthesizePublishPostsFromContentPackage` (via the completion helper with
 * `autoSchedule:false`) so the generated copy lands as `approved` `posts` rows
 * that surface in the dashboard with a manual "Publish now → Publish to
 * Facebook Page" button. It deliberately does NOT auto-schedule/auto-publish —
 * the human still chooses to publish. When OFF (default) the publish-skip path
 * is byte-identical to today (images ingested, no posts synthesized).
 *
 * Treat 1/true/yes/on as enabled, matching the
 * ARIES_POST_EDIT_TASTE_LEARNING_ENABLED convention. Process-wide; default OFF.
 */
type Env = Partial<Record<string, string | undefined>>;

export function isSynthesizeOnPublishSkipEnabled(env: Env = process.env): boolean {
  const v = env.ARIES_SYNTHESIZE_ON_PUBLISH_SKIP_ENABLED?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}
