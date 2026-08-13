/**
 * backend/insights/post-engagement-percent.ts
 *
 * AA-229/PR2a — the per-post engagement-rate formula, expressed ONCE and
 * consumed from both sides that need it: `deriveTopPostMetrics` (JS — ranks
 * and displays the top-5 list) and the weakest-post query's SQL ORDER BY
 * expression (top/top-snapshot-builder.ts — ranks in SQL with LIMIT 1, so a
 * JS post-processing step isn't available there).
 *
 * Two independently hand-typed re-derivations of "the same formula" is
 * exactly how AA-231 shipped three times (see account-engagement-sql.ts) —
 * this module is the single source so the SQL and JS sides cannot silently
 * diverge. The fixture-grid parity test in tests/insights-top-weakest.test.ts
 * pins that a Postgres-semantics mirror of POST_ENGAGEMENT_PERCENT_SQL still
 * agrees with postEngagementPercent() for every fixture.
 *
 *   engagement% = ROUND((likes + comments + saves + shares) / reach * 1000) / 10
 *   (rounded to 1 decimal; reach<=0 short-circuits to 0, never a divide.)
 */

export interface PostEngagementCounts {
  reach:    number;
  likes:    number;
  comments: number;
  saves:    number;
  shares:   number;
}

/** The single JS implementation of the formula — callers must not re-derive it. */
export function postEngagementPercent(raw: PostEngagementCounts): number {
  if (raw.reach <= 0) return 0;
  const interactions = raw.likes + raw.comments + raw.saves + raw.shares;
  return Math.round((interactions / raw.reach) * 1000) / 10;
}

/**
 * SQL expression computing the identical value. Assumes the query's CTE
 * aliases the raw columns as `likes`, `comments`, `saves`, `shares`, `reach`
 * (see top-snapshot-builder.ts's `post_metrics` CTE) — not parameterised
 * further because every current caller uses those exact aliases.
 */
export const POST_ENGAGEMENT_PERCENT_SQL =
  'ROUND(COALESCE((likes + comments + saves + shares)::numeric / NULLIF(reach, 0), 0) * 1000) / 10';
