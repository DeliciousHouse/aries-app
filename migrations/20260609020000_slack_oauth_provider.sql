-- Phase 4 Option A: per-tenant Slack as an OAuth provider.
--
-- Widen the oauth_connections provider CHECK to allow 'slack' and add the
-- per-tenant notification-target columns (the channel the bot posts approval
-- notifications to for that tenant). Slack reuses the generic oauth_connections
-- / oauth_tokens / oauth_pending_states framework — the bot token (xoxb-) is
-- stored encrypted in oauth_tokens like every other provider; these columns only
-- add the notification destination.
--
-- Additive + idempotent; mirrored in scripts/init-db.js (applied on container
-- start). No 'slack' rows can pre-exist (the old CHECK blocked them), so
-- re-adding the constraint never fails on existing data.

ALTER TABLE oauth_connections
  DROP CONSTRAINT IF EXISTS oauth_connections_provider_check;

ALTER TABLE oauth_connections
  ADD CONSTRAINT oauth_connections_provider_check
  CHECK (provider IN ('facebook','instagram','linkedin','x','youtube','tiktok','reddit','slack'));

ALTER TABLE oauth_connections
  ADD COLUMN IF NOT EXISTS notify_channel_id TEXT;

ALTER TABLE oauth_connections
  ADD COLUMN IF NOT EXISTS notify_channel_name TEXT;
