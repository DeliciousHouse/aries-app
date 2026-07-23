-- AA-167: durable Jira create/attachment state for crash-safe reconciliation.
-- A create fence is committed before Jira network I/O. Ambiguous creates are
-- reconciled by label and never blindly repeated after one stale search miss.
-- Screenshots are private Aries records and are not copied to Jira.

ALTER TABLE feedback_reports
  ADD COLUMN IF NOT EXISTS jira_create_state TEXT NOT NULL DEFAULT 'not_started'
    CHECK (jira_create_state IN ('not_started','in_flight','uncertain','completed')),
  ADD COLUMN IF NOT EXISTS jira_create_token TEXT,
  ADD COLUMN IF NOT EXISTS attachment_state TEXT NOT NULL DEFAULT 'none'
    CHECK (attachment_state IN ('none','in_flight','uncertain','completed','retained_private'));

UPDATE feedback_reports
   SET attachment_state = 'retained_private'
 WHERE screenshot_bytes IS NOT NULL
   AND attachment_state = 'none';
