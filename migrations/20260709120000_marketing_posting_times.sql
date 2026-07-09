-- AI-derived posting times: one row per (tenant, platform) holding the derived
-- time-of-day (and ranked days-of-week) that tenant's posts should publish on
-- that platform. Written by backend/marketing/posting-time-advisor.ts on every
-- content-generation start (ARIES_AI_POSTING_TIMES_ENABLED): from the tenant's
-- own insights engagement once enough posts have metrics (source='analytics'),
-- else from a Hermes research run over the business profile's competitor
-- (source='competitor'). Consumed fail-open by the auto-schedule slot
-- computation (falls back to PLATFORM_POSTING_DEFAULTS when absent).
--
-- NOTE: the source of truth applied at container start is scripts/init-db.js.
-- This migration mirrors that table so the schema change is recorded under
-- migrations/ too; migrations/-only files do NOT run in prod (init-db.js does).

CREATE TABLE IF NOT EXISTS marketing_posting_times (
  tenant_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  hour INTEGER NOT NULL CHECK (hour BETWEEN 0 AND 23),
  minute INTEGER NOT NULL DEFAULT 0 CHECK (minute BETWEEN 0 AND 59),
  days JSONB NOT NULL DEFAULT '[]',
  source TEXT NOT NULL CHECK (source IN ('analytics', 'competitor')),
  sample_size INTEGER,
  rationale TEXT,
  derived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, platform)
);

-- Cross-process derivation claim (mirrors the marketing_schedule
-- conditional-claim idiom): one row per tenant, atomically claimed via
-- INSERT ... ON CONFLICT DO UPDATE ... WHERE claimed_at is older than the
-- claim window. Released unless the competitor research leg failed
-- transiently (then retained as failure backoff). TTL-skipped attempts
-- never claim.
CREATE TABLE IF NOT EXISTS marketing_posting_time_claims (
  tenant_id INTEGER PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
