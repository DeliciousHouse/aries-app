-- Tenant-scoped taste rows: relax the marketing taste tables so the userLESS
-- weekly run (created_by='weekly-trigger-worker', no users.id) can hold a
-- tenant-level taste profile and append tenant-level signals.
--
-- The taste store (backend/marketing/taste-profile-store.ts) was built for the
-- onboarding variant board, which always has a logged-in user, so both tables
-- keyed strictly on (tenant_id, user_id) with user_id NOT NULL. The weekly
-- production run that PR2 biases has no user, so it writes/reads a tenant-scoped
-- row identified by user_id IS NULL — a real SQL NULL, NOT a sentinel integer:
-- user_id stays an FK to users(id) and there is no users row with id 0.
--
-- Uniqueness after this change (two indexes, by design):
--   * uq_marketing_taste_profile_tenant_user (tenant_id, user_id) keeps the
--     existing onboarding upsert working: applyTasteSignal infers
--     ON CONFLICT (tenant_id, user_id) from this index. Under SQL semantics
--     NULLs are distinct, so this index does NOT bound the tenant-scoped rows.
--   * uq_marketing_taste_profile_tenant_only (tenant_id) WHERE user_id IS NULL
--     enforces a single tenant-scoped row per tenant AND is the inference
--     target for the weekly upsert: ON CONFLICT (tenant_id) WHERE user_id IS NULL.
--
-- Also stamps a generation-time visual-style lens on synthesized posts
-- (style_dimension/style_value) so a later operator edit (regenerate/delete/
-- review-reject) has a concrete (dimension,value) to mark approved/rejected
-- with no per-edit LLM classification.
--
-- This file is the migrations/ record; scripts/init-db.js is the source applied
-- on container start (it carries the same ALTERs so the relaxation reaches an
-- existing prod table — CREATE TABLE IF NOT EXISTS would not).
--
-- Additive + idempotent. INTEGER (not BIGINT) to match organizations.id/users.id.
-- Reverse (only after de-duping any user_id-NULL rows + backfilling user_id):
--   DROP INDEX IF EXISTS uq_marketing_taste_profile_tenant_only;
--   DROP INDEX IF EXISTS uq_marketing_taste_profile_tenant_user;
--   ALTER TABLE marketing_taste_profile ADD PRIMARY KEY (tenant_id, user_id);
--   ALTER TABLE marketing_taste_profile ALTER COLUMN user_id SET NOT NULL;
--   ALTER TABLE marketing_taste_signal
--     ALTER COLUMN user_id SET NOT NULL,
--     ALTER COLUMN variant_batch_id SET NOT NULL,
--     ALTER COLUMN variant_id SET NOT NULL;
--   ALTER TABLE posts DROP COLUMN style_value, DROP COLUMN style_dimension;

-- marketing_taste_profile: drop the (tenant_id,user_id) PK, allow a tenant-scoped
-- (user_id NULL) row, and re-establish uniqueness via two indexes. The default
-- name for an inline PRIMARY KEY is <table>_pkey; DROP CONSTRAINT IF EXISTS is a
-- safe no-op on a fresh DB where the relaxed CREATE never added the PK.
ALTER TABLE marketing_taste_profile DROP CONSTRAINT IF EXISTS marketing_taste_profile_pkey;
ALTER TABLE marketing_taste_profile ALTER COLUMN user_id DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_marketing_taste_profile_tenant_user
  ON marketing_taste_profile (tenant_id, user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_marketing_taste_profile_tenant_only
  ON marketing_taste_profile (tenant_id) WHERE user_id IS NULL;

-- marketing_taste_signal: relax the onboarding-only NOT NULLs so a tenant-level
-- (userless / non-variant) signal row can be appended. DROP NOT NULL is a no-op
-- when the column is already nullable, so this is safely re-runnable.
ALTER TABLE marketing_taste_signal ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE marketing_taste_signal ALTER COLUMN variant_batch_id DROP NOT NULL;
ALTER TABLE marketing_taste_signal ALTER COLUMN variant_id DROP NOT NULL;

-- Generation-time visual-style lens on synthesized posts (Phase 3 stamp).
-- Nullable + no default: a pre-stamp/legacy post stays NULL and is simply
-- skipped by the taste producers.
ALTER TABLE posts ADD COLUMN IF NOT EXISTS style_dimension TEXT;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS style_value TEXT;
