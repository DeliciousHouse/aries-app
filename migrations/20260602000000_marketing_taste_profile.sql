-- marketing_taste_profile + marketing_taste_signal: onboarding first-post
-- variant-board taste learning (docs/plans/2026-06-02-onboarding-variant-board.md).
--
-- marketing_taste_profile is the per-user rolled-up taste vector (one row per
-- tenant+user). `dimensions` is an opaque jsonb map of taste dimensions ->
-- per-value counters; confidence and 5%/week decay are computed at READ time in
-- backend/marketing/taste-profile-store.ts, so the stored row only changes on a
-- write (no read-time churn). marketing_taste_signal is the append-only event
-- log of every pick/rate/edit, for auditability + Honcho replay.
--
-- tenant_id INTEGER / user_id INTEGER match organizations.id + users.id (both
-- SERIAL = int4) -- do NOT use BIGINT (see fix 096c30a on the insights_* tables).
--
-- Applied via scripts/init-db.js on fresh DBs; run this file manually on
-- existing deployments. Additive + idempotent (CREATE ... IF NOT EXISTS).
-- Reverse: DROP TABLE marketing_taste_signal; DROP TABLE marketing_taste_profile;

CREATE TABLE IF NOT EXISTS marketing_taste_profile (
  tenant_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dimensions JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

-- Append-only event log: one row per pick/rate/edit signal on a variant.
CREATE TABLE IF NOT EXISTS marketing_taste_signal (
  id BIGSERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  variant_batch_id TEXT NOT NULL,
  slot_index INT NOT NULL DEFAULT 0,
  variant_id TEXT NOT NULL,
  picked BOOLEAN NOT NULL DEFAULT FALSE,
  rating INT,
  edit_ops JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT marketing_taste_signal_rating_range CHECK (rating IS NULL OR rating BETWEEN 1 AND 5)
);

CREATE INDEX IF NOT EXISTS idx_marketing_taste_signal_tenant_user
  ON marketing_taste_signal (tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_marketing_taste_signal_batch
  ON marketing_taste_signal (variant_batch_id);
CREATE INDEX IF NOT EXISTS idx_marketing_taste_signal_tenant_user_created
  ON marketing_taste_signal (tenant_id, user_id, created_at DESC);
