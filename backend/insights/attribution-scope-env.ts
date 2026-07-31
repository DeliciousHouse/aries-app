/**
 * backend/insights/attribution-scope-env.ts
 *
 * Rollout switch for the S4-1 / AA-104 attribution scope.
 *
 * The scope itself is safe (it can never empty a section — see
 * attribution-scope.ts), but flipping it changes which post set Activity and
 * Top describe, and those two sections share numbers with sections this ticket
 * does not touch:
 *
 *   - `hoursSaved` is deliberately computed from ONE shared helper
 *     (`estimateHoursSaved`) so the Hero band and the Activity strip can never
 *     show two different numbers (S3-1 / AA-97, commit 2eb0a8ce). The Hero
 *     band's post count is not scoped, so a tenant above the threshold but
 *     below 100% coverage would see the two disagree again.
 *   - Activity's high-performer count "mirrors the Section 3 detection so both
 *     sections agree" — Section 3 (attention) still computes its >=2x baseline
 *     over every post, so a scoped Activity baseline makes the same post a
 *     high performer in one section and not the other.
 *   - Section 3's "View details" CTA scrolls straight to Section 6's
 *     `#top-performing` anchor, so a top post named by an unscoped Section 3
 *     could be missing from a scoped Section 6 list.
 *
 * Six builders read `insights_posts` (activity, attention, conversations, goal,
 * narrative, top, trends), so a coherent attribution view is a dashboard-wide
 * change, not a two-section one. This flag ships the wiring, the coverage
 * decision and the honest scope label now, and keeps the numbers on today's
 * all-channel basis until the remaining post-derived sections move with it.
 *
 * Default OFF. When OFF no coverage query runs at all, and every number in
 * Activity and Top is exactly what it is today.
 */

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export function isAttributionScopeEnabled(
  raw: string | undefined = process.env.ARIES_INSIGHTS_ATTRIBUTION_SCOPE_ENABLED,
): boolean {
  if (raw == null) return false;
  return TRUTHY.has(raw.trim().toLowerCase());
}
