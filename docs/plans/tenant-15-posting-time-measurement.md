# Tenant 15 AI posting-time measurement contract

Status: pre-enable, read-only analysis plan. This document does not enable or change any production setting. A fresh `growth-verifier` PASS on this exact artifact is required before it may be used to release tenant-15 enablement.

## Hard rollout boundary

- The experiment and measurement unit is tenant `15` only. Every SQL statement below hard-codes `15`.
- Do not enable another tenant, add another account, widen a window, add an unlisted platform, invoke a production connector, or change a schedule from this task.
- Let `E` be the exact UTC timestamp at which tenant 15 first becomes eligible for AI-derived posting times. Record `E` before the gate changes.
- Pre window: tenant-15 posts published in **`[E - 28 days, E)`**.
- Post window: tenant-15 posts published in **`[E, E + 28 days)`**.
- Only the exact treated platform set and exact active insights-account IDs frozen at `E` are measured. Later account or platform changes are evidence, not reasons to rewrite either cohort.
- No other tenant may receive the feature from this result. A completed tenant-15 observation, independent result verification, and a separate rollout decision are all required.

## Source and metric contract

`insights_post_metrics_daily` contains `views`, `reach`, `watch_time_minutes`, `avg_view_duration_sec`, `avg_view_percentage`, `likes`, `comments_count`, `shares`, and `saves`; its key includes a `DATE`, not a metric-capture timestamp (`scripts/init-db.js:1447-1465`). Rows are lifetime-cumulative snapshots, so snapshots for a post must never be summed across dates (`backend/insights/latest-post-metrics-sql.ts:4-17`). The dispatcher refreshes the current UTC calendar-date row repeatedly through that day (`backend/insights/sync/dispatcher.ts:540-624`).

The posting-time advisor's per-post outcome is:

`engagement = COALESCE(likes, 0) + COALESCE(comments_count, 0) + COALESCE(shares, 0) + COALESCE(saves, 0)`

The advisor excludes `story`, `reel`, `short`, and `live` because an override applies only to the feed slot (`backend/marketing/posting-time-advisor.ts:168-209`; `backend/marketing/auto-schedule.ts:182-206`). This contract uses the same exclusion and never converts a missing snapshot into zero engagement.

Metric availability remains platform- and fetch-path-specific:

- `NULL` reach or saves means unavailable/not read; it is not a measured zero (`backend/insights/adapters/_adapter.types.ts:78-105`).
- Instagram can provide reach and saves. Its fail-soft list-cache path retains likes/comments but leaves reach/saves unavailable and does not certify provider views (`backend/insights/adapters/instagram/index.ts:332-425`).
- Facebook gets provider views from `post_media_view`; its reach and saves remain unavailable (`backend/insights/adapters/facebook/index.ts:335-371`).
- The SQL may inspect `raw_source` only to emit a provider-views availability boolean. It does not return or persist `raw_source`.

## Freeze at `E`: treated platforms, accounts, and intended overrides

### Exact treated platform set

The advisor targets `instagram` and `facebook` unconditionally, then appends only the crosspost platforms returned for tenant 15 by `resolveCrosspostPlatforms`: configured/flag-eligible members of `x`, `linkedin`, and `reddit` that have an active connected account (`backend/marketing/posting-time-advisor.ts:53-56,725-729`; `backend/marketing/weekly-crosspost.ts:73-152`). YouTube and every other `insights_posts.platform` value are outside this contract.

At `E`, record non-secret evidence of the exact runtime flag/config state and the exact tenant-15 resolver result. Define:

`TREATED_PLATFORMS = ['instagram', 'facebook', ...resolver result in resolver order]`

Do not infer this array later from whatever platforms happen to exist in `insights_posts`. Both read-only queries are intentionally invalid until the unbound SQL identifier `REPLACE_WITH_EXACT_E_TIME_CROSSPOST_ARRAY` is replaced with the exact E-time resolver result as a typed array. An empty resolver result still requires the explicit replacement `ARRAY[]::text[]` (the valid base-only freeze); a non-empty result requires, for example, `ARRAY['x', 'linkedin']::text[]` in resolver order. Do not delete the concatenation or leave an executable base-only fallback. After replacement, the complete array is `instagram`, `facebook`, then that explicit resolver array. A treated platform with no measurable frozen account remains in the array and makes the result inconclusive; it must not disappear and create a vacuous success.

### Active-account freeze query

Run this read-only query once at `E`, after the account self-heal has completed. Replace only the timestamp and required crosspost-array token. It applies the production-reader requirement `disabled_at IS NULL` (`scripts/init-db.js:1370-1383`; `backend/insights/sync/dispatcher.ts:923-930`) and returns the exact account IDs to freeze.

```sql
WITH params AS (
  SELECT
    15::integer AS tenant_id,
    TIMESTAMPTZ 'REPLACE_WITH_EXACT_ENABLEMENT_UTC' AS enablement_at,
    ARRAY['instagram', 'facebook']::text[]
      || REPLACE_WITH_EXACT_E_TIME_CROSSPOST_ARRAY AS treated_platforms
    -- REQUIRED replacement: ARRAY[]::text[] for the valid base-only freeze,
    -- or the exact non-empty resolver result in resolver order. Until replaced,
    -- the unbound identifier makes the query fail closed.
),
eligible_accounts AS (
  SELECT a.id AS account_id, lower(a.platform) AS platform
  FROM insights_accounts a
  CROSS JOIN params x
  WHERE a.tenant_id = x.tenant_id
    AND a.disabled_at IS NULL
    AND lower(a.platform) = ANY(x.treated_platforms)
)
SELECT jsonb_build_object(
  'tenant_id', x.tenant_id,
  'enablement_at', x.enablement_at,
  'freeze_query_executed_at', clock_timestamp(),
  'treated_platforms', to_jsonb(x.treated_platforms),
  'included_active_account_ids', COALESCE(
    (SELECT jsonb_agg(account_id ORDER BY platform, account_id) FROM eligible_accounts),
    '[]'::jsonb
  ),
  'included_active_accounts', COALESCE(
    (
      SELECT jsonb_agg(
        jsonb_build_object('account_id', account_id, 'platform', platform)
        ORDER BY platform, account_id
      )
      FROM eligible_accounts
    ),
    '[]'::jsonb
  ),
  'intended_override_rows', COALESCE(
    (
      SELECT jsonb_agg(
        jsonb_build_object(
          'platform', lower(m.platform),
          'hour', m.hour,
          'minute', m.minute,
          'days', m.days,
          'source', m.source,
          'derived_at', m.derived_at
        )
        ORDER BY lower(m.platform)
      )
      FROM marketing_posting_times m
      WHERE m.tenant_id = x.tenant_id
        AND lower(m.platform) = ANY(x.treated_platforms)
    ),
    '[]'::jsonb
  )
) AS tenant_15_posting_time_freeze
FROM params x;
```

Attach the one-row JSON result to the enablement evidence. Copy `included_active_account_ids` into the fixed measurement query. The main query deliberately does **not** reapply current `disabled_at IS NULL`: active status was applied at the freeze, and reapplying it weeks later would silently delete a disconnected account's pre posts. Instead, the main query filters the immutable IDs and reports current disabled/replacement state as account drift. New accounts are excluded from both cohorts.

### Treatment provenance limitation

`loadPostingTimeOverrides` reads the current tenant/platform rows, but `scheduled_posts` stores the resulting timestamp and surface without an `override_used`, override version, source-row ID, applied default, or applied override (`backend/marketing/posting-time-advisor.ts:551-590`; `backend/marketing/auto-schedule.ts:1075-1159`; `backend/social-content/scheduled-posts.ts:26-46,63-126`). `insights_posts.aries_post_id` and dispatch IDs can identify an Aries-generated post with scheduled feed lineage (`backend/insights/sync/dispatcher.ts:416-458`); they cannot prove that the derived override, rather than a default, fallback, manual schedule, or later reschedule, set its time.

Accordingly:

- The SQL restricts the primary sample to posts with exact Aries scheduled-feed/dispatch lineage and emits `override_used = NULL` and `treatment_provenance_available = false`.
- The result is an **observational pre/post comparison of override-eligible Aries feed posts**, not a measurement of the feature's causal effect and not even a treatment-adherence estimate.
- Matching a published hour to a frozen override is not accepted as provenance: defaults can coincide, collisions/staggering can move a slot, and the override row can be refreshed.
- The smallest measurement that resolves this limitation is an immutable schedule-time record keyed by tenant/post/platform containing `override_used`, source/version or `derived_at`, default slot, applied slot/day decision, and final scheduled timestamp. A future effect analysis must filter on that record. This contract does not add it.

## Calendar-date checkpoint and final-read gate

For a post, the checkpoint is the row whose `date` equals:

`((published_at AT TIME ZONE 'UTC')::date + 7)`

That is a UTC **calendar-date checkpoint**, not a uniform 168-hour age. A row is refreshed at an unknown time during that UTC day. Even after the day closes, the cumulative age represented can vary with publish hour and last successful intraday refresh. Because the feature intentionally changes posting hour, checkpoint age can be correlated with the post window and bias the comparison.

The query reports a deterministic proxy, `checkpoint_close_age_hours`, from publication to the end of the checkpoint UTC day. If its pre/post platform median differs by more than 2.0 hours, posting-hour-correlated age is a material confounder and the result is inconclusive. A smaller median difference does not prove exact-age equality because the schema does not retain the intraday refresh timestamp; report that residual uncertainty.

`E + 35 days` at an arbitrary time is not sufficient. The conservative `final_read_not_before` is midnight UTC after the UTC date that could contain the last post-window publication plus its seven-day checkpoint:

`midnight_UTC(date(E + 28 days) + 8 days)`

This can be later than `E + 35 days`; if `E + 28 days` is exactly midnight it is deliberately up to one day conservative. Do not accept the final result until:

1. `now() >= final_read_not_before` (the last possible checkpoint UTC day has closed);
2. every frozen account's latest completed sync on or after that instant has `status = 'ok'`; and
3. this query's post/account/snapshot coverage checks have completed and the evaluation gates below pass.

A post-close sync does not reveal when a prior date row was last refreshed. It establishes current account/sync health; exact checkpoint-row coverage and the age proxy remain separate checks.

## Fixed bounded measurement query

Replace the three required inputs (`E`, the unbound E-time crosspost-array token that completes the exact treated-platform array, and the exact frozen-account array) from the verified freeze evidence, then do not edit the query between pre and final reads. The `E` placeholder and unbound crosspost token prevent a valid read until replaced; the empty account array remains explicitly ineligible. It is bounded to 56 publication days, tenant 15, frozen accounts, frozen platforms, and feed-equivalent posts. It returns one JSON object containing contract metadata, account/sync evidence, platform-period summaries, and the bounded post-level sample needed for uncertainty. It returns no caption, title, permalink, external provider ID, or raw provider payload.

```sql
WITH params AS (
  SELECT
    15::integer AS tenant_id,
    TIMESTAMPTZ 'REPLACE_WITH_EXACT_ENABLEMENT_UTC' AS enablement_at,
    ARRAY['instagram', 'facebook']::text[]
      || REPLACE_WITH_EXACT_E_TIME_CROSSPOST_ARRAY AS treated_platforms,
    ARRAY[]::bigint[] AS included_account_ids,
    7::integer AS checkpoint_days
    -- REQUIRED crosspost replacement: ARRAY[]::text[] for the valid base-only
    -- freeze, or the exact non-empty resolver result in resolver order. The
    -- unbound identifier fails closed. Replace the account array with the exact
    -- E-time freeze evidence; empty remains ineligible, not discovery.
),
bounds AS (
  SELECT
    x.*,
    x.enablement_at - INTERVAL '28 days' AS pre_starts_at,
    x.enablement_at AS pre_ends_at,
    x.enablement_at AS post_starts_at,
    x.enablement_at + INTERVAL '28 days' AS post_ends_at,
    (
      (
        ((x.enablement_at + INTERVAL '28 days') AT TIME ZONE 'UTC')::date
        + 8
      )::timestamp AT TIME ZONE 'UTC'
    ) AS final_read_not_before
  FROM params x
),
windows AS (
  SELECT 'pre'::text AS period, pre_starts_at AS starts_at, pre_ends_at AS ends_at
  FROM bounds
  UNION ALL
  SELECT 'post'::text AS period, post_starts_at AS starts_at, post_ends_at AS ends_at
  FROM bounds
),
platform_period_grid AS (
  SELECT w.period, platform
  FROM windows w
  CROSS JOIN bounds b
  CROSS JOIN LATERAL unnest(b.treated_platforms) AS platform
),
frozen_accounts AS (
  SELECT
    requested.account_id,
    a.id IS NOT NULL AS account_exists,
    lower(a.platform) AS current_platform,
    a.disabled_at,
    a.last_sync_at,
    (
      a.id IS NOT NULL
      AND lower(a.platform) = ANY(b.treated_platforms)
    ) AS identity_matches_contract
  FROM bounds b
  CROSS JOIN LATERAL unnest(b.included_account_ids) AS requested(account_id)
  LEFT JOIN insights_accounts a
    ON a.id = requested.account_id
   AND a.tenant_id = b.tenant_id
),
unfrozen_active_accounts AS (
  SELECT a.id AS account_id, lower(a.platform) AS platform
  FROM insights_accounts a
  CROSS JOIN bounds b
  WHERE a.tenant_id = b.tenant_id
    AND a.disabled_at IS NULL
    AND lower(a.platform) = ANY(b.treated_platforms)
    AND NOT (a.id = ANY(b.included_account_ids))
),
cohort AS (
  SELECT
    w.period,
    p.id AS post_id,
    p.account_id,
    lower(p.platform) AS platform,
    COALESCE(p.media_type, 'image') AS media_type,
    p.published_at,
    (p.published_at AT TIME ZONE 'UTC')::date AS publish_utc_date,
    EXTRACT(EPOCH FROM (
      (
        (
          (p.published_at AT TIME ZONE 'UTC')::date
          + b.checkpoint_days
          + 1
        )::timestamp AT TIME ZONE 'UTC'
      ) - p.published_at
    )) / 3600.0 AS checkpoint_close_age_hours,
    p.metrics_unavailable_at IS NOT NULL AS metrics_currently_quarantined,
    EXISTS (
      SELECT 1
      FROM scheduled_posts sp
      JOIN scheduled_post_dispatches d
        ON d.scheduled_post_id = sp.id
       AND d.status = 'dispatched'
       AND d.platform_post_id = p.external_post_id
       AND (
         CASE WHEN lower(d.platform) = 'meta'
           THEN 'facebook'
           ELSE lower(d.platform)
         END
       ) = lower(p.platform)
      WHERE sp.tenant_id = b.tenant_id
        AND sp.post_id = p.aries_post_id
        AND sp.surface = 'feed'
    ) AS aries_scheduled_feed_lineage
  FROM bounds b
  JOIN insights_posts p
    ON p.tenant_id = b.tenant_id
   AND p.account_id = ANY(b.included_account_ids)
   AND lower(p.platform) = ANY(b.treated_platforms)
  JOIN windows w
    ON p.published_at >= w.starts_at
   AND p.published_at < w.ends_at
  WHERE COALESCE(p.media_type, 'image')
        NOT IN ('story', 'reel', 'short', 'live')
),
post_rows AS (
  SELECT
    c.*,
    c.publish_utc_date + b.checkpoint_days AS expected_checkpoint_date,
    m.date AS metrics_date,
    m.views,
    m.reach,
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
    m.reach IS NOT NULL AS reach_available,
    m.saves IS NOT NULL AS saves_available,
    CASE WHEN m.date IS NULL THEN NULL ELSE
      COALESCE(m.likes, 0)::bigint
      + COALESCE(m.comments_count, 0)::bigint
      + COALESCE(m.shares, 0)::bigint
      + COALESCE(m.saves, 0)::bigint
    END AS engagement,
    (
      c.aries_scheduled_feed_lineage
      AND m.date IS NOT NULL
    ) AS analysis_included,
    NULL::boolean AS override_used
  FROM cohort c
  CROSS JOIN bounds b
  LEFT JOIN LATERAL (
    SELECT
      d.date,
      d.views,
      d.reach,
      d.likes,
      d.comments_count,
      d.shares,
      d.saves,
      d.raw_source
    FROM insights_post_metrics_daily d
    WHERE d.tenant_id = b.tenant_id
      AND d.post_id = c.post_id
      AND d.date = c.publish_utc_date + b.checkpoint_days
    LIMIT 1
  ) m ON true
),
summary AS (
  SELECT
    g.period,
    g.platform,
    COUNT(r.post_id)::integer AS candidate_feed_posts,
    COUNT(r.post_id) FILTER (
      WHERE r.aries_scheduled_feed_lineage
    )::integer AS aries_scheduled_feed_posts,
    COUNT(r.post_id) FILTER (
      WHERE r.analysis_included
    )::integer AS measured_posts,
    ROUND((
      100.0 * COUNT(r.post_id) FILTER (WHERE r.aries_scheduled_feed_lineage)
      / NULLIF(COUNT(r.post_id), 0)
    )::numeric, 1) AS aries_lineage_coverage_pct,
    ROUND((
      100.0 * COUNT(r.post_id) FILTER (WHERE r.analysis_included)
      / NULLIF(COUNT(r.post_id) FILTER (WHERE r.aries_scheduled_feed_lineage), 0)
    )::numeric, 1) AS checkpoint_snapshot_coverage_pct,
    ARRAY_AGG(DISTINCT r.account_id ORDER BY r.account_id)
      FILTER (WHERE r.post_id IS NOT NULL) AS observed_account_ids,
    SUM(r.engagement) FILTER (WHERE r.analysis_included) AS total_engagement,
    ROUND((AVG(r.engagement) FILTER (WHERE r.analysis_included))::numeric, 2)
      AS mean_engagement_per_measured_post,
    ROUND((
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY r.engagement)
      FILTER (WHERE r.analysis_included)
    )::numeric, 2) AS median_engagement_per_measured_post,
    SUM(COALESCE(r.likes, 0)) FILTER (WHERE r.analysis_included) AS likes,
    SUM(COALESCE(r.comments_count, 0)) FILTER (WHERE r.analysis_included) AS comments,
    SUM(COALESCE(r.shares, 0)) FILTER (WHERE r.analysis_included) AS shares,
    SUM(r.saves) FILTER (WHERE r.analysis_included AND r.saves_available) AS saves,
    ROUND((
      (SUM(COALESCE(r.comments_count, 0))
        FILTER (WHERE r.analysis_included))::numeric
      / NULLIF(COUNT(r.post_id) FILTER (WHERE r.analysis_included), 0)
    ), 4) AS comments_per_measured_post,
    ROUND((
      (SUM(COALESCE(r.shares, 0))
        FILTER (WHERE r.analysis_included))::numeric
      / NULLIF(COUNT(r.post_id) FILTER (WHERE r.analysis_included), 0)
    ), 4) AS shares_per_measured_post,
    COUNT(r.post_id) FILTER (
      WHERE r.analysis_included AND r.saves_available
    )::integer AS posts_with_saves,
    ROUND((
      (SUM(r.saves)
        FILTER (WHERE r.analysis_included AND r.saves_available))::numeric
      / NULLIF(COUNT(r.post_id) FILTER (
          WHERE r.analysis_included AND r.saves_available
        ), 0)
    ), 4) AS saves_per_available_post,
    COUNT(r.post_id) FILTER (
      WHERE r.analysis_included AND r.provider_views_available
    )::integer AS posts_with_provider_views,
    COUNT(r.post_id) FILTER (
      WHERE r.analysis_included AND r.reach_available
    )::integer AS posts_with_reach,
    ROUND((
      100.0 * COUNT(r.post_id) FILTER (
        WHERE r.analysis_included AND r.provider_views_available
      ) / NULLIF(COUNT(r.post_id) FILTER (WHERE r.analysis_included), 0)
    )::numeric, 1) AS provider_views_coverage_pct,
    ROUND((
      100.0 * COUNT(r.post_id) FILTER (
        WHERE r.analysis_included AND r.reach_available
      ) / NULLIF(COUNT(r.post_id) FILTER (WHERE r.analysis_included), 0)
    )::numeric, 1) AS reach_coverage_pct,
    ROUND((
      100.0 * COUNT(r.post_id) FILTER (
        WHERE r.analysis_included AND r.saves_available
      ) / NULLIF(COUNT(r.post_id) FILTER (WHERE r.analysis_included), 0)
    )::numeric, 1) AS saves_coverage_pct,
    ROUND((
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY r.views)
      FILTER (WHERE r.analysis_included AND r.provider_views_available)
    )::numeric, 2) AS median_provider_views_per_available_post,
    ROUND((
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY r.reach)
      FILTER (WHERE r.analysis_included AND r.reach_available)
    )::numeric, 2) AS median_reach_per_available_post,
    SUM(r.views) FILTER (
      WHERE r.analysis_included AND r.provider_views_available
    ) AS provider_views_denominator,
    SUM(r.reach) FILTER (
      WHERE r.analysis_included AND r.reach_available
    ) AS reach_denominator,
    ROUND((
      100.0 * SUM(r.engagement) FILTER (
        WHERE r.analysis_included AND r.provider_views_available
      ) / NULLIF(SUM(r.views) FILTER (
        WHERE r.analysis_included AND r.provider_views_available
      ), 0)
    )::numeric, 4) AS engagements_per_100_provider_views,
    ROUND((
      100.0 * SUM(r.engagement) FILTER (
        WHERE r.analysis_included AND r.reach_available
      ) / NULLIF(SUM(r.reach) FILTER (
        WHERE r.analysis_included AND r.reach_available
      ), 0)
    )::numeric, 4) AS engagements_per_100_reached,
    ROUND((
      PERCENTILE_CONT(0.5) WITHIN GROUP (
        ORDER BY r.checkpoint_close_age_hours
      ) FILTER (WHERE r.analysis_included)
    )::numeric, 2) AS median_checkpoint_close_age_hours,
    COUNT(r.post_id) FILTER (
      WHERE r.analysis_included AND r.metrics_currently_quarantined
    )::integer AS currently_quarantined_measured_posts,
    COALESCE(
      (
        SELECT jsonb_object_agg(
          mix.media_type,
          jsonb_build_object(
            'posts', mix.post_count,
            'share_pct', mix.share_pct
          )
          ORDER BY mix.media_type
        )
        FROM (
          SELECT
            x.media_type,
            COUNT(*)::integer AS post_count,
            ROUND((
              100.0 * COUNT(*) / SUM(COUNT(*)) OVER ()
            )::numeric, 1) AS share_pct
          FROM post_rows x
          WHERE x.period = g.period
            AND x.platform = g.platform
            AND x.aries_scheduled_feed_lineage
          GROUP BY x.media_type
        ) mix
      ),
      '{}'::jsonb
    ) AS media_type_mix
  FROM platform_period_grid g
  LEFT JOIN post_rows r
    ON r.period = g.period
   AND r.platform = g.platform
  GROUP BY g.period, g.platform
),
sync_state AS (
  SELECT
    a.account_id,
    a.current_platform,
    latest.id AS latest_sync_run_id,
    latest.status AS latest_sync_status,
    latest.finished_at AS latest_sync_finished_at
  FROM frozen_accounts a
  CROSS JOIN bounds b
  LEFT JOIN LATERAL (
    SELECT r.id, r.status, r.finished_at
    FROM insights_sync_runs r
    WHERE r.tenant_id = b.tenant_id
      AND r.account_id = a.account_id
      AND r.finished_at IS NOT NULL
      AND r.finished_at >= b.final_read_not_before
    ORDER BY r.finished_at DESC, r.id DESC
    LIMIT 1
  ) latest ON true
),
read_gate AS (
  SELECT
    clock_timestamp() >= b.final_read_not_before AS last_checkpoint_day_closed,
    cardinality(b.treated_platforms) > 0
      AND cardinality(b.included_account_ids) > 0 AS frozen_sets_nonempty,
    (
      SELECT COUNT(DISTINCT current_platform)
      FROM frozen_accounts
      WHERE identity_matches_contract
    ) = cardinality(b.treated_platforms) AS every_platform_has_frozen_account,
    NOT EXISTS (
      SELECT 1
      FROM frozen_accounts
      WHERE NOT account_exists
         OR NOT identity_matches_contract
         OR disabled_at IS NOT NULL
    )
    AND NOT EXISTS (SELECT 1 FROM unfrozen_active_accounts) AS no_current_account_drift,
    NOT EXISTS (
      SELECT 1
      FROM sync_state
      WHERE latest_sync_status IS DISTINCT FROM 'ok'
    )
    AND (SELECT COUNT(*) FROM sync_state) = cardinality(b.included_account_ids)
      AS every_frozen_account_latest_post_close_sync_ok
  FROM bounds b
)
SELECT jsonb_build_object(
  'contract', (
    SELECT jsonb_build_object(
      'tenant_id', b.tenant_id,
      'enablement_at', b.enablement_at,
      'pre_window', jsonb_build_array(b.pre_starts_at, b.pre_ends_at),
      'post_window', jsonb_build_array(b.post_starts_at, b.post_ends_at),
      'treated_platforms', to_jsonb(b.treated_platforms),
      'included_account_ids', to_jsonb(b.included_account_ids),
      'checkpoint_days', b.checkpoint_days,
      'checkpoint_semantics', 'UTC calendar date, lifetime-cumulative snapshot',
      'final_read_not_before', b.final_read_not_before,
      'query_executed_at', clock_timestamp(),
      'treatment_provenance_available', false,
      'primary_sample', 'Aries scheduled-feed/dispatch lineage with checkpoint row'
    )
    FROM bounds b
  ),
  'read_gate', (
    SELECT jsonb_build_object(
      'last_checkpoint_day_closed', g.last_checkpoint_day_closed,
      'frozen_sets_nonempty', g.frozen_sets_nonempty,
      'every_platform_has_frozen_account', g.every_platform_has_frozen_account,
      'no_current_account_drift', g.no_current_account_drift,
      'every_frozen_account_latest_post_close_sync_ok',
        g.every_frozen_account_latest_post_close_sync_ok,
      'all_pass',
        g.last_checkpoint_day_closed
        AND g.frozen_sets_nonempty
        AND g.every_platform_has_frozen_account
        AND g.no_current_account_drift
        AND g.every_frozen_account_latest_post_close_sync_ok
    )
    FROM read_gate g
  ),
  'accounts', COALESCE(
    (
      SELECT jsonb_agg(
        jsonb_build_object(
          'account_id', a.account_id,
          'account_exists', a.account_exists,
          'current_platform', a.current_platform,
          'disabled_at', a.disabled_at,
          'last_sync_at', a.last_sync_at,
          'identity_matches_contract', a.identity_matches_contract
        )
        ORDER BY a.account_id
      )
      FROM frozen_accounts a
    ),
    '[]'::jsonb
  ),
  'unfrozen_current_active_accounts', COALESCE(
    (
      SELECT jsonb_agg(
        jsonb_build_object('account_id', account_id, 'platform', platform)
        ORDER BY platform, account_id
      )
      FROM unfrozen_active_accounts
    ),
    '[]'::jsonb
  ),
  'sync_coverage', COALESCE(
    (
      SELECT jsonb_agg(
        jsonb_build_object(
          'account_id', account_id,
          'platform', current_platform,
          'latest_post_close_sync_run_id', latest_sync_run_id,
          'latest_post_close_sync_status', latest_sync_status,
          'latest_post_close_sync_finished_at', latest_sync_finished_at
        )
        ORDER BY account_id
      )
      FROM sync_state
    ),
    '[]'::jsonb
  ),
  'summary', COALESCE(
    (
      SELECT jsonb_agg(to_jsonb(s) ORDER BY s.platform,
        CASE s.period WHEN 'pre' THEN 1 ELSE 2 END)
      FROM summary s
    ),
    '[]'::jsonb
  ),
  'posts', COALESCE(
    (
      SELECT jsonb_agg(
        jsonb_build_object(
          'period', r.period,
          'post_id', r.post_id,
          'account_id', r.account_id,
          'platform', r.platform,
          'media_type', r.media_type,
          'published_at', r.published_at,
          'publish_utc_date', r.publish_utc_date,
          'expected_checkpoint_date', r.expected_checkpoint_date,
          'checkpoint_close_age_hours', ROUND(r.checkpoint_close_age_hours::numeric, 4),
          'metrics_date', r.metrics_date,
          'aries_scheduled_feed_lineage', r.aries_scheduled_feed_lineage,
          'treatment_provenance_available', false,
          'override_used', r.override_used,
          'analysis_included', r.analysis_included,
          'metrics_currently_quarantined', r.metrics_currently_quarantined,
          'engagement', r.engagement,
          'likes', r.likes,
          'comments_count', r.comments_count,
          'shares', r.shares,
          'saves', r.saves,
          'views', r.views,
          'reach', r.reach,
          'provider_views_available', r.provider_views_available,
          'reach_available', r.reach_available,
          'saves_available', r.saves_available
        )
        ORDER BY r.platform, r.period, r.published_at, r.post_id
      )
      FROM post_rows r
    ),
    '[]'::jsonb
  )
) AS tenant_15_posting_time_measurement;
```

Persist the single JSON value exactly as `tenant-15-posting-time-measurement.json`. The result itself produces the exact `E`, windows, treated platforms, frozen account IDs and current state, sync gate, platform-period denominators and coverage, and bounded post-level sample. Also record the database/environment identifier and query-tool execution reference outside the file; those are execution-context facts, not database columns.

## Reproducible uncertainty calculation

Run the repository helper against the exact saved JSON:

```text
python docs/plans/tenant-15-posting-time-bootstrap.py \
  tenant-15-posting-time-measurement.json \
  --output tenant-15-posting-time-bootstrap.json
```

The helper is `docs/plans/tenant-15-posting-time-bootstrap.py` and uses only the Python 3.11 standard library. Its fixed method is:

- Statistic: **absolute** change in platform median post engagement, `median(post) - median(pre)`. Report the point relative change `(post - pre) / pre` separately.
- Unit: one unique `insights_posts.id` post.
- Strata: platform, period, frozen account ID, and media type. The helper resamples with replacement inside every account/media stratum, preserving each observed stratum size, and combines strata before each platform-period median.
- Sample: only rows where `analysis_included = true` and engagement is numeric. Missing engagement is excluded; measured zero is retained. A duplicate `post_id` is an error.
- Resamples: exactly `10,000` with Python `random.Random(20260819)`.
- Interval: two-sided 95% percentile interval for the absolute median change, with linear quantiles at `(n - 1) * p` for `p = 0.025` and `0.975`.
- Zero pre median: relative change is `NULL`; the platform cannot be success or failure on a relative threshold and is inconclusive.
- Wide interval: `(upper - lower) / max(abs(pre_median), 1) > 0.50`. This numeric rule is an uncertainty gate, not a probability that the feature caused the result.

Retain the helper SHA-256, Python version, input/output SHA-256 values, command, and unedited output with the evidence.

## Metric calculations and comparability

All calculations are platform-specific; never pool platforms.

1. Primary: median `engagement` among `analysis_included` posts.
2. `comments_per_measured_post` and `shares_per_measured_post`: component sum divided by `measured_posts`. A measured component zero is valid. A missing checkpoint post is outside both numerator and denominator, not zero.
3. `saves_per_available_post`: saves sum divided by `posts_with_saves`; never divide by all posts and never replace unavailable saves with zero for this guardrail.
4. Reach/views engagement rates: engagement sum and reach/views sum use the same rows where that denominator is available. The JSON returns both numerator-bearing engagement values and exact denominator sums.
5. Availability coverage: `posts_with_metric / measured_posts` for reach, provider views, or saves.
6. A metric is **comparable-available** only when coverage is at least 80% in both windows and the absolute pre/post coverage gap is at most 10 percentage points.
7. A metric is **consistently unavailable** only when coverage is below 80% in both windows and the gap is at most 10 points. Report it as `N/A`; do not score it.
8. Every other availability pattern is a material denominator change and makes the platform inconclusive.
9. For the same-denominator engagement-rate and exposure guardrails, use reach when reach is comparable-available; otherwise use provider views when views are comparable-available. If neither qualifies, the platform is inconclusive. Never use reach for one period and views for the other.
10. Saves is scored only when comparable-available. If consistently unavailable it is `N/A`; otherwise its availability change makes the platform inconclusive.
11. Media-type share is `lineaged posts of a media type / all lineaged posts` in that platform-period. A change greater than 20 percentage points in any type is a material mix confounder.
12. `checkpoint_snapshot_coverage_pct` is measured lineage posts divided by all Aries scheduled-feed lineage posts. `aries_lineage_coverage_pct` is lineaged posts divided by all frozen-account/platform feed-equivalent candidate posts. Both denominators are returned even when zero.

For every metric change, report the absolute difference and relative difference. Relative difference is undefined when the pre value is zero. For a non-primary decline guardrail with pre zero, a nonnegative post value is not a decline, but the relative value remains labeled undefined.

## Ordered, mutually exclusive evaluation

Apply these steps in order. Stop at the first terminal step. “Platform” below means every member of the frozen treated-platform array; a missing summary row, zero-platform set, or platform with no frozen account cannot disappear from evaluation.

### Step 1 — data-validity or material-confounder gate: Inconclusive

Classify the whole result **Inconclusive** before looking at performance thresholds if any of these is true:

- `read_gate.all_pass` is not exactly `true`;
- the runtime-filled query differs from the independently verified `E`, treated platform array, or frozen account array;
- any treated platform has fewer than 8 `measured_posts` in either window;
- any treated platform has checkpoint snapshot coverage below 80% in either window;
- any treated platform has Aries lineage coverage below 80% in either window or its pre/post lineage coverage differs by more than 10 percentage points;
- any treated platform's median `checkpoint_close_age_hours` differs by more than 2.0 hours between windows;
- any media-type share differs by more than 20 percentage points;
- reach/views availability cannot select one comparable-available denominator under the rules above;
- reach, views, or saves has a material availability pattern under rules 6-10;
- any measured post is currently metrics-quarantined, or the execution evidence records an unresolved reconnect, sync gap, platform incident, holiday/promotion, major content-quality change, audience discontinuity, algorithm change, or other material confounder;
- any bootstrap result is not `status = 'ok'`, has a wide interval, or has pre median zero.

This precedence is intentional: a numerical failure threshold plus a material confounder is **Inconclusive**, not Failure. Record the adverse number, but do not attribute it.

The unavailable schedule-time treatment provenance is always a material limitation on causal interpretation. It does not prevent applying this explicitly observational classifier after all gates above pass, but it prevents calling the result a feature effect or using it alone to justify cross-tenant expansion.

### Step 2 — Failure

After Step 1 passes, classify the whole result **Failure** if **any** treated platform meets at least one condition:

- primary relative median engagement change is `<= -10%`;
- selected same-denominator median reach/views per available post declines by more than 20%;
- comments per measured post declines by more than 20%;
- shares per measured post declines by more than 20%; or
- saves per available post declines by more than 20% when saves is comparable-available.

A platform meeting a failure threshold and another meeting success thresholds is Failure. This resolves platform disagreement conservatively rather than overlapping Failure and Inconclusive.

### Step 3 — Success

After Steps 1 and 2 pass, classify the whole result **Success** only if **every** treated platform satisfies all of these:

- primary relative median engagement change is `>= +10%`;
- the 95% absolute-change bootstrap interval lower bound is greater than `0`;
- selected same-denominator engagements per 100 reached/views declines by no more than 5%;
- selected same-denominator median reach/views per available post declines by no more than 20%;
- comments per measured post declines by no more than 20%;
- shares per measured post declines by no more than 20%; and
- saves per available post declines by no more than 20% when saves is comparable-available; consistently unavailable saves is explicitly `N/A`.

Because the platform grid contains every frozen treated platform and Step 1 requires data for each, an empty or unmeasured platform cannot make `every` vacuously true.

### Step 4 — Inconclusive

Every remaining result is **Inconclusive**. This includes primary changes between `-10%` and `+10%`, positive results whose interval includes zero, platforms that differ without any platform crossing a failure threshold, and guardrail changes that miss Success but do not cross Failure.

## Observation, interpretation, hypothesis, and recommendation

### Observation

Report, without causal language:

- exact `E`, pre/post windows, final-read time, frozen platforms, and frozen accounts;
- account/sync/read gates and every sample, lineage, checkpoint, reach, views, and saves denominator/coverage count;
- post-level engagement sample and deterministic bootstrap output;
- platform-level primary, component, selected same-denominator, availability, media-mix, and checkpoint-age results; and
- the first evaluation step that determined the mutually exclusive class.

### Interpretation

A four-week before/after comparison remains vulnerable to seasonality, promotions, holidays, content quality, audience growth, posting volume, platform algorithms, regression to the mean, correlated posts, and the schedule-time provenance and calendar-date age limitations described above. Account/media stratification improves uncertainty bookkeeping; it does not randomize treatment or prove independence.

### Hypothesis

Tenant-specific posting-time overrides are associated with higher day-7-calendar-checkpoint engagement among tenant 15's override-eligible Aries feed posts than the immediately preceding four weeks.

This is a hypothesis. The contract cannot estimate adherence or identify a causal effect without schedule-time provenance.

### Recommendation boundary

- Before `E`: a fresh independent verifier must accept the filled freeze procedure and this contract. No connector invocation is part of the measurement.
- At/after `E`: preserve the freeze JSON and immutable filled query; keep enablement bounded to tenant 15.
- Final read: wait for `final_read_not_before`, successful post-close syncs, and the coverage check; do not rely on an arbitrary `E + 35 days` timestamp.
- After measurement: submit the freeze JSON, measurement JSON, bootstrap JSON, hashes, source refs, execution refs, calculations, and material unknowns to `growth-verifier`.
- A threshold Success is only an observational rollout signal. Given missing treatment provenance, the next evidence-supported decision is whether to keep tenant 15 running while adding the minimal immutable schedule-time provenance and collecting a provenance-confirmed cohort. This result alone does not support cross-tenant expansion.
