-- Multi-workspace membership — Phase 0 (dark schema + backfill).
--
-- Plan: docs/plans/2026-07-03-multi-workspace-membership.md (Decision 1, 13;
-- Phase 0; Eng findings 1 dual-write, 2 sentinel mapping, 7 lowercase email
-- index, 11 no role default; CEO hardening finding 8 indexes).
--
-- This phase is ADDITIVE and produces ZERO behavior change: nothing reads these
-- tables or columns yet. It lays the membership seam so later phases can join
-- (active org, role) from a membership row instead of the single global
-- users.organization_id / users.role columns.
--
-- This file is the migrations/ record; scripts/init-db.js carries the same DDL +
-- backfill and is what actually applies on container start. Both are idempotent
-- (CREATE TABLE/INDEX IF NOT EXISTS, ON CONFLICT DO NOTHING) so re-runs are safe.
--
-- INTEGER (not BIGINT) for tenant/user FKs to match organizations.id / users.id
-- (int4), exactly like every other tenant-scoped table in this schema.

-- organization_memberships: one row per (user, organization) the user belongs to.
--   * role has NO DEFAULT (Eng finding 11) — users.role's DEFAULT 'tenant_admin'
--     is a prod landmine this seam deliberately does not replicate; every insert
--     sets role explicitly.
--   * status is 'invited' | 'active'. 'invited' = has a membership row but has
--     not yet accepted (the pending-password sentinel account state at backfill).
--   * last_active_at drives the most-recently-used default workspace; it is
--     written on switch and sign-in resolution only (never per-request), and is
--     backfilled here from the invitation accepted_at / users.created_at.
--   * PK (user_id, organization_id) also gives the concurrent-duplicate-invite
--     ON CONFLICT target (CEO hardening finding 2) and the pointer-validation
--     join key (finding 4).
CREATE TABLE IF NOT EXISTS organization_memberships (
  user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id      INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role                 TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active')),
  invited_by_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  invited_at           TIMESTAMPTZ,
  accepted_at          TIMESTAMPTZ,
  last_active_at       TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, organization_id)
);

-- Hot-path indexes (CEO hardening finding 8). The PK already covers
-- (user_id, organization_id); add the reverse-lookup and org-membership scans.
CREATE INDEX IF NOT EXISTS idx_organization_memberships_user
  ON organization_memberships (user_id);
CREATE INDEX IF NOT EXISTS idx_organization_memberships_org_status
  ON organization_memberships (organization_id, status);

-- organization_membership_events: append-only audit of membership MUTATIONS
-- (invited/accepted/removed/role_changed/absorbed). No CHECK on event_type —
-- documented values only, matching the users.role convention of validating in
-- code, not the DB. NO event rows are written in Phase 0 (schema only); the
-- writers land in Phase 0.5 (absorb) and Phase 2 (invite/accept/remove/role).
CREATE TABLE IF NOT EXISTS organization_membership_events (
  id               BIGSERIAL PRIMARY KEY,
  organization_id  INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  event_type       TEXT NOT NULL,
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_organization_membership_events_org_created
  ON organization_membership_events (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_organization_membership_events_user_created
  ON organization_membership_events (user_id, created_at DESC);

-- Entitlement columns (Decision 13): multi-workspace is a PAID account-level
-- entitlement. plan is 'free' | 'pro' for v1 — no CHECK constraint, matching the
-- users.role convention (validated in code, not the DB, so a later plan value
-- needs no constraint migration). plan_granted_at / plan_granted_by are the
-- audit columns the grant CLI (scripts/billing/set-user-plan.ts, Phase 4) writes.
-- Nothing reads users.plan in Phase 0.
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free';
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_granted_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_granted_by TEXT;

-- Case-insensitive email uniqueness (Eng finding 7). users.email is TEXT UNIQUE
-- while every lookup uses LOWER(email); without this a case-variant signup could
-- mint a second account, and one-email-one-account is load-bearing under
-- multi-membership. Safe to add here: the Phase-0 read-only dedupe audit found
-- ZERO duplicate LOWER(email) groups in prod. If a future DB somehow carries a
-- dup this CREATE UNIQUE INDEX fails loudly rather than silently corrupting.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower_unique
  ON users (LOWER(email));

-- Idempotent backfill: one active-or-invited membership per user that has an org
-- pointer today (Eng findings 1c + 2). status derives from the pending sentinel
-- (password_hash = 'invited_pending' → 'invited', else 'active'); role from the
-- current global users.role; last_active_at from the best available timestamp —
-- the (user,org) invitation's accepted_at when present, else users.created_at.
-- ON CONFLICT DO NOTHING makes re-runs (and the pre-flip re-run in Phase 1) a
-- no-op on rows the dual-write already created.
INSERT INTO organization_memberships
  (user_id, organization_id, role, status, invited_at, accepted_at, last_active_at, created_at, updated_at)
SELECT
  u.id,
  u.organization_id,
  u.role,
  CASE WHEN u.password_hash = 'invited_pending' THEN 'invited' ELSE 'active' END,
  inv.created_at,
  CASE WHEN u.password_hash = 'invited_pending' THEN NULL ELSE COALESCE(inv.accepted_at, u.created_at) END,
  COALESCE(inv.accepted_at, u.created_at),
  u.created_at,
  u.created_at
FROM users u
LEFT JOIN LATERAL (
  SELECT wi.created_at, wi.accepted_at
  FROM workspace_invitations wi
  WHERE wi.user_id = u.id AND wi.organization_id = u.organization_id
  ORDER BY wi.created_at DESC
  LIMIT 1
) inv ON TRUE
WHERE u.organization_id IS NOT NULL
ON CONFLICT (user_id, organization_id) DO NOTHING;
