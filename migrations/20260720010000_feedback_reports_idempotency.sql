-- Stable browser-to-Jira idempotency for public incident reports.
-- Existing rows predate client keys and receive an empty legacy marker; every
-- new submission writes a SHA-256 fingerprint of its normalized durable
-- payload so key reuse can be bound to the original submitter and content even
-- after screenshot bytes are discarded on successful Jira sync.

ALTER TABLE feedback_reports
  ADD COLUMN IF NOT EXISTS request_fingerprint TEXT NOT NULL DEFAULT '';
