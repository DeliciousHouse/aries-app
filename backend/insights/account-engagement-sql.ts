/**
 * backend/insights/account-engagement-sql.ts
 *
 * AA-231 — Facebook's page adapter cannot report per-column engagement (likes,
 * commentsCount, and shares are written as literal 0 — see
 * adapters/facebook/index.ts's `RawAccountMetricsDay` mapping); the real
 * number is surfaced only via the dedicated `engagement` aggregate column
 * (Meta's page_post_engagements). A reader that sums the per-column fields
 * alone therefore sees a permanent 0% engagement rate for every Facebook
 * tenant despite real engagement existing.
 *
 * This has already been fixed twice in isolation — read-api.ts and
 * trends-snapshot-builder.ts each grew their own COALESCE(engagement, …)
 * expression — before narrative/snapshot-builder.ts repeated the same bug a
 * third time (it always zeroes engagementRate on Facebook, which zeroes the
 * engagement term of the Aries Score). This module is the single source of
 * truth so a fourth reader can't miss it again.
 *
 * Prefer the authoritative `engagement` aggregate when present (Facebook);
 * fall back to summing the per-column breakdown for platforms that report one
 * (Instagram, YouTube, etc — there `engagement` is NULL and the COALESCE
 * falls through to the unchanged per-column sum).
 *
 * `includeSaves` — Trends (Section 5) additionally folds `saves` into the
 * fallback sum; the headline summary and the narrative Hero do not. This is a
 * deliberate, pre-existing difference in what "engagement" means per surface
 * (not an oversight), so it is parameterised here rather than silently
 * unified across all three readers.
 */
export function accountEngagementSql(includeSaves = false): string {
  const fallback = includeSaves
    ? `COALESCE(likes, 0) + COALESCE(comments_count, 0) + COALESCE(saves, 0) + COALESCE(shares, 0)`
    : `COALESCE(likes, 0) + COALESCE(comments_count, 0) + COALESCE(shares, 0)`;
  return `COALESCE(engagement, ${fallback})`;
}
