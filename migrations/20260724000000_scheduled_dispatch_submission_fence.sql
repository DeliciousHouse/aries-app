BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE scheduled_posts
  ADD COLUMN IF NOT EXISTS dispatch_started_at TIMESTAMPTZ;

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'scheduled_posts'::regclass
       AND conname = 'scheduled_posts_dispatch_status_check'
       AND position('manual_reconciliation' in pg_get_constraintdef(oid)) > 0
  ) THEN
    ALTER TABLE scheduled_posts DROP CONSTRAINT IF EXISTS scheduled_posts_dispatch_status_check;
    ALTER TABLE scheduled_posts ADD CONSTRAINT scheduled_posts_dispatch_status_check
      CHECK (dispatch_status IN ('pending','in_flight','dispatched','failed','manual_reconciliation'));
  END IF;
END $constraint$;

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'scheduled_post_dispatches'::regclass
       AND conname = 'scheduled_post_dispatches_status_check'
       AND position('manual_reconciliation' in pg_get_constraintdef(oid)) > 0
  ) THEN
    ALTER TABLE scheduled_post_dispatches DROP CONSTRAINT IF EXISTS scheduled_post_dispatches_status_check;
    ALTER TABLE scheduled_post_dispatches ADD CONSTRAINT scheduled_post_dispatches_status_check
      CHECK (status IN ('pending','in_flight','dispatched','failed','manual_reconciliation'));
  END IF;
END $constraint$;

COMMIT;
