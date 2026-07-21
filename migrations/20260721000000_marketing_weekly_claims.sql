-- In-flight claim marker for the weekly-content trigger worker.
--
-- 2026-07-20 incident: the worker's claim-then-revert design stamped
-- marketing_schedule.last_triggered_at, then the submit POST hung (wedged
-- Hermes gateway) and the process died before the revert ran — the claim
-- stayed stamped and the entire week of content silently skipped.
--
-- The worker now writes this marker atomically WITH the claim (single CTE
-- statement) and deletes it on every concluded outcome (success, deliberate
-- gate-skip, failure-revert). A marker older than the stale window therefore
-- proves a stranded attempt; the worker's per-tick heal arm reverts that claim
-- so the tenant is due again immediately.
--
-- The worker also self-provisions this table at startup
-- (scripts/automations/weekly-job-trigger-worker.ts ENSURE_CLAIMS_TABLE_SQL —
-- keep in sync) because prod may run with ARIES_SKIP_DB_INIT=1.

CREATE TABLE IF NOT EXISTS marketing_weekly_claims (
  tenant_id INTEGER PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  prior_last_triggered_at TIMESTAMPTZ
);
