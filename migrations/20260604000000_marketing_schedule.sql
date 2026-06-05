-- Weekly trigger schedule: one row per tenant that opts into the weekly-content
-- cadence. Drained by scripts/automations/weekly-job-trigger-worker.ts, which
-- atomically claims due rows and starts a weekly_social_content job for each.
--
-- NOTE: the source of truth applied at container start is scripts/init-db.js.
-- This migration mirrors that table so the schema change is recorded under
-- migrations/ too; migrations/-only files do NOT run in prod (init-db.js does).
CREATE TABLE IF NOT EXISTS marketing_schedule (
  tenant_id INTEGER PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  cadence TEXT NOT NULL DEFAULT 'weekly' CHECK (cadence IN ('weekly')),
  day_of_week INTEGER NOT NULL DEFAULT 1 CHECK (day_of_week BETWEEN 0 AND 6),
  hour INTEGER NOT NULL DEFAULT 9 CHECK (hour BETWEEN 0 AND 23),
  timezone TEXT,
  enabled BOOLEAN NOT NULL DEFAULT false,
  last_triggered_at TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_marketing_schedule_enabled
  ON marketing_schedule (enabled) WHERE enabled;
