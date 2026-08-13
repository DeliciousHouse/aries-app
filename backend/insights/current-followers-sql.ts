/**
 * backend/insights/current-followers-sql.ts
 *
 * S1-8 / AA-87 (and AA-246) — currentFollowers = SUM of each platform's
 * LATEST follower count. NOT MAX across platforms (which shows only the
 * largest single platform — a multi-platform tenant with FB 10k + IG 6k
 * wrongly saw 10k) and NOT SUM across dates (which multiplies by the number
 * of daily snapshots). DISTINCT ON (platform) ORDER BY platform, date DESC
 * takes the most recent non-null follower row per platform; the outer SUM
 * adds those per-platform latest values.
 *
 * Zero runtime imports — same style as latest-post-metrics-sql.ts and
 * account-engagement-sql.ts, its two siblings in this module. This matters
 * beyond convention: read-api.ts (the original home of this constant) pulls
 * in `next/server` and `@/lib/db`, and `@/lib/db` constructs a `pg.Pool` at
 * module scope. A second consumer that only needs the SQL text (Trends'
 * trends-snapshot-builder.ts) would otherwise construct a Pool it never uses
 * merely by importing the constant, and pure-math test files that import
 * from the same module (tests/insights-math-pinning.test.ts) would pay that
 * cost too. Exported standalone so the requires-infra test
 * (tests/insights-summary-current-followers.requires-infra.test.ts) proves
 * the exact expression against the real schema.
 */
const LATEST_FOLLOWERS_PER_PLATFORM_SUBQUERY = `
      SELECT COALESCE(SUM(latest.followers), 0)
      FROM (
        SELECT DISTINCT ON (platform) followers
        FROM insights_account_metrics_daily
        WHERE tenant_id = $1
          AND date >= $2
          AND ($3::text IS NULL OR platform = $3)
          AND followers IS NOT NULL
        ORDER BY platform, date DESC
      ) latest`;

export const CURRENT_FOLLOWERS_SUM_SQL =
  `SELECT (${LATEST_FOLLOWERS_PER_PLATFORM_SUBQUERY}) AS current_followers`;

/** Embeddable fragment for composing into a larger SELECT's column list
 *  (see read-api.ts's summary query, which already has its own $1/$2/$3). */
export { LATEST_FOLLOWERS_PER_PLATFORM_SUBQUERY };
