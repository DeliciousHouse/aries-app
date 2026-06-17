-- Adds an authoritative aggregate account-engagement column to
-- insights_account_metrics_daily.
--
-- Facebook's page insights expose a single aggregate engagement metric
-- (page_post_engagements) rather than a like/comment/share breakdown, so the
-- per-component columns are 0 for FB account rows. Writing 0 to the breakdown
-- and computing engagement = likes+comments+shares surfaced a misleading
-- totalEngagement=0 on the dashboard. This column stores the real aggregate;
-- read-api prefers it for the headline engagement and falls back to
-- likes+comments_count+shares when NULL (e.g. platforms with a breakdown).
--
-- Idempotent + safe to re-run. Matches scripts/init-db.js.

ALTER TABLE insights_account_metrics_daily
  ADD COLUMN IF NOT EXISTS engagement BIGINT;
