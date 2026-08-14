-- Optional pathname-only route context for durable feedback triage.
-- Existing rows remain valid with NULL; the submit validator enforces the
-- leading slash, 512-character bound, and absence of origin/query/hash data.
ALTER TABLE feedback_reports
  ADD COLUMN IF NOT EXISTS page_path TEXT;
