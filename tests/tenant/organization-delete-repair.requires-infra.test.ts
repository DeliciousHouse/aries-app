/**
 * Multi-workspace Phase 4 — org-deletion pointer repair against live Postgres
 * (plan Decision 11 + the Error & Rescue Registry "organization delete (Phase 4)"
 * row). The mock-level shape test (tests/tenant/organization-lifecycle-repair.test.ts)
 * proves the SQL is shaped right; THIS file proves the end-to-end lifecycle
 * invariant that the shape test can't reach:
 *
 *   after repairPointersForDeletedOrganization runs INSIDE the delete
 *   transaction and the org row is dropped, every stranded user resolves to
 *   COMPLETE tenant claims (repointed to their next active workspace) or a clean
 *   zero-membership chooser state (NULL pointer) — NEVER a dangling pointer that
 *   would surface as a claims-incomplete login hard-fail — AND no users row is
 *   ever deleted (the account + its OTHER memberships survive).
 *
 * It composes the real repair function with the real claims resolver
 * (resolveTenantClaimsRow, the ONE query every auth/jwt path flows through) so
 * the "hard-fail prevented" property is proven on the actual read path, not
 * asserted in the abstract.
 *
 * Isolation: throwaway SCHEMA CREATEd + DROPped (the requires-infra pattern).
 * Point DB_* at a THROWAWAY Postgres 16 (never prod); see tests/REQUIRES_INFRA.md.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import pg from 'pg';

import { requireDbEnvOrSkip } from '../helpers/requires-infra';
import { repairPointersForDeletedOrganization } from '../../backend/tenant/organization-lifecycle';
import { resolveTenantClaimsRow } from '../../lib/auth-tenant-membership';

const FLAG_ON = { ARIES_MULTI_WORKSPACE_ENABLED: '1', NODE_ENV: 'test' } as NodeJS.ProcessEnv;
const FLAG_OFF = { ARIES_MULTI_WORKSPACE_ENABLED: '0', NODE_ENV: 'test' } as NodeJS.ProcessEnv;

const SCHEMA_DDL = `
  CREATE TABLE organizations (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT UNIQUE,
    created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL DEFAULT 'x',
    organization_id INTEGER REFERENCES organizations(id),
    role TEXT NOT NULL DEFAULT 'tenant_admin',
    plan TEXT NOT NULL DEFAULT 'free',
    created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE TABLE organization_memberships (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active')),
    invited_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    invited_at TIMESTAMPTZ,
    accepted_at TIMESTAMPTZ,
    last_active_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, organization_id)
  );
  CREATE TABLE organization_membership_events (
    id BIGSERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

async function withHarness(
  fn: (ctx: {
    pool: pg.Pool;
    org: (name: string) => Promise<number>;
    user: (input: { email: string; organizationId: number; role?: string }) => Promise<number>;
    membership: (input: {
      userId: number;
      organizationId: number;
      role: string;
      status: 'invited' | 'active';
      lastActiveAt?: Date;
    }) => Promise<void>;
    /** Delete an org through the real repair inside one txn (mirrors the caller). */
    deleteOrg: (orgId: number, env: NodeJS.ProcessEnv) => Promise<Awaited<ReturnType<typeof repairPointersForDeletedOrganization>>>;
    userExists: (userId: number) => Promise<boolean>;
    claims: (userId: number, env: NodeJS.ProcessEnv) => Promise<Awaited<ReturnType<typeof resolveTenantClaimsRow>>>;
  }) => Promise<void>,
): Promise<void> {
  const schema = `mw_p4_orgdel_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
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
    max: 4,
    options: `-c search_path="${schema}"`,
  });
  try {
    await pool.query(SCHEMA_DDL);
    await fn({
      pool,
      async org(name) {
        const r = await pool.query(`INSERT INTO organizations (name, slug) VALUES ($1,$2) RETURNING id`, [
          name,
          `${name.toLowerCase()}-${crypto.randomBytes(2).toString('hex')}`,
        ]);
        return Number(r.rows[0].id);
      },
      async user(input) {
        const r = await pool.query(
          `INSERT INTO users (email, organization_id, role) VALUES ($1,$2,$3) RETURNING id`,
          [input.email, input.organizationId, input.role ?? 'tenant_admin'],
        );
        return Number(r.rows[0].id);
      },
      async membership(input) {
        await pool.query(
          `INSERT INTO organization_memberships (user_id, organization_id, role, status, accepted_at, last_active_at, created_at, updated_at)
           VALUES ($1,$2,$3,$4, CASE WHEN $4='active' THEN now() END, $5, now(), now())`,
          [input.userId, input.organizationId, input.role, input.status, input.lastActiveAt ?? null],
        );
      },
      async deleteOrg(orgId, env) {
        // Mirror the caller: repair pointers/memberships INSIDE the txn, then
        // drop the org row, then COMMIT.
        const client = await pool.connect();
        try {
          await client.query('BEGIN', []);
          const result = await repairPointersForDeletedOrganization(client, orgId, env);
          await client.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
          await client.query('COMMIT', []);
          return result;
        } catch (error) {
          await client.query('ROLLBACK', []);
          throw error;
        } finally {
          client.release();
        }
      },
      async userExists(userId) {
        return Number((await pool.query(`SELECT count(*)::int AS n FROM users WHERE id=$1`, [userId])).rows[0].n) === 1;
      },
      async claims(userId, env) {
        const client = await pool.connect();
        try {
          return await resolveTenantClaimsRow(client, { by: 'userId', userId }, env);
        } finally {
          client.release();
        }
      },
    });
  } finally {
    await pool.end().catch(() => {});
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => {});
    await admin.end().catch(() => {});
  }
}

// ── Flag ON: repoint to MRU next membership → complete claims, no hard-fail ──

test('org-delete (requires-infra): a user pointed at the deleted org is repointed to the MRU next workspace → COMPLETE claims, no claims-incomplete hard-fail; users row survives', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;
  await withHarness(async (h) => {
    const doomed = await h.org('Doomed');
    const survivorOlder = await h.org('SurvivorOlder');
    const survivorMru = await h.org('SurvivorMru');

    // The user's active pointer targets the org about to be deleted, and they
    // hold two OTHER active memberships (one more recently used).
    const userId = await h.user({ email: 'stranded@acme.com', organizationId: doomed, role: 'tenant_admin' });
    await h.membership({ userId, organizationId: doomed, role: 'tenant_admin', status: 'active' });
    await h.membership({
      userId,
      organizationId: survivorOlder,
      role: 'tenant_viewer',
      status: 'active',
      lastActiveAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    await h.membership({
      userId,
      organizationId: survivorMru,
      role: 'tenant_analyst',
      status: 'active',
      lastActiveAt: new Date(),
    });

    const result = await h.deleteOrg(doomed, FLAG_ON);
    assert.deepEqual(result.repointedUsers, [{ userId: String(userId), repointedToOrganizationId: String(survivorMru) }]);

    // The account SURVIVES — org deletion never deletes a users row.
    assert.ok(await h.userExists(userId), 'the users row survives the org deletion');

    // THE hard-fail-prevention invariant: the real claims resolver returns
    // COMPLETE claims (org + slug + role) for the repointed user — a dangling
    // pointer would instead resolve to a claims-incomplete null-org state.
    const claims = await h.claims(userId, FLAG_ON);
    assert.ok(claims, 'claims resolve');
    assert.equal(Number(claims!.tenant_id), survivorMru, 'repointed to the MRU next active workspace');
    assert.equal(claims!.role, 'tenant_analyst', 'role comes from the repointed membership (mirror moved in the repair)');
    assert.ok(claims!.tenant_slug, 'tenant_slug is present — claims are complete, login does not hard-fail');
  });
});

test('org-delete (requires-infra): a user with NO other membership is NULL-pointed → clean zero-membership chooser state (not a dangling pointer)', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;
  await withHarness(async (h) => {
    const doomed = await h.org('DoomedSolo');
    const userId = await h.user({ email: 'solo@acme.com', organizationId: doomed, role: 'tenant_admin' });
    await h.membership({ userId, organizationId: doomed, role: 'tenant_admin', status: 'active' });

    const result = await h.deleteOrg(doomed, FLAG_ON);
    assert.deepEqual(result.repointedUsers, [{ userId: String(userId), repointedToOrganizationId: null }]);
    assert.ok(await h.userExists(userId), 'the users row survives');

    // The claims resolver returns the typed zero-membership state (null org,
    // workspace_count 0) — the invite-aware chooser, NOT a hard-fail.
    const claims = await h.claims(userId, FLAG_ON);
    assert.ok(claims, 'claims resolve (a row is returned, not an error)');
    assert.equal(claims!.organization_id, null, 'NULL pointer → chooser, never a dangling pointer');
    assert.equal(claims!.workspace_count, 0, 'zero active memberships');
  });
});

// ── Flag OFF: bare cascade (clear pointer to NULL only), no membership repoint ─

test('org-delete (requires-infra): flag OFF clears the strayed pointer to NULL only (byte-identical bare cascade); users row survives', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;
  await withHarness(async (h) => {
    const doomed = await h.org('DoomedOff');
    const other = await h.org('OtherOff');
    const userId = await h.user({ email: 'off@acme.com', organizationId: doomed, role: 'tenant_admin' });
    await h.membership({ userId, organizationId: doomed, role: 'tenant_admin', status: 'active' });
    // Even though the user HAS another active membership, flag OFF must NOT
    // membership-repoint — it only clears the strayed pointer.
    await h.membership({ userId, organizationId: other, role: 'tenant_viewer', status: 'active' });

    const result = await h.deleteOrg(doomed, FLAG_OFF);
    assert.deepEqual(result.repointedUsers, [{ userId: String(userId), repointedToOrganizationId: null }], 'flag OFF never membership-repoints');
    assert.ok(await h.userExists(userId), 'the users row survives');

    const pointer = (await h.pool.query(`SELECT organization_id FROM users WHERE id=$1`, [userId])).rows[0];
    assert.equal(pointer.organization_id, null, 'flag OFF clears the strayed pointer to NULL (bare cascade)');
  });
});

// ── The deleted org's memberships are gone; a bystander org is untouched ─────

test('org-delete (requires-infra): the deleted org’s memberships + events are removed, a bystander member of ANOTHER org is untouched', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;
  await withHarness(async (h) => {
    const doomed = await h.org('DoomedB');
    const bystanderOrg = await h.org('Bystander');
    const doomedMember = await h.user({ email: 'doomed-member@acme.com', organizationId: doomed, role: 'tenant_admin' });
    await h.membership({ userId: doomedMember, organizationId: doomed, role: 'tenant_admin', status: 'active' });
    // A bystander whose pointer is NOT the doomed org and who is not a member of it.
    const bystander = await h.user({ email: 'bystander@acme.com', organizationId: bystanderOrg, role: 'tenant_admin' });
    await h.membership({ userId: bystander, organizationId: bystanderOrg, role: 'tenant_admin', status: 'active' });

    const result = await h.deleteOrg(doomed, FLAG_ON);
    assert.equal(result.membershipsRemoved, 1, 'the doomed org’s one membership was removed');

    const remainingDoomed = Number(
      (await h.pool.query(`SELECT count(*)::int AS n FROM organization_memberships WHERE organization_id=$1`, [doomed])).rows[0].n,
    );
    assert.equal(remainingDoomed, 0, 'no memberships remain for the deleted org');

    // The bystander's membership + pointer are entirely untouched.
    const bystanderClaims = await h.claims(bystander, FLAG_ON);
    assert.equal(Number(bystanderClaims!.tenant_id), bystanderOrg, 'the bystander is unaffected');
    assert.equal(bystanderClaims!.role, 'tenant_admin');
  });
});
