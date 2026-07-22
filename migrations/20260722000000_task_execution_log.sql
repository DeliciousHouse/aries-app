-- AA-159: classify task processing engine (AI vs automated vs local).
--
-- One append-only row per classified task execution so cost analysis can
-- separate paid AI inference from zero-cost deterministic automation and
-- local/edge compute.
--
--   AI_LLM             -> work run by a model behind the Hermes gateway.
--   DETERMINISTIC_RULE -> rule-based automation (sidecar sweeps, dispatchers).
--   LOCAL_EDGE         -> in-process CPU work (sharp compositing, ffmpeg).
--
-- Token/cost columns are a hard 0 on the two zero-cost engines (by
-- construction) and NULL on AI rows until the gateway reports usage — NULL
-- means "not reported", never "free".
--
-- Mirrors scripts/init-db.js (applied on container start); this file is the
-- record for databases that are migrated rather than initialized.

CREATE TABLE IF NOT EXISTS task_execution_log (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        INTEGER,
  execution_engine TEXT NOT NULL
    CHECK (execution_engine IN ('AI_LLM','DETERMINISTIC_RULE','LOCAL_EDGE')),
  task_key         TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('succeeded','failed')),
  error_code       TEXT,
  duration_ms      INTEGER,
  cpu_ms           INTEGER,
  model_requested  TEXT,
  model_reported   TEXT,
  target_profile   TEXT,
  external_run_id  TEXT,
  input_tokens     INTEGER,
  output_tokens    INTEGER,
  cost_cents       NUMERIC(10,4),
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_task_execution_log_tenant_started
  ON task_execution_log (tenant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_execution_log_engine_started
  ON task_execution_log (execution_engine, started_at DESC);
