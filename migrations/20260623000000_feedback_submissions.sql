-- feedback_submissions: in-app feedback button capture
-- (docs/plans/2026-06-19-feedback-submission-button.md, Aries Dev Meeting 2026-06-19).
--
-- One row per submission. This table is the DURABLE record + idempotency ledger
-- that backs the "never silently drop a submission" requirement (spec §9): the
-- API writes here first, then mirrors the row into the centralized Google Sheet
-- via Composio. `sheet_sync_status` tracks whether the Sheet mirror succeeded so
-- failed writes can be retried without duplicating (upsert keyed by
-- submission_id).
--
-- tenant_id is TEXT, NOT an FK to organizations(id), on purpose:
--   * unauthenticated users must be able to file feedback (they store the
--     literal 'unauthenticated') — that's the whole point of the feature, since
--     the reported bugs include people who can't log in;
--   * feedback is an append-only audit log that must outlive tenant deletion.
-- When a tenant is present, tenant_id holds organizations.id rendered as text.
--
-- screenshot_bytes holds the optional attached image so a working "Screenshot
-- link" exists even before Drive is wired (served at /api/feedback/screenshot/:id);
-- screenshot_link is overwritten with the Drive URL once the Composio Drive
-- upload succeeds.
--
-- Applied via scripts/init-db.js on fresh DBs; run this file manually on
-- existing deployments. Additive + idempotent (CREATE ... IF NOT EXISTS).
-- Reverse: DROP TABLE feedback_submissions;

CREATE TABLE IF NOT EXISTS feedback_submissions (
  id BIGSERIAL PRIMARY KEY,
  -- Client-generated unique reference (e.g. fb_001a2b). Stable across retries so
  -- re-submitting the same feedback upserts instead of duplicating.
  submission_id TEXT UNIQUE NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'unauthenticated',
  auth_state TEXT NOT NULL DEFAULT 'unauthenticated',
  user_id TEXT,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  comment TEXT NOT NULL,
  page_url TEXT,
  user_agent TEXT,
  viewport TEXT,
  console_errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  environment TEXT NOT NULL DEFAULT 'unknown',
  -- SHA-256 of the submitter IP (never the raw IP) for per-origin rate limiting.
  ip_hash TEXT,
  -- Optional attached screenshot, stored durably so a link always resolves.
  screenshot_bytes BYTEA,
  screenshot_mime TEXT,
  -- Final image link written into the Sheet row (Drive URL when synced, else the
  -- app-served fallback URL).
  screenshot_link TEXT,
  -- Sheet mirror status: 'pending' (not yet written), 'synced', 'skipped'
  -- (Composio not configured), or 'failed' (last attempt errored).
  sheet_sync_status TEXT NOT NULL DEFAULT 'pending',
  sheet_sync_error TEXT,
  sheet_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Triage queries scan by recency and by sync status (retry sweep of pending/failed).
CREATE INDEX IF NOT EXISTS idx_feedback_submissions_created_at
  ON feedback_submissions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_submissions_sync_status
  ON feedback_submissions (sheet_sync_status);
CREATE INDEX IF NOT EXISTS idx_feedback_submissions_tenant
  ON feedback_submissions (tenant_id);
-- Rate-limit sweep: recent rows per origin.
CREATE INDEX IF NOT EXISTS idx_feedback_submissions_ip_hash_created
  ON feedback_submissions (ip_hash, created_at DESC);
