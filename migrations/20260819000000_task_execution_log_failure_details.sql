-- Preserve the concrete failure behind Hermes invocation errors (for example
-- ENOENT / ECONNREFUSED) without changing the existing task outcome contract.
ALTER TABLE task_execution_log
  ADD COLUMN IF NOT EXISTS error_class TEXT;

ALTER TABLE task_execution_log
  ADD COLUMN IF NOT EXISTS error_message TEXT;

COMMENT ON COLUMN task_execution_log.cost_cents IS
  'Estimated execution cost in cents; NULL when no trustworthy estimate is available.';
