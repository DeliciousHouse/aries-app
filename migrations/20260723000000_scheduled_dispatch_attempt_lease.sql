-- Dedicated scheduled-dispatch attempt ownership.
--
-- updated_at is mutable business metadata (including rescheduling), so it
-- cannot safely identify the worker generation that owns an in-flight publish.
ALTER TABLE scheduled_posts
  ADD COLUMN IF NOT EXISTS dispatch_attempt_token TEXT;

ALTER TABLE scheduled_posts
  ADD COLUMN IF NOT EXISTS dispatch_claimed_at TIMESTAMPTZ;

-- Preserve reclaimability for any legacy in-flight row present while the old
-- worker is stopped for rollout. The next claim replaces this generated token.
UPDATE scheduled_posts
   SET dispatch_attempt_token = COALESCE(
         dispatch_attempt_token,
         md5(random()::text || clock_timestamp()::text || id::text)
       ),
       dispatch_claimed_at = COALESCE(dispatch_claimed_at, updated_at)
 WHERE dispatch_status = 'in_flight'
   AND (dispatch_attempt_token IS NULL OR dispatch_claimed_at IS NULL);
