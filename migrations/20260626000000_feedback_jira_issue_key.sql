-- The in-app feedback button now mirrors each submission to JIRA (project AA,
-- "Aries AI") instead of a Google Sheet. Record the created issue key on the
-- durable row so an operator can trace a submission to its JIRA issue without a
-- round-trip. Idempotent; safe to re-run.

ALTER TABLE feedback_submissions ADD COLUMN IF NOT EXISTS jira_issue_key TEXT;
