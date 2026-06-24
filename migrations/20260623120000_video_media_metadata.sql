-- Video media metadata: add explicit width_px / height_px / duration_seconds
-- columns to the three publish-path tables so a video surface has somewhere to
-- store the dimensions + duration meta-media-validation.ts hard-requires
-- (widthPx/heightPx/durationSeconds) for any reel / story-video / feed-video.
-- duration_seconds is INTEGER to match insights_posts.duration_seconds (INT).
--
-- Additive + idempotent (ADD COLUMN IF NOT EXISTS, all nullable). Population of
-- these columns (ingest -> creative_assets, synthesize -> posts) is a separate
-- deferred follow-up; this migration only creates the storage.
-- Applied via scripts/init-db.js on fresh DBs; run manually on existing ones.
-- Reverse: ALTER TABLE <t> DROP COLUMN duration_seconds, DROP COLUMN height_px, DROP COLUMN width_px;

ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS width_px INTEGER;
ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS height_px INTEGER;
ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS duration_seconds INTEGER;

ALTER TABLE posts ADD COLUMN IF NOT EXISTS width_px INTEGER;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS height_px INTEGER;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS duration_seconds INTEGER;

ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS width_px INTEGER;
ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS height_px INTEGER;
ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS duration_seconds INTEGER;
