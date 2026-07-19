-- Durable per-platform attribution for scheduled cross-posts (AA-99).
--
-- posts.platform_post_id remains the aggregate/legacy first-success mirror.
-- Each scheduled child retains its own provider id so later lookups can recover
-- every platform's published post without collapsing the cross-post outcomes.
--
-- Also shipped in scripts/init-db.js (applied on container start); this file is
-- the migration record.

ALTER TABLE scheduled_post_dispatches
  ADD COLUMN IF NOT EXISTS platform_post_id TEXT;

CREATE INDEX IF NOT EXISTS idx_scheduled_post_dispatches_platform_post_id
  ON scheduled_post_dispatches (platform_post_id, platform)
  WHERE platform_post_id IS NOT NULL;
