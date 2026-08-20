-- Weekly per-tenant engagement trends materialized from the latest cumulative
-- post-metric snapshots for two adjacent completed UTC weeks.
CREATE TABLE IF NOT EXISTS insights_engagement_trends_weekly (
  tenant_id          INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  week_start         DATE NOT NULL,
  current_post_count INTEGER NOT NULL CHECK (current_post_count >= 0),
  previous_post_count INTEGER NOT NULL CHECK (previous_post_count >= 0),
  current_average    NUMERIC(14,4),
  previous_average   NUMERIC(14,4),
  change_percent     NUMERIC(12,4),
  direction          TEXT NOT NULL CHECK (direction IN ('upward', 'downward', 'flat', 'insufficient_data')),
  computed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, week_start)
);
