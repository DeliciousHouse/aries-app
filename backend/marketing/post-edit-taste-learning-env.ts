/**
 * Rollout gate for learning taste from operator post edits on the userless
 * weekly run. When ON: (1) post synthesis stamps a visual-style lens
 * (style_dimension/style_value) on each row, and (2) the review-edit producers
 * (creative approve/reject, regenerate, delete) write a tenant-scoped taste
 * signal via applyTenantTasteSignal. When OFF (default) nothing is stamped and
 * no taste is written — the synthesized rows and edit routes are byte-identical
 * to today.
 *
 * Treat 1/true/yes/on as enabled, matching the ARIES_FEED_LOGO_COMPOSITE_ENABLED
 * convention. Process-wide; default OFF.
 */
type Env = Partial<Record<string, string | undefined>>;

export function isPostEditTasteLearningEnabled(env: Env = process.env): boolean {
  const v = env.ARIES_POST_EDIT_TASTE_LEARNING_ENABLED?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}
