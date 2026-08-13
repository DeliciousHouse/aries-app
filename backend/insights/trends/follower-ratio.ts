/**
 * backend/insights/trends/follower-ratio.ts
 *
 * AA-246 — two Trends metrics that claim a percentage of "your followers"
 * both divided against the wrong quantity, because trends-snapshot-builder.ts
 * defines `followers.value` as SUM(followers_delta) over the selected period
 * — followers GAINED (or lost) during the window, not the account's actual
 * follower count:
 *
 *   1. Reach tab — "Nx your follower base" / "N% of your N followers".
 *      A tenant who gained 80 followers this period read "your follower base
 *      of 80"; a tenant whose delta was zero or negative fell into a
 *      `Math.max(1, …)` divide-by-zero clamp, which silenced the crash
 *      without silencing the claim — producing exactly the reported "8200%
 *      of 0 followers" (qa-defect #818, sev:blocker).
 *
 *   2. Followers tab — "N% growth this period". This divided `value` by
 *      `platformBreakdown.followers` summed, which is the SAME
 *      per-platform followers_delta breakdown as the numerator — the
 *      fraction was structurally `x / x * 100`, a constant fabricated
 *      "100.0% growth" for every tenant regardless of real growth.
 *
 * The correct quantity for both is the tenant's actual current follower
 * count — reused, not re-derived, from current-followers-sql.ts's
 * `CURRENT_FOLLOWERS_SUM_SQL` (DISTINCT ON (platform) latest row, summed;
 * live-schema-pinned by
 * tests/insights-summary-current-followers.requires-infra.test.ts) and
 * threaded through as `TrendsSnapshot.followerBase`.
 *
 * This module is the one place that turns a (value, followerBase) pair into
 * display copy, matching the account-engagement-sql.ts precedent: that bug
 * (AA-231) shipped three times because each reader re-derived its own
 * expression instead of sharing one. A single pair of exported helpers means
 * a future Trends reader reuses these, rather than re-deriving the ratio
 * (and the clamp) from scratch.
 *
 * When the base is non-positive or unknown, there is no honest claim to
 * state: both helpers return null and the caller omits the line entirely,
 * rather than printing a formatted zero or a percentage against a
 * denominator the reader never sees.
 */
export function buildFollowerRatioLine(
  value: number,
  followerBase: number | null | undefined,
  formatNumber: (n: number) => string,
): string | null {
  if (followerBase == null || followerBase <= 0) return null;

  const ratio = Math.round((value / followerBase) * 10) / 10;
  if (ratio >= 1) {
    return `${ratio}x your follower base of ${formatNumber(followerBase)}`;
  }
  const pct = Math.round((value / followerBase) * 100);
  return `reached ${pct}% of your ${formatNumber(followerBase)} followers`;
}

/**
 * Trends Followers-tab "N% growth this period" copy — see module doc
 * comment item 2. `delta` is the period's SUM(followers_delta)
 * (`snap.followers.value`); divides against the real follower base, never
 * against the same delta quantity grouped by platform. Keeps the sign of
 * `delta`, so a follower decline reads as a negative growth percentage
 * (the raw delta is still shown separately, colour-coded, alongside this
 * line — this is not the reader's only signal of direction).
 */
export function buildFollowerGrowthLine(
  delta: number,
  followerBase: number | null | undefined,
  formatNumber: (n: number) => string,
): string | null {
  if (followerBase == null || followerBase <= 0) return null;

  const pct = ((delta / followerBase) * 100).toFixed(1);
  return `${pct}% growth off your ${formatNumber(followerBase)} follower base`;
}
