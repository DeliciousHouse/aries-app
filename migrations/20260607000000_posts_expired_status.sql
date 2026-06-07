-- Draft-expiry sweep: add the terminal 'expired' status to posts, an expired_at
-- audit column, and a partial index for the sweep's candidate scan.
--
-- The draft-expiry sweep (scripts/automations/draft-expiry-sweep-worker.ts via
-- backend/marketing/draft-expiry-sweep.ts) marks a STRANDED pre-publish post —
-- one with no scheduled_posts row, never published, older than the age window —
-- as published_status='expired' (and the legacy status mirror too), removing it
-- from the operator's approval/backlog trays without publishing stale content.
-- This is the safety net that stops the unscheduled-approved backlog from
-- growing without bound once the weekly trigger fans out across tenants (the
-- "36 stranded approved IG posts" symptom).
--
-- This file is the migrations/ record; scripts/init-db.js is the source applied
-- on container start (it carries the same DROP + ADD CONSTRAINT so the widening
-- reaches an existing prod posts table — CREATE TABLE IF NOT EXISTS would not).
--
-- Additive + idempotent.
-- Reverse: revert the CHECKs to the prior value lists, then
--   ALTER TABLE posts DROP COLUMN expired_at; DROP INDEX idx_posts_draft_expiry;
-- (only after no row is in the 'expired' state).

ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_published_status_check;
ALTER TABLE posts
  ADD CONSTRAINT posts_published_status_check CHECK (published_status IN ('draft','in_review','approved','scheduled','publishing','published','failed','rolled_back','unverified','expired'));

ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_status_check;
ALTER TABLE posts
  ADD CONSTRAINT posts_status_check CHECK (status IN ('draft','in_review','approved','scheduled','publishing','published','failed','rolled_back','expired'));

ALTER TABLE posts ADD COLUMN IF NOT EXISTS expired_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_posts_draft_expiry
  ON posts (updated_at)
  WHERE published_status IN ('draft','in_review','approved');
