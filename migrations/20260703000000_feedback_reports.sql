-- Customer incident reports (SC-70 port, AA-51). Distinct from the legacy
-- feedback_submissions table: this is the auth-gated, impact-rated report that
-- files a Jira Bug with retry/idempotency semantics. Screenshot bytes are held
-- on the row only until the Jira sync completes, then NULLed.
-- Canonical schema also ships in scripts/init-db.js (applied on container
-- start); this file is the migration record.

CREATE TABLE IF NOT EXISTS feedback_reports (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  submitter_id TEXT NOT NULL,
  submitter_email TEXT,
  submitter_name TEXT,
  customer_slug TEXT NOT NULL DEFAULT 'unknown',
  category TEXT NOT NULL CHECK (category IN ('bug','question','other')),
  impact TEXT NOT NULL CHECK (impact IN (
    'p0_system_blocked','p1_account_blocked','p2_feature_degraded',
    'p3_minor_glitch','p4_question'
  )),
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  screenshot_bytes BYTEA,
  screenshot_mime VARCHAR(64),
  jira_ticket_key VARCHAR(50),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','synced','pending_retry','failed')),
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Retry sweep claim scan (status + stale-pending window).
CREATE INDEX IF NOT EXISTS idx_feedback_reports_status_updated
  ON feedback_reports (status, updated_at);

-- Per user+tenant rate limit / dedup window.
CREATE INDEX IF NOT EXISTS idx_feedback_reports_tenant_submitter_created
  ON feedback_reports (tenant_id, submitter_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_feedback_reports_ticket_key
  ON feedback_reports (jira_ticket_key);
