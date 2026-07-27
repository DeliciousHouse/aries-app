-- AA-161: usage time-series aggregation + retention layer over task_execution_log.
--
-- The raw usage event table already exists: `task_execution_log` (AA-159 raw
-- rows + AA-158 token/timing/attribution columns). This migration adds ONLY the
-- aggregation and retention layer on top of it — it does not create a second raw
-- table, which would split billing across two write paths.
--
-- Vocabulary map (the ticket's names -> this schema's names):
--   usage_events -> task_execution_log (aliased read-only by the view below)
--   company_id   -> tenant_id  (-> organizations)
--   created_at   -> started_at (the event's own time axis; every raw index uses it)
--
-- Shape: rollup TABLES refreshed incrementally, not MATERIALIZED VIEWs. An MV can
-- only be refreshed whole (a full rescan of a high-volume log every refresh, and
-- REFRESH CONCURRENTLY additionally needs a unique index), and — decisive here —
-- an MV is DESTROYED by the 90-day raw purge, while this ticket requires daily
-- aggregates kept indefinitely. Real tables survive their source rows.
--
-- Retention strategy (AC 3):
--   task_execution_log   -> ARIES_USAGE_RAW_RETENTION_DAYS      (default 90)
--   usage_rollup_hourly  -> ARIES_USAGE_HOURLY_RETENTION_DAYS   (default 400)
--   usage_rollup_daily   -> kept indefinitely (never swept)
--   usage_rollup_monthly -> kept indefinitely (never swept)
-- The sweep never deletes a raw row that has not been rolled up: its cutoff is
-- min(now - retention, watermark - reroll overlap). See backend/telemetry/usage-retention.ts.
--
-- Mirrors scripts/init-db.js (applied on container start); this file is the
-- record for databases that are migrated rather than initialized.

-- ---------------------------------------------------------------------------
-- Raw-table indexes for the AC-2 filter set
-- ---------------------------------------------------------------------------
-- tenant_id / execution_engine / user_id / started_at each already have a
-- single-axis index (AA-159/158). The two below are what the billing and rollup
-- access patterns actually need and neither existing index serves:
--   (tenant_id, execution_engine, started_at) — "this company's AI spend for the
--     billing period", the primary billing query. Leading tenant_id also serves
--     the tenant-only prefix, so it does not duplicate the existing pair.
--   (started_at) — the pure time-range scan the hourly rollup and the retention
--     delete both run across ALL tenants, where a tenant-leading index is useless.
CREATE INDEX IF NOT EXISTS idx_task_execution_log_tenant_engine_started
  ON task_execution_log (tenant_id, execution_engine, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_execution_log_started_at
  ON task_execution_log (started_at);

-- ---------------------------------------------------------------------------
-- Rollup grain
-- ---------------------------------------------------------------------------
-- Every rollup carries the same key: bucket + tenant + user + engine + task_key.
--
-- tenant_id/user_id are NOT NULL here even though both are nullable on the raw
-- row, because a NULL inside a PRIMARY KEY would make the UPSERT non-idempotent
-- (NULL <> NULL, so every pass would insert a duplicate userless row rather than
-- updating one). They are COALESCEd to the sentinel 0 — the id sequences start at
-- 1, so 0 can never collide with a real organization or user. 0 means
-- "not scoped": system sweeps have no tenant, and the weekly cron, every sidecar,
-- the reconciler and all Hermes callbacks are userless BY DESIGN.
--
-- Token columns stay NULLable and are SUMmed (SUM skips NULLs). NULL means
-- "not reported" — Hermes does not report usage back to Aries yet — never "free".
-- ai_events vs ai_events_with_usage is the honesty pair that keeps a $0 report
-- from being read as "no spend": it is the denominator saying how much of the AI
-- work in this bucket actually reported its usage.

CREATE TABLE IF NOT EXISTS usage_rollup_hourly (
  bucket_start         TIMESTAMPTZ NOT NULL,
  tenant_id            INTEGER     NOT NULL,
  user_id              INTEGER     NOT NULL,
  execution_engine     TEXT        NOT NULL,
  task_key             TEXT        NOT NULL,
  events               BIGINT      NOT NULL,
  succeeded            BIGINT      NOT NULL,
  failed               BIGINT      NOT NULL,
  retries              BIGINT      NOT NULL,
  ai_events            BIGINT      NOT NULL,
  ai_events_with_usage BIGINT      NOT NULL,
  prompt_tokens        BIGINT,
  completion_tokens    BIGINT,
  total_tokens         BIGINT,
  cost_cents           NUMERIC(16,4),
  duration_ms_sum      BIGINT,
  cpu_ms_sum           BIGINT,
  first_event_at       TIMESTAMPTZ,
  last_event_at        TIMESTAMPTZ,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket_start, tenant_id, user_id, execution_engine, task_key)
);

CREATE TABLE IF NOT EXISTS usage_rollup_daily (
  bucket_start         TIMESTAMPTZ NOT NULL,
  tenant_id            INTEGER     NOT NULL,
  user_id              INTEGER     NOT NULL,
  execution_engine     TEXT        NOT NULL,
  task_key             TEXT        NOT NULL,
  events               BIGINT      NOT NULL,
  succeeded            BIGINT      NOT NULL,
  failed               BIGINT      NOT NULL,
  retries              BIGINT      NOT NULL,
  ai_events            BIGINT      NOT NULL,
  ai_events_with_usage BIGINT      NOT NULL,
  prompt_tokens        BIGINT,
  completion_tokens    BIGINT,
  total_tokens         BIGINT,
  cost_cents           NUMERIC(16,4),
  duration_ms_sum      BIGINT,
  cpu_ms_sum           BIGINT,
  first_event_at       TIMESTAMPTZ,
  last_event_at        TIMESTAMPTZ,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket_start, tenant_id, user_id, execution_engine, task_key)
);

CREATE TABLE IF NOT EXISTS usage_rollup_monthly (
  bucket_start         TIMESTAMPTZ NOT NULL,
  tenant_id            INTEGER     NOT NULL,
  user_id              INTEGER     NOT NULL,
  execution_engine     TEXT        NOT NULL,
  task_key             TEXT        NOT NULL,
  events               BIGINT      NOT NULL,
  succeeded            BIGINT      NOT NULL,
  failed               BIGINT      NOT NULL,
  retries              BIGINT      NOT NULL,
  ai_events            BIGINT      NOT NULL,
  ai_events_with_usage BIGINT      NOT NULL,
  prompt_tokens        BIGINT,
  completion_tokens    BIGINT,
  total_tokens         BIGINT,
  cost_cents           NUMERIC(16,4),
  duration_ms_sum      BIGINT,
  cpu_ms_sum           BIGINT,
  first_event_at       TIMESTAMPTZ,
  last_event_at        TIMESTAMPTZ,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket_start, tenant_id, user_id, execution_engine, task_key)
);

-- Reporting reads are "one company, one period": the PK's leading bucket_start
-- cannot serve them, so each rollup gets a tenant-leading index. Engine is left
-- out — a single tenant-period slice is small enough to filter in memory.
CREATE INDEX IF NOT EXISTS idx_usage_rollup_hourly_tenant_bucket
  ON usage_rollup_hourly (tenant_id, bucket_start DESC);
CREATE INDEX IF NOT EXISTS idx_usage_rollup_daily_tenant_bucket
  ON usage_rollup_daily (tenant_id, bucket_start DESC);
CREATE INDEX IF NOT EXISTS idx_usage_rollup_monthly_tenant_bucket
  ON usage_rollup_monthly (tenant_id, bucket_start DESC);
-- Serves the per-user billing slice. Partial: user_id is the 0 sentinel on the
-- majority of rows (userless cron/sidecar/callback work), so the index stays
-- small — the same shape as idx_task_execution_log_user_started on the raw table.
CREATE INDEX IF NOT EXISTS idx_usage_rollup_daily_user_bucket
  ON usage_rollup_daily (user_id, bucket_start DESC) WHERE user_id <> 0;

-- ---------------------------------------------------------------------------
-- Watermark
-- ---------------------------------------------------------------------------
-- One row (id='hourly') holding the exclusive upper bound of the last rolled
-- window, so each pass scans only new events instead of the whole log. It is
-- ALSO the retention safety interlock: the purge never deletes a raw row at or
-- above (rolled_through - reroll overlap), so an un-aggregated row can never be
-- destroyed, and a rollup can never be recomputed from rows that are already gone.
CREATE TABLE IF NOT EXISTS usage_rollup_state (
  id             TEXT PRIMARY KEY,
  rolled_through TIMESTAMPTZ NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- usage_events: read-only alias
-- ---------------------------------------------------------------------------
-- The ticket's vocabulary (usage_events / company_id / created_at) resolved onto
-- the real table, so reporting SQL written against the spec runs unchanged
-- without a second raw write path. Read-only by convention: everything writes
-- through backend/telemetry/task-execution-log.ts.
--
-- The column list is EXPLICIT and the two aliases lead. CREATE OR REPLACE VIEW
-- may only APPEND columns, so a future raw-table column is added to the END of
-- this list and the replace still succeeds; `SELECT *` would put it in the middle
-- and break every re-run of this file.
CREATE OR REPLACE VIEW usage_events AS
  SELECT
    tenant_id  AS company_id,
    started_at AS created_at,
    id,
    tenant_id,
    user_id,
    task_id,
    execution_engine,
    task_key,
    status,
    attempt_number,
    error_code,
    duration_ms,
    cpu_ms,
    model_requested,
    model_reported,
    target_profile,
    external_run_id,
    prompt_tokens,
    completion_tokens,
    total_tokens,
    cost_cents,
    started_at,
    end_time,
    recorded_at
  FROM task_execution_log;
