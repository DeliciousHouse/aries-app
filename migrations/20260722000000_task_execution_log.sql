-- AA-159: classify task processing engine (AI vs automated vs local).
-- AA-158: capture granular token + timing telemetry on the same row.
--
-- One append-only row per task execution so cost analysis can separate paid AI
-- inference from zero-cost deterministic automation and local/edge compute, and
-- attribute token consumption + latency per company, user, and task.
--
--   AI_LLM             -> work run by a model behind the Hermes gateway.
--   DETERMINISTIC_RULE -> rule-based automation (sidecar sweeps, dispatchers).
--   LOCAL_EDGE         -> in-process CPU work (sharp compositing, ffmpeg).
--
-- Token/cost columns are a hard 0 on the two zero-cost engines (by
-- construction) and NULL on AI rows until the gateway reports usage — NULL
-- means "not reported", never "free". Hermes does not report token usage or the
-- resolved model back to Aries yet; the optional `usage` block on the callback
-- protocol is the receiving half, and these columns fill in the moment Hermes
-- emits it.
--
-- user_id is nullable and is NULL on the majority of rows BY DESIGN — the
-- weekly cron, every sidecar, the reconciler, and all Hermes callbacks are
-- userless; only an operator-initiated route task carries one. task_id is the
-- per-EXECUTION id (aries_run_id / job id / generated uuid), as opposed to
-- task_key which is the task TYPE.
--
-- Mirrors scripts/init-db.js (applied on container start); this file is the
-- record for databases that are migrated rather than initialized.

CREATE TABLE IF NOT EXISTS task_execution_log (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         INTEGER,
  user_id           INTEGER,
  task_id           TEXT,
  execution_engine  TEXT NOT NULL
    CHECK (execution_engine IN ('AI_LLM','DETERMINISTIC_RULE','LOCAL_EDGE')),
  task_key          TEXT NOT NULL,
  -- 'retry' marks a non-terminal attempt that will be retried, so its token
  -- usage is counted separately from the attempt that finally settles.
  status            TEXT NOT NULL CHECK (status IN ('succeeded','failed','retry')),
  attempt_number    INTEGER NOT NULL DEFAULT 1,
  error_code        TEXT,
  duration_ms       INTEGER,
  cpu_ms            INTEGER,
  model_requested   TEXT,
  model_reported    TEXT,
  target_profile    TEXT,
  external_run_id   TEXT,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  total_tokens      INTEGER,
  cost_cents        NUMERIC(10,4),
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  end_time          TIMESTAMPTZ,
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_task_execution_log_tenant_started
  ON task_execution_log (tenant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_execution_log_engine_started
  ON task_execution_log (execution_engine, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_execution_log_user_started
  ON task_execution_log (user_id, started_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_task_execution_log_task_id
  ON task_execution_log (task_id) WHERE task_id IS NOT NULL;
