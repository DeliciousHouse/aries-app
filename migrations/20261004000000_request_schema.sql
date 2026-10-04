-- Remove on-demand schema mutation from sign-in, onboarding and research.
-- Mirrored in scripts/init-db.js (the deployment schema path).
-- Feedback tables/upgrades already have dedicated migrations and db:init DDL.
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_required BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS onboarding_memory_seeded_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS early_access_signups (
  id BIGSERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  source TEXT NOT NULL DEFAULT 'website',
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS aries_research_jobs (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  task_spec JSONB NOT NULL DEFAULT '{}',
  callback_token_hash TEXT NOT NULL,
  hermes_envelope JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS aries_research_findings (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES aries_research_jobs(id) ON DELETE CASCADE,
  raw JSONB NOT NULL,
  curator_decision TEXT NOT NULL,
  peer TEXT,
  approved_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_aries_research_jobs_tenant_id ON aries_research_jobs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_aries_research_findings_job_id ON aries_research_findings(job_id);
