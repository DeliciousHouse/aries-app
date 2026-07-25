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

-- Legacy in-flight dispatches were claimed by code that had no durable
-- provider-submission fence. Their provider outcome is unknowable across this
-- rollout, so quarantine them instead of letting the new worker reclaim and
-- cosmetically rearm them.
UPDATE scheduled_post_dispatches AS dispatch
   SET status = 'manual_reconciliation',
       error_at = COALESCE(error_at, now()),
       error_message = COALESCE(
         error_message,
         'legacy in-flight dispatch predates the provider-submission fence; manual reconciliation required'
       ),
       updated_at = now()
  FROM scheduled_posts AS scheduled
 WHERE dispatch.scheduled_post_id = scheduled.id
   AND scheduled.dispatch_status = 'in_flight'
   AND dispatch.status IN ('pending', 'in_flight');

UPDATE posts AS post
   SET published_status = 'unverified'
 WHERE post.published_status <> 'published'
   AND EXISTS (
     SELECT 1
       FROM scheduled_posts AS scheduled
      WHERE scheduled.post_id = post.id
        AND scheduled.dispatch_status = 'in_flight'
   );

UPDATE scheduled_posts
   SET dispatch_status = 'manual_reconciliation',
       error_at = COALESCE(error_at, now()),
       error_message = COALESCE(
         error_message,
         'legacy in-flight dispatch predates the provider-submission fence; manual reconciliation required'
       ),
       updated_at = now()
 WHERE dispatch_status = 'in_flight';

COMMIT;
