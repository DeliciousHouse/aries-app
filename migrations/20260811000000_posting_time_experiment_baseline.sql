-- Tenant-15 AI posting-time canary: immutable four-week pre-rollout evidence.
-- The advisor inserts exactly once before its first derivation. Post-rollout
-- engagement remains in insights_post_metrics_daily and is compared over the
-- four weeks beginning at enabled_at.
--
-- NOTE: scripts/init-db.js is the production schema source; keep it in sync.
CREATE TABLE IF NOT EXISTS marketing_posting_time_experiments (
  tenant_id INTEGER PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  enabled_at DATE NOT NULL,
  baseline_start DATE NOT NULL,
  baseline_end DATE NOT NULL,
  baseline_posts INTEGER NOT NULL DEFAULT 0,
  baseline_engagements BIGINT NOT NULL DEFAULT 0,
  baseline_impressions BIGINT NOT NULL DEFAULT 0,
  baseline_engagement_rate NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (baseline_end >= baseline_start)
);
