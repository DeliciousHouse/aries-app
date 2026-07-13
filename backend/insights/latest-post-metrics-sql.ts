/**
 * backend/insights/latest-post-metrics-sql.ts
 *
 * S2-1 / AA-92 — per-post metrics are stored as lifetime-CUMULATIVE daily
 * snapshots: `insights_post_metrics_daily` holds one row per post per sync date,
 * each carrying that post's all-time running total (see the IG/FB adapters'
 * fetchPostMetrics, which stamp a single lifetime row with `new Date()`). The
 * LATEST row per post is therefore the post's true lifetime total. Historically
 * every reader SUMmed across the dated rows as if each were a daily delta, which
 * inflated totals ~N× over N days of syncing (Gap A1).
 *
 * This LATERAL join selects each post's NEWEST snapshot as alias `m`. The outer
 * query must alias `insights_posts` as `p`. It is a drop-in replacement for the
 * old `LEFT JOIN insights_post_metrics_daily m ON m.post_id = p.id … GROUP BY p.id`
 * + `SUM(...)` idiom (same LEFT-join semantics: a post with no snapshot yields
 * NULL columns → COALESCE to 0). Aggregate `m.*` ACROSS posts (SUM/AVG/ORDER),
 * never across a single post's dated rows.
 *
 * Exported as one constant so the fix has a single source of truth across all
 * readers and the requires-infra regression can prove the exact SQL.
 */
export const LATEST_POST_METRICS_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT d.reach, d.views, d.likes, d.comments_count, d.saves, d.shares,
           d.avg_view_percentage
    FROM insights_post_metrics_daily d
    WHERE d.post_id = p.id AND d.tenant_id = p.tenant_id
    ORDER BY d.date DESC
    LIMIT 1
  ) m ON true`;
