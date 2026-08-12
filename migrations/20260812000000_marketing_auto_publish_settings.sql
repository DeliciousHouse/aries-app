-- Owner-gated auto-publish: per-tenant opt-in for autonomous delivery.
--
-- Auto-schedule and auto-publish were the same action until now. Scheduling a
-- post wrote a scheduled_posts row with dispatch_status='pending', and
-- scheduled-posts-worker claimed it at scheduled_for and pushed it straight to
-- the provider — no human step between "on the calendar" and "live". The manual
-- path (app/api/publish/dispatch) has always consumed a
-- marketing_approval_record first; the scheduled path had no equivalent gate.
--
-- This table splits the two. Auto-schedule stays on for every tenant (the
-- calendar keeps populating from the AI's timing recommendation), but a due row
-- is only DISPATCHED when its tenant has opted in here. A tenant without a row
-- is held: the post stays on the calendar past its slot with a Publish control,
-- and is excluded from the dead-campaign sweep so the week never silently
-- expires.
--
-- Absence == disabled. The gate reads EXISTS(... AND enabled), so an unseeded
-- tenant is held rather than published — the safe direction for a table that
-- may not have been backfilled yet.
--
-- Writable by tenant_admin only (app/api/marketing/auto-publish), the same role
-- guard marketing_schedule and business_profile use.
--
-- Additive + idempotent; applied on container start by scripts/init-db.js. This
-- file is the migration of record.

-- ON DELETE CASCADE matches the sibling per-tenant singleton `marketing_schedule`.
-- It is not only consistency: without it a deleted organization leaves an orphan
-- `enabled = true` row behind, and this table's whole contract is that a row here
-- means "allowed to publish autonomously". Orphans fail OPEN, which is the one
-- direction this gate must never fail.
CREATE TABLE IF NOT EXISTS marketing_auto_publish_settings (
  tenant_id          INTEGER PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  enabled            BOOLEAN NOT NULL DEFAULT false,
  updated_by_user_id INTEGER,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The dispatch gate probes this table once per due row per tick. The primary
-- key already covers the tenant_id lookup; this partial index keeps the
-- enabled-only EXISTS probe off the heap on a table that is mostly disabled
-- rows once the fleet is seeded.
CREATE INDEX IF NOT EXISTS idx_marketing_auto_publish_settings_enabled
  ON marketing_auto_publish_settings (tenant_id)
  WHERE enabled;
