-- X (Twitter) connect: allow platform='x' on connected_accounts.
--
-- #650 added 'x' to the IntegrationPlatform enum (backend/integrations/providers/
-- types.ts) but never widened this CHECK, so the Composio connect callback's
-- upsertConnection(... platform='x') is rejected at the DB layer in prod — no
-- platform='x' row can ever persist, DB-blocking X connect/publish/insights
-- end-to-end. Its tests passed because they mock the DB.
--
-- The original CHECK is an unnamed inline column constraint, so Postgres
-- auto-named it connected_accounts_platform_check.
--
-- Additive + idempotent; mirrored in scripts/init-db.js (applied on container
-- start). No 'x' rows can pre-exist (the old CHECK blocked them), so re-adding
-- the constraint never fails on existing data. Purely allows a new value —
-- safe on existing rows and independent of any feature flag.

ALTER TABLE connected_accounts
  DROP CONSTRAINT IF EXISTS connected_accounts_platform_check;

ALTER TABLE connected_accounts
  ADD CONSTRAINT connected_accounts_platform_check
  CHECK (platform IN ('facebook','instagram','meta_ads','tiktok','youtube','linkedin','reddit','x'));
