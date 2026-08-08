BEGIN;

ALTER TABLE scheduled_posts
  ADD COLUMN IF NOT EXISTS failure_class TEXT,
  ADD COLUMN IF NOT EXISTS dead_lettered_at TIMESTAMPTZ;

ALTER TABLE scheduled_posts
  DROP CONSTRAINT IF EXISTS scheduled_posts_dispatch_status_check;
ALTER TABLE scheduled_posts
  ADD CONSTRAINT scheduled_posts_dispatch_status_check
  CHECK (dispatch_status IN ('pending','in_flight','dispatched','failed','dead_letter','manual_reconciliation'));

ALTER TABLE scheduled_post_dispatches
  ADD COLUMN IF NOT EXISTS failure_class TEXT,
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dead_lettered_at TIMESTAMPTZ;

ALTER TABLE scheduled_post_dispatches
  DROP CONSTRAINT IF EXISTS scheduled_post_dispatches_status_check;
ALTER TABLE scheduled_post_dispatches
  ADD CONSTRAINT scheduled_post_dispatches_status_check
  CHECK (status IN ('pending','in_flight','dispatched','failed','dead_letter','manual_reconciliation'));

CREATE INDEX IF NOT EXISTS idx_scheduled_post_dispatches_dead_letter
  ON scheduled_post_dispatches (dead_lettered_at DESC)
  WHERE status = 'dead_letter';

COMMIT;
