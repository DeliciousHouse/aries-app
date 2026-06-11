-- Phase 4 PR2: OUTBOUND Slack notification dedupe.
--
-- The marketing Hermes callback is re-delivered by the reconciler under a
-- different event_id than the original poll-bridge delivery. Outbound Slack
-- notifications therefore dedupe on a STABLE identity (e.g.
-- approval:<jobId>:<stage>) rather than the per-delivery approval id, via
-- INSERT ... ON CONFLICT DO NOTHING — only the first delivery for a given key
-- posts to the channel.
--
-- Additive + idempotent; mirrors the inbound slack_event_ids table from PR1.
-- Applied on container start by scripts/init-db.js; this file is the migration
-- of record.

CREATE TABLE IF NOT EXISTS slack_notifications (
  dedup_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  tenant_id INTEGER,
  marketing_job_id TEXT,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_slack_notifications_sent_at
  ON slack_notifications (sent_at);
