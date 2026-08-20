# Tenant 15 AI posting-time measurement contract

Status: pre-enable analysis plan. This document does not enable or change any production setting.

## Rollout boundary

- The experiment unit is **tenant `15` only**. No other tenant may receive AI-derived posting times until tenant 15 has completed the four-week post window, the result has been independently verified, and a separate rollout decision has been made.
- Let `E` be the exact UTC timestamp at which tenant 15 first becomes eligible for AI-derived posting times. Record `E` in the deployment/PR evidence before changing the tenant gate.
- Pre cohort: tenant-15 feed-equivalent posts published in **`[E - 28 days, E)`**.
- Post cohort: tenant-15 feed-equivalent posts published in **`[E, E + 28 days)`**.
- A post outcome is its lifetime-cumulative metrics snapshot on UTC publish-date + 7 days. Therefore the final comparison must not run before the post cohort has matured through **`E + 35 days`**.
- Analyze each platform separately. Do not pool Instagram and Facebook because metric availability and denominators differ.

## Observed data contract

`insights_post_metrics_daily` contains `views`, `reach`, `watch_time_minutes`, `avg_view_duration_sec`, `avg_view_percentage`, `likes`, `comments_count`, `shares`, and `saves` (`scripts/init-db.js:1447-1465`). Its rows are lifetime-cumulative snapshots, not daily increments, so snapshots must never be summed across dates (`backend/insights/latest-post-metrics-sql.ts:4-17`). The dispatcher refreshes the current date's snapshot on each sync (`backend/insights/sync/dispatcher.ts:591-624`).

The posting-time advisor optimizes the latest-snapshot value of:

`engagement = likes + comments_count + shares + saves`

and excludes `story`, `reel`, `short`, and `live` posts because the derived override applies to the feed slot (`backend/marketing/posting-time-advisor.ts:168-209`). This measurement uses the same outcome and exclusions.

Metric availability is not uniform:

- `reach` and `saves` preserve `NULL = not exposed/not read`; Instagram can supply both, while Facebook currently supplies neither (`backend/insights/adapters/_adapter.types.ts:78-105`).
- Instagram may fall back to list-level like/comment counts when post insights are unavailable; in that case reach/saves remain NULL, views is written as zero, and shares may be undercounted (`backend/insights/adapters/instagram/index.ts:332-425`).
- Facebook post views come from `post_media_view`; likes/comments/shares come from the Page-post listing cache; reach/saves remain unavailable (`backend/insights/adapters/facebook/index.ts:335-371`).
- The sync does not request metrics for posts less than one day old (`backend/insights/sync/dispatcher.ts:550-563`).

## Baseline/comparison query

Before enablement, replace the timestamp literal below with the planned `E`, run the query against the verified production read path, and attach the returned `period = 'pre'` rows to the PR/deployment evidence. Preserve the full result after all pre posts reach day 7. After `E + 35 days`, rerun the same immutable query and compare its pre/post rows. The query is read-only and hard-codes tenant 15.

```sql
WITH params AS (
  SELECT
    15::integer AS tenant_id,
    TIMESTAMPTZ 'REPLACE_WITH_EXACT_ENABLEMENT_UTC' AS enablement_at,
    7::integer AS checkpoint_days
),
windows AS (
  SELECT
    'pre'::text AS period,
    enablement_at - INTERVAL '28 days' AS starts_at,
    enablement_at AS ends_at
  FROM params
  UNION ALL
  SELECT
    'post'::text AS period,
    enablement_at AS starts_at,
    enablement_at + INTERVAL '28 days' AS ends_at
  FROM params
),
cohort AS (
  SELECT
    w.period,
    p.id AS post_id,
    p.account_id,
    p.platform,
    COALESCE(p.media_type, 'unknown') AS media_type,
    p.published_at,
    (p.published_at AT TIME ZONE 'UTC')::date AS publish_utc_date
  FROM params x
  JOIN insights_posts p
    ON p.tenant_id = x.tenant_id
  JOIN insights_accounts a
    ON a.id = p.account_id
   AND a.tenant_id = p.tenant_id
   AND a.disabled_at IS NULL
  JOIN windows w
    ON p.published_at >= w.starts_at
   AND p.published_at <  w.ends_at
  WHERE COALESCE(p.media_type, 'image')
        NOT IN ('story', 'reel', 'short', 'live')
),
checkpoint AS (
  SELECT
    c.*,
    m.date AS metrics_date,
    m.views,
    m.reach,
    m.watch_time_minutes,
    m.avg_view_duration_sec,
    m.avg_view_percentage,
    m.likes,
    m.comments_count,
    m.shares,
    m.saves,
    CASE
      WHEN m.date IS NULL THEN false
      WHEN c.platform = 'instagram' THEN m.raw_source ->> 'views' IS NOT NULL
      WHEN c.platform = 'facebook' THEN m.raw_source ->> 'post_media_view' IS NOT NULL
      ELSE m.views IS NOT NULL
    END AS provider_views_available,
    CASE WHEN m.date IS NULL THEN NULL ELSE
      COALESCE(m.likes, 0)::bigint
      + COALESCE(m.comments_count, 0)::bigint
      + COALESCE(m.shares, 0)::bigint
      + COALESCE(m.saves, 0)::bigint
    END AS engagement
  FROM cohort c
  LEFT JOIN LATERAL (
    SELECT
      d.date,
      d.views,
      d.reach,
      d.watch_time_minutes,
      d.avg_view_duration_sec,
      d.avg_view_percentage,
      d.likes,
      d.comments_count,
      d.shares,
      d.saves,
      d.raw_source
    FROM insights_post_metrics_daily d
    CROSS JOIN params x
    WHERE d.tenant_id = x.tenant_id
      AND d.post_id = c.post_id
      AND d.date = c.publish_utc_date + x.checkpoint_days
    LIMIT 1
  ) m ON true
),
format_counts AS (
  SELECT
    period,
    platform,
    jsonb_object_agg(media_type, post_count ORDER BY media_type) AS posts_by_media_type
  FROM (
    SELECT period, platform, media_type, COUNT(*)::integer AS post_count
    FROM checkpoint
    GROUP BY period, platform, media_type
  ) x
  GROUP BY period, platform
),
summary AS (
  SELECT
    period,
    platform,
    COUNT(*)::integer AS posts_published,
    COUNT(metrics_date)::integer AS posts_with_day_7_snapshot,
    ROUND(
      100.0 * COUNT(metrics_date) / NULLIF(COUNT(*), 0),
      1
    ) AS day_7_snapshot_coverage_pct,
    SUM(engagement) FILTER (WHERE metrics_date IS NOT NULL) AS total_engagement_day_7,
    ROUND(
      (AVG(engagement) FILTER (WHERE metrics_date IS NOT NULL))::numeric,
      2
    ) AS mean_engagement_per_post_day_7,
    ROUND(
      (PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY engagement)
        FILTER (WHERE metrics_date IS NOT NULL))::numeric,
      2
    ) AS median_engagement_per_post_day_7,
    SUM(likes) FILTER (WHERE metrics_date IS NOT NULL) AS likes_day_7,
    SUM(comments_count) FILTER (WHERE metrics_date IS NOT NULL) AS comments_day_7,
    SUM(shares) FILTER (WHERE metrics_date IS NOT NULL) AS shares_day_7,
    COUNT(reach)::integer AS posts_with_reach,
    SUM(reach) AS reach_day_7,
    COUNT(saves)::integer AS posts_with_saves,
    SUM(saves) AS saves_day_7,
    COUNT(*) FILTER (WHERE provider_views_available)::integer
      AS posts_with_provider_views,
    ROUND(
      (PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY views)
        FILTER (WHERE provider_views_available))::numeric,
      2
    ) AS median_views_per_post_day_7,
    ROUND(
      (PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY reach)
        FILTER (WHERE metrics_date IS NOT NULL AND reach IS NOT NULL))::numeric,
      2
    ) AS median_reach_per_post_day_7,
    ROUND(
      100.0
      * SUM(engagement) FILTER (WHERE metrics_date IS NOT NULL AND reach IS NOT NULL)
      / NULLIF(SUM(reach) FILTER (WHERE metrics_date IS NOT NULL AND reach IS NOT NULL), 0),
      4
    ) AS engagements_per_100_reached,
    ROUND(
      100.0
      * SUM(engagement) FILTER (WHERE provider_views_available)
      / NULLIF(SUM(views) FILTER (WHERE provider_views_available), 0),
      4
    ) AS engagements_per_100_views
  FROM checkpoint
  GROUP BY period, platform
)
SELECT
  s.*,
  f.posts_by_media_type
FROM summary s
JOIN format_counts f USING (period, platform)
ORDER BY s.platform, CASE s.period WHEN 'pre' THEN 1 ELSE 2 END;
```

Save the query result with: exact `E`; query execution timestamp; database/environment identifier; row count; account IDs included; and any reconnect, quarantine, sync-gap, promotion, holiday, or platform incident during either window. Do not persist captions, permalinks, raw provider payloads, or other fields not required by this contract.

## Evaluation method

### Observation

For each platform, report:

1. Primary: median day-7 engagement per measured feed post.
2. Supporting: mean and total day-7 engagement; component totals; engagements per 100 reached when reach is available in both windows; otherwise engagements per 100 views, explicitly labeled as a different denominator.
3. Guardrails: post count, day-7 snapshot coverage, media-type mix, median reach/views per post, comments per post, shares per post, and saves per post where saves are available.
4. Relative change is `(post - pre) / pre`; also report the absolute difference. If the pre value is zero, relative change is undefined rather than infinite.
5. Report a 95% bootstrap interval for the median change using 10,000 post-level resamples within platform. Treat it as uncertainty, not proof of causality.

A platform is decision-eligible only when both windows contain at least 8 measured feed posts, day-7 snapshot coverage is at least 80%, and no account reconnect or unresolved sync incident changes the measured account population. Stratify by media type if its share moves by more than 20 percentage points. Never substitute zero for unavailable reach or saves.

### Interpretation and decision thresholds

- **Success:** every decision-eligible platform has at least a 10% increase in median day-7 engagement per post; the same-denominator engagement rate does not decline by more than 5%; and no guardrail below declines by more than 20%.
- **Failure:** any decision-eligible platform has at least a 10% decline in median day-7 engagement per post, or median reach/views per post, comments per post, or shares per post declines by more than 20% without a documented measurement outage or mix explanation.
- **Inconclusive:** the primary change is between -10% and +10%; a confidence interval is wide; eligibility/coverage is not met; platforms disagree; the denominator changes; or a material confounder is present. Keep the rollout at tenant 15 and collect the smallest additional complete cohort needed to reach 8 measured posts per platform/window.

These are rollout rules, not causal claims. A four-week before/after comparison is vulnerable to seasonality, holidays, promotions, content-quality changes, audience growth, platform algorithm changes, posting-volume changes, and regression to the mean. The day-7 checkpoint controls post age, and platform/media stratification reduces two obvious mix biases, but neither creates a randomized control.

### Hypothesis and recommendation

Hypothesis: tenant-specific publish hours improve tenant 15's feed-post engagement relative to its immediately preceding four weeks.

Recommendation: enable only tenant 15 after the pre result and `E` are durably recorded. At `E + 35 days`, run the fixed query, submit the result for independent verification, and choose success/failure/inconclusive using the thresholds above. Do not broaden enablement on an inconclusive result.
