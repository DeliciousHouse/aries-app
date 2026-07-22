-- Anonymous public incident reports (owner decision 2026-07-20).
-- Existing rows were session-authenticated and retain that attribution via the
-- default; new anonymous rows are explicit so retry-worker Jira delivery can
-- label them without inferring identity from a synthetic submitter id.

ALTER TABLE feedback_reports
  ADD COLUMN IF NOT EXISTS submitter_type TEXT NOT NULL DEFAULT 'authenticated'
    CHECK (submitter_type IN ('authenticated','anonymous'));
