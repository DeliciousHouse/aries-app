-- Story / Reel / Video publishing: add the `surface` axis (feed|story|reel),
-- orthogonal to the existing `media_type` (image|video). `posts.media_type`
-- already exists; this adds `surface` to posts + scheduled_posts and mirrors
-- `media_type` onto scheduled_posts so the worker dispatch path does not have
-- to JOIN posts at claim time for the publish shape.
--
-- Additive + idempotent (ADD COLUMN IF NOT EXISTS ... DEFAULT 'feed'/'image').
-- Reverse: ALTER TABLE posts DROP COLUMN surface; (+ scheduled_posts columns).

ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS surface text NOT NULL DEFAULT 'feed';
ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_surface_check;
ALTER TABLE posts
  ADD CONSTRAINT posts_surface_check CHECK (surface IN ('feed', 'story', 'reel'));

ALTER TABLE scheduled_posts
  ADD COLUMN IF NOT EXISTS surface text NOT NULL DEFAULT 'feed';
ALTER TABLE scheduled_posts DROP CONSTRAINT IF EXISTS scheduled_posts_surface_check;
ALTER TABLE scheduled_posts
  ADD CONSTRAINT scheduled_posts_surface_check CHECK (surface IN ('feed', 'story', 'reel'));

ALTER TABLE scheduled_posts
  ADD COLUMN IF NOT EXISTS media_type text NOT NULL DEFAULT 'image';
ALTER TABLE scheduled_posts DROP CONSTRAINT IF EXISTS scheduled_posts_media_type_check;
ALTER TABLE scheduled_posts
  ADD CONSTRAINT scheduled_posts_media_type_check CHECK (media_type IN ('image', 'video'));
