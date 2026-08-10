-- 20260810000000_insights_object_health.sql
--
-- Per-object health state for the insights sync (audit item 5b).
--
-- Problem: a post deleted on-platform answered Graph (#100) on every 30-minute
-- tick forever. `last_metrics_fetched_at` was stamped only on success, and the
-- comments leg had no watermark at all, so a dead object was re-selected
-- indefinitely, pushed a fresh legError each tick, and pinned its account's
-- sync run at 'partial' — permanently, with no alert (tenant 15, 72 h+).
--
-- The two legs get INDEPENDENT strike state. They address the same platform
-- object but fail independently: a post whose metrics succeed while its
-- comments permanently fail would, with shared columns, have its counter reset
-- to 0 by the metrics success every tick before the comments failure could
-- increment it to 1 — never converging, reproducing the exact poison signature
-- this migration exists to fix.
--
-- insights_accounts.disabled_at closes the other half: connected_accounts is
-- UNIQUE (tenant_id, platform), so a reconnect to a different Page/IG id
-- REWRITES that row while the bridge inserts a NEW insights_accounts row —
-- and nothing has ever deleted from insights_accounts, so the old row syncs a
-- dead page id forever. A full disconnect DELETES the connected_accounts row
-- and orphans the insights row the same way.
--
-- Mirrored verbatim in scripts/init-db.js (repo convention: init-db is what
-- actually runs on deploy; this file is the reviewable record).
-- All statements are additive, nullable, and idempotent.

BEGIN;

-- ── Per-post, per-leg failure state ─────────────────────────────────────────
ALTER TABLE insights_posts ADD COLUMN IF NOT EXISTS metrics_error_count INT NOT NULL DEFAULT 0;
ALTER TABLE insights_posts ADD COLUMN IF NOT EXISTS metrics_last_error TEXT;
ALTER TABLE insights_posts ADD COLUMN IF NOT EXISTS metrics_unavailable_at TIMESTAMPTZ;

ALTER TABLE insights_posts ADD COLUMN IF NOT EXISTS comments_error_count INT NOT NULL DEFAULT 0;
ALTER TABLE insights_posts ADD COLUMN IF NOT EXISTS comments_last_error TEXT;
ALTER TABLE insights_posts ADD COLUMN IF NOT EXISTS comments_unavailable_at TIMESTAMPTZ;

-- Serves the operator health report (scripts/insights-object-health.ts) and the
-- host monitor's quarantine counts. Partial: quarantined rows are the rare case.
CREATE INDEX IF NOT EXISTS idx_insights_posts_unavailable
  ON insights_posts (tenant_id, account_id)
  WHERE metrics_unavailable_at IS NOT NULL OR comments_unavailable_at IS NOT NULL;

-- ── Account-level self-heal ─────────────────────────────────────────────────
-- Set by the ensure-account bridge when an insights_accounts row no longer
-- matches any connected_accounts row for its (tenant, platform). Reversible:
-- the next tick after a reconnect clears both columns.
ALTER TABLE insights_accounts ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;
ALTER TABLE insights_accounts ADD COLUMN IF NOT EXISTS disabled_reason TEXT;

COMMIT;
