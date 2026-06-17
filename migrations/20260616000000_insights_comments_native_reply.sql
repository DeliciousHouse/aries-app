-- Native comment reply (qa-defect #598): an operator reply to a social comment
-- is posted to Meta (IG POST /{comment}/replies, FB POST /{comment}/comments)
-- and Aries records the platform reply id + delivery timestamp on the
-- insights_comments row.
--
--   platform_reply_id — the Meta Graph reply object id returned by the reply
--     mutation; NULL until a confirmed reply lands.
--   replied_at        — when the confirmed reply was recorded; NULL until then.
--
-- Like is_replied (20260609000000_insights_comments_is_replied.sql), these are
-- declared inline in the CREATE TABLE insights_comments block in
-- scripts/init-db.js, but CREATE TABLE IF NOT EXISTS never widens an existing
-- prod table — so the idempotent ALTERs here (mirrored in init-db.js) are what
-- reach the live table on container start.
--
-- Additive + idempotent. Safe on an empty table (instant, no rewrite).
-- Reverse (only if no code reads them):
--   ALTER TABLE insights_comments DROP COLUMN platform_reply_id;
--   ALTER TABLE insights_comments DROP COLUMN replied_at;

ALTER TABLE insights_comments ADD COLUMN IF NOT EXISTS platform_reply_id TEXT;
ALTER TABLE insights_comments ADD COLUMN IF NOT EXISTS replied_at TIMESTAMPTZ;
