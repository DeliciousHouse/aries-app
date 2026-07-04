import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import pg from 'pg';

import { resolveProjectRoot } from '../helpers/project-root';
import { requireDbEnvOrSkip } from '../helpers/requires-infra';

// Live-schema proof for the multi-workspace Phase 0 membership backfill
// (docs/plans/2026-07-03-multi-workspace-membership.md — Phase 0; Eng findings
// 1c dual-write parity, 2 sentinel→status mapping, 7 lowercase-unique email
// index, 11 no role default; Decision 13 entitlement columns). The mock-level
// dual-write tests cover the app write paths; THIS file executes the real
// backfill INSERT…SELECT + the membership/entitlement DDL against Postgres so we
// prove: one membership per user-with-org, the sentinel maps to 'invited', an
// org-less user is excluded, the backfill is idempotent (re-run inserts 0), the
// lowercase-unique email index rejects a case-variant duplicate, and users.plan
// defaults to 'free'.
//
// It runs entirely inside a uniquely-named throwaway schema (search_path pinned
// per-pool) that is CREATEd then DROPped, so a real database is never touched
// beyond CREATE SCHEMA / DROP SCHEMA of a test-only schema — the same isolation
// pattern as tests/feedback-reports-store.requires-infra.test.ts. To run it for
// real, point DB_* at a THROWAWAY Postgres 16 (never prod) with
// ARIES_TEST_REQUIRES_INFRA_ENABLED=1; see tests/REQUIRES_INFRA.md.

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

// The prerequisite tables the backfill reads. These mirror the shapes
// scripts/init-db.js creates; only the columns the backfill's INSERT…SELECT and
// the sentinel/email invariants touch are reproduced (schema-local, so the FKs
// resolve inside the throwaway schema).
const PREREQ_DDL = `
  CREATE TABLE organizations (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT UNIQUE,
    created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name TEXT,
    organization_id INTEGER REFERENCES organizations(id),
    role TEXT NOT NULL DEFAULT 'tenant_admin',
    created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE TABLE workspace_invitations (
    id BIGSERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    role TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    accepted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

// The membership + entitlement DDL exactly as scripts/init-db.js lays it (Phase
// 0 dark schema). Kept in a constant so the drift guard below can assert it is a
// verbatim substring of the shipped init-db.js.
const MEMBERSHIP_DDL = `
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
  );`;

const ENTITLEMENT_DDL = `ALTER TABLE users ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free';`;

const LOWERCASE_EMAIL_INDEX = `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower_unique
        ON users (LOWER(email));`;

// The backfill INSERT…SELECT exactly as scripts/init-db.js runs it. Drift-guarded
// below against init-db.js source so this test cannot silently diverge from what
// actually applies on container start.
const BACKFILL_SQL = `
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
      ON CONFLICT (user_id, organization_id) DO NOTHING;`;

test('membership backfill: sentinel mapping, org-less exclusion, idempotency, lowercase-email uniqueness, plan default (live schema)', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;

  // Drift guard: the SQL this test executes must be the SQL that ships. If the
  // backfill or the membership/entitlement/index DDL in init-db.js changes, this
  // fails loudly rather than proving stale SQL. (Whitespace-normalized so an
  // indentation reflow in init-db.js does not false-alarm.)
  const initDbSource = readFileSync(path.join(PROJECT_ROOT, '..', 'scripts', 'init-db.js'), 'utf8');
  const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
  const squashedInitDb = squash(initDbSource);
  assert.ok(
    squashedInitDb.includes(squash(BACKFILL_SQL)),
    'BACKFILL_SQL drifted from scripts/init-db.js — re-sync this test with the shipped backfill',
  );
  assert.ok(
    squashedInitDb.includes(squash(MEMBERSHIP_DDL)),
    'MEMBERSHIP_DDL drifted from scripts/init-db.js',
  );
  assert.ok(
    squashedInitDb.includes(squash(ENTITLEMENT_DDL)),
    'ENTITLEMENT_DDL drifted from scripts/init-db.js',
  );
  assert.ok(
    squashedInitDb.includes(squash(LOWERCASE_EMAIL_INDEX)),
    'LOWERCASE_EMAIL_INDEX drifted from scripts/init-db.js',
  );

  const schema = `membership_backfill_test_${process.pid}_${Date.now()}`;
  const admin = new pg.Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    max: 1,
  });
  await admin.query(`CREATE SCHEMA "${schema}"`);

  const pool = new pg.Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    max: 2,
    options: `-c search_path="${schema}"`,
  });

  try {
    await pool.query(PREREQ_DDL);
    await pool.query(MEMBERSHIP_DDL);
    await pool.query(ENTITLEMENT_DDL);
    await pool.query(LOWERCASE_EMAIL_INDEX);

    // Seed the four backfill scenarios.
    await pool.query(`INSERT INTO organizations (id, name, slug) VALUES (100,'Org A','org-a'),(200,'Org B','org-b')`);
    // 1) active user in org 100 (default role), no invitation row.
    await pool.query(
      `INSERT INTO users (id, email, password_hash, full_name, organization_id, role, created_at)
       VALUES (1,'active@acme.com','$2a$12$realbcrypthashaaaaaaaaaaaa','Active',100,'tenant_admin','2026-01-01T00:00:00Z')`,
    );
    // 2) invited-pending user in org 100 — the sentinel account state.
    await pool.query(
      `INSERT INTO users (id, email, password_hash, full_name, organization_id, role, created_at)
       VALUES (2,'invited@acme.com','invited_pending','Invited',100,'tenant_viewer','2026-02-01T00:00:00Z')`,
    );
    // 3) org-less user — MUST be excluded from the backfill.
    await pool.query(
      `INSERT INTO users (id, email, password_hash, full_name, organization_id, role, created_at)
       VALUES (3,'orgless@acme.com','$2a$12$realbcrypthashbbbbbbbbbbbb','Orgless',NULL,'tenant_admin','2026-03-01T00:00:00Z')`,
    );
    // 4) active analyst in org 200 whose invitation was accepted — last_active_at
    //    must come from accepted_at, not created_at.
    await pool.query(
      `INSERT INTO users (id, email, password_hash, full_name, organization_id, role, created_at)
       VALUES (4,'analyst@b.com','$2a$12$realbcrypthashcccccccccccc','Analyst',200,'tenant_analyst','2026-01-05T00:00:00Z')`,
    );
    // Accepted invitation for user 4.
    await pool.query(
      `INSERT INTO workspace_invitations (organization_id, user_id, email, role, token_hash, expires_at, accepted_at, created_at)
       VALUES (200,4,'analyst@b.com','tenant_analyst','hash4', now()+interval '7 days','2026-06-10T12:00:00Z','2026-06-03T00:00:00Z')`,
    );
    // Outstanding (unaccepted) invitation for the sentinel user 2 — proves
    // invited_at is populated for an invited membership while accepted_at is NULL.
    await pool.query(
      `INSERT INTO workspace_invitations (organization_id, user_id, email, role, token_hash, expires_at, accepted_at, created_at)
       VALUES (100,2,'invited@acme.com','tenant_viewer','hash2', now()+interval '7 days',NULL,'2026-06-01T00:00:00Z')`,
    );

    // --- run the backfill ---
    const firstRun = await pool.query(BACKFILL_SQL);
    assert.equal(firstRun.rowCount, 3, 'backfill inserts exactly one membership per user-with-org (org-less user 3 excluded)');

    const rows = (
      await pool.query(
        `SELECT user_id, organization_id, role, status,
                invited_at, accepted_at, last_active_at
           FROM organization_memberships ORDER BY user_id`,
      )
    ).rows as Array<{
      user_id: number;
      organization_id: number;
      role: string;
      status: string;
      invited_at: Date | null;
      accepted_at: Date | null;
      last_active_at: Date | null;
    }>;

    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((r) => r.user_id),
      [1, 2, 4],
      'org-less user 3 produced NO membership row',
    );

    // User 1: active, role mirrored from users.role, accepted_at falls back to
    // created_at (no invitation), last_active_at = created_at.
    const u1 = rows.find((r) => r.user_id === 1)!;
    assert.equal(u1.status, 'active');
    assert.equal(u1.organization_id, 100);
    assert.equal(u1.role, 'tenant_admin');
    assert.equal(u1.invited_at, null, 'no invitation row → invited_at NULL');
    assert.notEqual(u1.accepted_at, null, 'active membership stamps accepted_at (from created_at fallback)');
    assert.equal(
      u1.accepted_at!.toISOString(),
      new Date('2026-01-01T00:00:00Z').toISOString(),
      'active-without-invitation accepted_at falls back to users.created_at',
    );
    assert.equal(u1.last_active_at!.toISOString(), new Date('2026-01-01T00:00:00Z').toISOString());

    // User 2: the pending-password SENTINEL → status='invited', accepted_at NULL,
    // invited_at populated from the outstanding invitation (Eng finding 2). This
    // is the assertion that never-accepted invitees don't backfill as joined.
    const u2 = rows.find((r) => r.user_id === 2)!;
    assert.equal(u2.status, 'invited', "password_hash='invited_pending' maps to status='invited'");
    assert.equal(u2.role, 'tenant_viewer');
    assert.equal(u2.accepted_at, null, 'invited membership leaves accepted_at NULL');
    assert.notEqual(u2.invited_at, null, 'invited_at populated from the outstanding invitation');

    // User 4: active with an ACCEPTED invitation → last_active_at + accepted_at
    // come from the invitation's accepted_at, not created_at.
    const u4 = rows.find((r) => r.user_id === 4)!;
    assert.equal(u4.status, 'active');
    assert.equal(u4.role, 'tenant_analyst');
    assert.equal(
      u4.accepted_at!.toISOString(),
      new Date('2026-06-10T12:00:00Z').toISOString(),
      "active membership's accepted_at prefers the invitation accepted_at",
    );
    assert.equal(u4.last_active_at!.toISOString(), new Date('2026-06-10T12:00:00Z').toISOString());

    // --- idempotency: re-run inserts 0 rows and leaves the set identical ---
    const secondRun = await pool.query(BACKFILL_SQL);
    assert.equal(secondRun.rowCount, 0, 'idempotent re-run inserts zero rows (ON CONFLICT DO NOTHING)');
    const total = await pool.query(`SELECT count(*)::int AS n FROM organization_memberships`);
    assert.equal(total.rows[0].n, 3, 'membership row count unchanged after re-run');

    // --- users.plan defaults to 'free' (Decision 13 entitlement column) ---
    const plans = await pool.query(`SELECT DISTINCT plan FROM users`);
    assert.deepEqual(plans.rows, [{ plan: 'free' }], 'every backfilled user carries plan default free');

    // --- lowercase-unique email index rejects a case-variant duplicate
    //     (Eng finding 7 — one-email-one-account is load-bearing) ---
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO users (email, password_hash, organization_id, role)
           VALUES ('ACTIVE@acme.com','$2a$12$x',100,'tenant_admin')`,
        ),
      /idx_users_email_lower_unique|duplicate key value/i,
      'a case-variant of an existing email is rejected by the lowercase-unique index',
    );
  } finally {
    await pool.end().catch(() => {});
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => {});
    await admin.end().catch(() => {});
  }
});
