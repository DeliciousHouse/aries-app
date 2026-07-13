-- Retry backoff marker for the scheduled-posts worker.
--
-- A retryable dispatch failure (e.g. Facebook rate limit error 368) used to be
-- re-claimed and re-sent every 60s worker tick until the campaign window
-- closed — sustaining the very rate limit that caused the failure (observed
-- 2026-07-07 → 2026-07-13, five FB posts hammered for ~6 days). The worker now
-- writes next_attempt_at = now() + backoff after a non-terminal outcome and
-- the due-rows scan skips pending rows whose next_attempt_at is in the future.
-- NULL = claimable immediately (legacy behavior; also the value for fresh rows).
--
-- Also shipped in scripts/init-db.js (applied on container start); this file is
-- the migration record.

ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;
