-- Preserve explicit clears and distinguish operator settings from enrichment.
ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS operator_updated BOOLEAN NOT NULL DEFAULT false;
-- Additional onboarding profile fields survive the pre-auth handoff.
ALTER TABLE onboarding_drafts ADD COLUMN IF NOT EXISTS profile_context JSONB NOT NULL DEFAULT '{}'::jsonb;
