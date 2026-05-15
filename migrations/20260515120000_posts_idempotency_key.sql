-- Posts table: add idempotency_key for double-publish prevention.
-- Derived from (marketing_job_id, stage, asset_index, platform) or a stable
-- caller-supplied key. The unique constraint on (tenant_id, platform, idempotency_key)
-- is the authoritative guard; code-level checks are a performance short-circuit only.
-- Applied via scripts/init-db.js on fresh DBs; run manually on existing deployments.

ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS platform TEXT;

ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- Unique index: the DB is the source of truth for double-publish prevention.
-- Partial index (WHERE idempotency_key IS NOT NULL) so legacy rows without a
-- key don't conflict with each other.
CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_tenant_platform_idempotency_key
  ON posts (tenant_id, platform, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_posts_tenant_platform
  ON posts (tenant_id, platform);
