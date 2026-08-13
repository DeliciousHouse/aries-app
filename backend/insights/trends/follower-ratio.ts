/**
 * backend/insights/trends/follower-ratio.ts
 *
 * AA-246 — the Trends Reach tab's "x your follower base" / "% of your N
 * followers" copy previously read `snap.followers.value`, which is NOT the
 * follower base: trends-snapshot-builder.ts defines `followers.value` as
 * SUM(followers_delta) over the selected period — followers GAINED (or
 * lost) during the window, not the account's actual follower count. A
 * tenant who gained 80 followers this period read "your follower base of
 * 80"; a tenant whose delta was zero or negative fell into the
 * `Math.max(1, …)` divide-by-zero clamp, which silenced the crash without
 * silencing the claim — the denominator quietly became 1 while the printed
 * number stayed the raw (non-positive) delta, producing exactly the
 * reported "8200% of 0 followers" (qa-defect #818, sev:blocker).
 *
 * The correct quantity is the tenant's actual current follower count —
 * reused, not re-derived, from read-api.ts's `CURRENT_FOLLOWERS_SUM_SQL`
 * (DISTINCT ON (platform) latest row, summed; live-schema-pinned by
 * tests/insights-summary-current-followers.requires-infra.test.ts) and
 * threaded through as `TrendsSnapshot.followerBase`.
 *
 * This module is the one place that turns (value, followerBase) into
 * display copy, matching the account-engagement-sql.ts precedent: that bug
 * (AA-231) shipped three times because each reader re-derived its own
 * expression instead of sharing one. A single exported helper means a
 * second Trends reader reuses this, rather than re-deriving the ratio (and
 * the clamp) from scratch.
 *
 * When the base is non-positive or unknown, there is no honest ratio to
 * state: this returns null and the caller omits the line entirely, rather
 * than printing a formatted zero or a percentage against a denominator the
 * reader never sees.
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
