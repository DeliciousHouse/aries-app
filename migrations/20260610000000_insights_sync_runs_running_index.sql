-- Partial index for the insights stranded-run sweep.
--
-- backend/insights/sync/sweep-stranded-runs.ts (run at the top of every
-- insights-sync worker tick) executes:
--   UPDATE insights_sync_runs SET status='failed', ...
--   WHERE status = 'running' AND started_at < now() - make_interval(mins => $1)
--
-- The only pre-existing index, idx_insights_sync_runs_tenant_platform_started
-- (tenant_id, platform, started_at DESC), cannot serve a status+started_at
-- predicate, so without this index every 30-minute sweep tick seq-scans an
-- append-only audit table that grows ~one row per account per platform per
-- 30-minute sync tick, forever.
--
-- Partial on status='running' keeps the index near-empty: rows are 'running'
-- only while a sync is in flight (or stranded, which the sweep then clears).
--
-- This file is the migrations/ record; scripts/init-db.js carries the same
-- idempotent CREATE INDEX so it reaches existing databases on container start.
--
-- Additive + idempotent. Safe on a populated table (index build, no rewrite).
-- Reverse:
--   DROP INDEX IF EXISTS idx_insights_sync_runs_running_started;

CREATE INDEX IF NOT EXISTS idx_insights_sync_runs_running_started
  ON insights_sync_runs (started_at) WHERE status = 'running';
