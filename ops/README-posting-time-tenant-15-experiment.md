# Tenant 15 posting-time canary readout

AI-derived posting times are code-capped to tenant `15`. Keep that boundary in
place until the complete 28-day post-rollout window is available. Immediate
rollback is `ARIES_AI_POSTING_TIMES_ENABLED=0`.

The first tenant-15 derivation inserts one immutable row into
`marketing_posting_time_experiments`. It snapshots the preceding 28 days using
each post's latest metrics row, because `insights_post_metrics_daily` contains
lifetime-cumulative snapshots and must not be summed across dates.

Run this after `enabled_at + 28 days`:

```sql
WITH experiment AS (
  SELECT *
  FROM marketing_posting_time_experiments
  WHERE tenant_id = 15
), post_period AS (
  SELECT
    count(*)::int AS posts,
    COALESCE(sum(
      COALESCE(d.likes, 0) + COALESCE(d.comments_count, 0)
      + COALESCE(d.shares, 0) + COALESCE(d.saves, 0)
    ), 0)::bigint AS engagements,
    COALESCE(sum(COALESCE(d.reach, d.views, 0)), 0)::bigint AS impressions
  FROM experiment e
  JOIN insights_posts p
    ON p.tenant_id = e.tenant_id
   AND p.published_at >= e.enabled_at
   AND p.published_at < e.enabled_at + INTERVAL '28 days'
  JOIN LATERAL (
    SELECT d.likes, d.comments_count, d.shares, d.saves, d.reach, d.views
    FROM insights_post_metrics_daily d
    WHERE d.tenant_id = p.tenant_id
      AND d.post_id = p.id
      AND d.date < e.enabled_at + 28
    ORDER BY d.date DESC
    LIMIT 1
  ) d ON true
)
SELECT
  e.enabled_at,
  e.baseline_start,
  e.baseline_end,
  e.baseline_posts,
  e.baseline_engagements,
  e.baseline_impressions,
  e.baseline_engagement_rate,
  p.posts AS post_period_posts,
  p.engagements AS post_period_engagements,
  p.impressions AS post_period_impressions,
  CASE WHEN p.impressions > 0
       THEN p.engagements::numeric / p.impressions
       ELSE NULL END AS post_period_engagement_rate
FROM experiment e
CROSS JOIN post_period p;
```

Decision rule: review engagement rate and absolute engagement together, with
post counts as the sample-size guard. Do not broaden the feature from tenant 15
on an incomplete window or on rate improvement caused by a tiny denominator.
Record the readout date and decision in the deployment change that adjusts the
code cap.
