/**
 * Multi-workspace Phase 4 — second-workspace CREATE path entitlement +
 * self-escalation guard, against live Postgres (plan Decision 8a/8b + 13; the
 * onboarding create path `resolveTenantForDraftWithMemberships` in
 * app/onboarding/resume/page.tsx).
 *
 * The onboarding create path is an RSC that mutates on render, so its transaction
 * body is not an exported unit. This suite replays that EXACT composed sequence —
 * `assertMultiWorkspaceEntitlement` (FOR UPDATE count) → `createOrganizationWithUniqueSlug`
 * → `assignUserToOrganization(role:'tenant_admin')`, all inside one BEGIN, ROLLBACK
 * on denial — against the real schema, and asserts the invariants the mock-level
 * entitlement tests can't reach:
 *
 *   1. FREE account with ≥1 active membership creating a SECOND workspace → the
 *      entitlement helper denies it and the caller ROLLS BACK: NO organizations
 *      row, NO organization_memberships row, and the account's active pointer is
 *      UNCHANGED (nothing partially written — the load-bearing "nothing created"
 *      claim);
 *   2. PRO account → the second workspace + its ACTIVE tenant_admin membership are
 *      created and the pointer moves;
 *   3. ZERO-membership / FIRST workspace → free (created), never paywalled;
 *   4. SELF-ESCALATION GUARD (Decision 8b): the `role:'tenant_admin'` force-set
 *      only ever lands on the freshly-created org — the role the user holds in an
 *      EXISTING org they already belong to is never elevated by creating a new
 *      workspace (the legacy reuse-branch hole is gone: the create path never
 *      repoints an existing org).
 *
 * Isolation: a uniquely-named throwaway SCHEMA (search_path pinned per-pool),
 * CREATEd then DROPped — the pattern from
 * tests/tenant/multi-workspace-phase2-concurrency.requires-infra.test.ts. Point
 * DB_* at a THROWAWAY Postgres 16 (never prod) with
 * ARIES_TEST_REQUIRES_INFRA_ENABLED=1; see tests/REQUIRES_INFRA.md.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import pg from 'pg';

import { requireDbEnvOrSkip } from '../helpers/requires-infra';
import { assertMultiWorkspaceEntitlement } from '../../backend/tenant/entitlements';
import {
  assignUserToOrganization,
  createOrganizationWithUniqueSlug,
} from '../../lib/auth-tenant-membership';

// Minimal live schema (subset of scripts/init-db.js the create path touches).
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
    full_name TEXT,
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
`;

type PoolLike = pg.Pool;

/**
 * The create-path body, replaying app/onboarding/resume/page.tsx's
 * resolveTenantForDraftWithMemberships: user-row FOR UPDATE lock → entitlement gate
 * INSIDE the txn, ROLLBACK on denial (nothing created), else create org + assign
 * (role force-set) + COMMIT.
 */
async function runCreateSecondWorkspace(
  client: pg.PoolClient,
  input: { userId: number; businessName: string; slugBase: string },
): Promise<{ status: 'ok'; tenantId: string } | { status: 'requires_pro' }> {
  await client.query('BEGIN', []);
  try {
    // Mirror the real create path (resolveTenantForDraftWithMemberships): take
    // the create-path-local user-row FOR UPDATE lock BEFORE the entitlement count
    // so two simultaneous zero-membership creates serialize (the entitlement
    // helper's own FOR UPDATE locks nothing when there are zero active rows).
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [Number(input.userId)]);
    const entitlement = await assertMultiWorkspaceEntitlement(client, input.userId);
    if (!entitlement.allowed) {
      await client.query('ROLLBACK', []);
      return { status: 'requires_pro' };
    }
    const created = await createOrganizationWithUniqueSlug(client, {
      name: input.businessName,
      slugBase: input.slugBase,
    });
    await assignUserToOrganization(client, {
      userId: input.userId,
      organizationId: created.id,
      role: 'tenant_admin',
    });
    await client.query('COMMIT', []);
    return { status: 'ok', tenantId: String(created.id) };
  } catch (error) {
    await client.query('ROLLBACK', []);
    throw error;
  }
}

async function withHarness(
  fn: (ctx: {
    pool: PoolLike;
    org: (name: string) => Promise<number>;
    user: (input: {
      email: string;
      organizationId?: number | null;
      role?: string;
      plan?: string;
    }) => Promise<number>;
    membership: (input: {
      userId: number;
      organizationId: number;
      role: string;
      status: 'invited' | 'active';
    }) => Promise<void>;
    orgCount: () => Promise<number>;
    membershipRows: (userId: number) => Promise<Array<{ organization_id: number; role: string; status: string }>>;
    pointerOf: (userId: number) => Promise<{ organization_id: number | null; role: string }>;
  }) => Promise<void>,
): Promise<void> {
  const schema = `mw_p4_create_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
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
          `INSERT INTO users (email, organization_id, role, plan) VALUES ($1,$2,$3,$4) RETURNING id`,
          [input.email, input.organizationId ?? null, input.role ?? 'tenant_admin', input.plan ?? 'free'],
        );
        return Number(r.rows[0].id);
      },
      async membership(input) {
        await pool.query(
          `INSERT INTO organization_memberships (user_id, organization_id, role, status, accepted_at, last_active_at, created_at, updated_at)
           VALUES ($1,$2,$3,$4, CASE WHEN $4='active' THEN now() END, CASE WHEN $4='active' THEN now() END, now(), now())`,
          [input.userId, input.organizationId, input.role, input.status],
        );
      },
      async orgCount() {
        return Number((await pool.query(`SELECT count(*)::int AS n FROM organizations`)).rows[0].n);
      },
      async membershipRows(userId) {
        return (
          await pool.query(
            `SELECT organization_id, role, status FROM organization_memberships WHERE user_id=$1 ORDER BY organization_id`,
            [userId],
          )
        ).rows.map((r: { organization_id: number; role: string; status: string }) => ({
          organization_id: Number(r.organization_id),
          role: r.role,
          status: r.status,
        }));
      },
      async pointerOf(userId) {
        const r = (await pool.query(`SELECT organization_id, role FROM users WHERE id=$1`, [userId])).rows[0];
        return { organization_id: r.organization_id === null ? null : Number(r.organization_id), role: r.role };
      },
    });
  } finally {
    await pool.end().catch(() => {});
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => {});
    await admin.end().catch(() => {});
  }
}

// ── 1. FREE account, second workspace → denied, NOTHING created ──────────────

test('create (requires-infra): a FREE account creating a SECOND workspace is denied — no org, no membership, pointer unchanged', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;
  await withHarness(async (h) => {
    const orgA = await h.org('OrgA');
    const userId = await h.user({ email: 'free@acme.com', organizationId: orgA, role: 'tenant_admin', plan: 'free' });
    await h.membership({ userId, organizationId: orgA, role: 'tenant_admin', status: 'active' });

    const orgsBefore = await h.orgCount();

    const client = await h.pool.connect();
    let result;
    try {
      result = await runCreateSecondWorkspace(client, { userId, businessName: 'Second Co', slugBase: 'second-co' });
    } finally {
      client.release();
    }

    assert.deepEqual(result, { status: 'requires_pro' }, 'a free account is denied the second workspace');

    // NOTHING was created — the load-bearing "no partial write on denial" claim.
    assert.equal(await h.orgCount(), orgsBefore, 'no organizations row was created on denial');
    const memberships = await h.membershipRows(userId);
    assert.deepEqual(
      memberships,
      [{ organization_id: orgA, role: 'tenant_admin', status: 'active' }],
      'the account still has only its original membership — no second membership written',
    );
    // The active pointer + role were not touched.
    assert.deepEqual(await h.pointerOf(userId), { organization_id: orgA, role: 'tenant_admin' }, 'pointer unchanged');
  });
});

// ── 2. PRO account, second workspace → created ──────────────────────────────

test('create (requires-infra): a PRO account creating a SECOND workspace gets a new org + active admin membership + repointed', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;
  await withHarness(async (h) => {
    const orgA = await h.org('OrgA');
    const userId = await h.user({ email: 'pro@acme.com', organizationId: orgA, role: 'tenant_admin', plan: 'pro' });
    await h.membership({ userId, organizationId: orgA, role: 'tenant_admin', status: 'active' });

    const client = await h.pool.connect();
    let result;
    try {
      result = await runCreateSecondWorkspace(client, { userId, businessName: 'Second Co', slugBase: 'second-co' });
    } finally {
      client.release();
    }

    assert.equal(result.status, 'ok', 'a pro account may create a second workspace');
    const newTenantId = Number((result as { tenantId: string }).tenantId);

    const memberships = await h.membershipRows(userId);
    assert.equal(memberships.length, 2, 'the account now holds two memberships');
    const newMembership = memberships.find((m) => m.organization_id === newTenantId);
    assert.ok(newMembership, 'a membership on the new org exists');
    assert.equal(newMembership!.role, 'tenant_admin', 'the new-org membership is admin');
    assert.equal(newMembership!.status, 'active', 'the new-org membership is active');

    // The active pointer moved to the created org.
    assert.equal((await h.pointerOf(userId)).organization_id, newTenantId, 'pointer moved to the created org');
  });
});

// ── 3. ZERO-membership / FIRST workspace → free ─────────────────────────────

test('create (requires-infra): a ZERO-membership account creating its FIRST workspace is FREE (created, never paywalled)', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;
  await withHarness(async (h) => {
    // Free account, NO memberships, NULL pointer (the zero-membership chooser state).
    const userId = await h.user({ email: 'firsttimer@acme.com', organizationId: null, role: 'tenant_admin', plan: 'free' });

    const client = await h.pool.connect();
    let result;
    try {
      result = await runCreateSecondWorkspace(client, { userId, businessName: 'First Co', slugBase: 'first-co' });
    } finally {
      client.release();
    }

    assert.equal(result.status, 'ok', 'a free account with zero memberships is not paywalled on its FIRST workspace');
    const memberships = await h.membershipRows(userId);
    assert.equal(memberships.length, 1, 'exactly one (first) membership created');
    assert.equal(memberships[0].status, 'active');
  });
});

// ── 4. SELF-ESCALATION GUARD (Decision 8b) ──────────────────────────────────

test('create (requires-infra): self-escalation guard — creating a new workspace never elevates the role in an EXISTING org (8b)', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;
  await withHarness(async (h) => {
    // The user is a mere VIEWER of an existing org (orgA). They are PRO so the
    // second-workspace create is allowed — the point is that the tenant_admin
    // force-set must land ONLY on the newly-created org, never on orgA.
    const orgA = await h.org('OrgA');
    const userId = await h.user({ email: 'viewer@acme.com', organizationId: orgA, role: 'tenant_viewer', plan: 'pro' });
    await h.membership({ userId, organizationId: orgA, role: 'tenant_viewer', status: 'active' });

    const client = await h.pool.connect();
    let result;
    try {
      result = await runCreateSecondWorkspace(client, { userId, businessName: 'New WS', slugBase: 'new-ws' });
    } finally {
      client.release();
    }

    assert.equal(result.status, 'ok');
    const newTenantId = Number((result as { tenantId: string }).tenantId);

    const memberships = await h.membershipRows(userId);
    const orgAMembership = memberships.find((m) => m.organization_id === orgA);
    const newMembership = memberships.find((m) => m.organization_id === newTenantId);

    // The existing-org role is UNTOUCHED — still viewer. The tenant_admin only
    // ever landed on the freshly-created org (the 8b self-escalation hole is gone).
    assert.equal(orgAMembership!.role, 'tenant_viewer', 'the existing-org membership role is NOT elevated by creating a new workspace');
    assert.equal(newMembership!.role, 'tenant_admin', 'admin only on the newly-created org');
  });
});

// ── 5. CONCURRENT double-create TOCTOU (Phase 4 review finding) ──────────────

type RaceOutcome<T> = { ok: true; value: T } | { ok: false; error: { code?: string; message: string } };

/**
 * Fire two create transactions on their OWN pre-warmed backends behind a shared
 * barrier so their critical sections (entitlement count → membership insert)
 * genuinely overlap — the same overlap-forcing discipline as
 * multi-workspace-phase2-concurrency.requires-infra.test.ts. A naive
 * Promise.all without pre-warm + barrier lets the first txn commit before the
 * second's BEGIN lands (a false green that never exercises the lock window).
 */
async function race2Create(
  pool: PoolLike,
  userId: number,
  round: number,
): Promise<[RaceOutcome<{ status: string }>, RaceOutcome<{ status: string }>]> {
  const clientA = await pool.connect();
  const clientB = await pool.connect();
  await Promise.all([clientA.query('SELECT 1'), clientB.query('SELECT 1')]);
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const wrap = (p: Promise<{ status: string }>): Promise<RaceOutcome<{ status: string }>> =>
    p.then(
      (value): RaceOutcome<{ status: string }> => ({ ok: true, value }),
      (error): RaceOutcome<{ status: string }> => ({
        ok: false,
        error: {
          code: (error as { code?: string } | null)?.code,
          message: error instanceof Error ? error.message : String(error),
        },
      }),
    );
  const runA = wrap(
    barrier.then(() =>
      runCreateSecondWorkspace(clientA, { userId, businessName: `Race a r${round}`, slugBase: `race-a-r${round}` }),
    ),
  );
  const runB = wrap(
    barrier.then(() =>
      runCreateSecondWorkspace(clientB, { userId, businessName: `Race b r${round}`, slugBase: `race-b-r${round}` }),
    ),
  );
  release();
  try {
    return await Promise.all([runA, runB]);
  } finally {
    clientA.release();
    clientB.release();
  }
}

test('create (requires-infra): two SIMULTANEOUS creates from a zero-membership FREE account mint exactly ONE workspace (no free-second-workspace slip)', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;
  // Warm loop: force genuine overlap MANY times in one warm process. Without the
  // create-path user-row FOR UPDATE lock, assertMultiWorkspaceEntitlement's
  // FOR UPDATE locks nothing (zero active membership rows), so two concurrent
  // creates could BOTH pass as "first workspace" and both commit — two free
  // workspaces. The lock serializes them: the loser blocks until the winner
  // commits its membership, then sees 1 active membership and is denied (free).
  const ROUNDS = 25;
  await withHarness(async (h) => {
    for (let round = 0; round < ROUNDS; round++) {
      // Fresh brand-new free account each round: NO memberships, NULL pointer.
      const userId = await h.user({
        email: `race-${round}@acme.com`,
        organizationId: null,
        role: 'tenant_admin',
        plan: 'free',
      });
      const orgsBefore = await h.orgCount();

      const [rA, rB] = await race2Create(h.pool, userId, round);

      // Every arm resolves to a KNOWN safe shape — a typed status or a safe
      // serialization/deadlock abort — never an unhandled error.
      for (const r of [rA, rB]) {
        const known =
          (r.ok && (r.value.status === 'ok' || r.value.status === 'requires_pro')) ||
          (!r.ok && (r.error.code === '40P01' || r.error.code === '40001'));
        assert.ok(
          known,
          `round ${round}: each create resolves to ok/requires_pro or a safe abort (got ${JSON.stringify(r)})`,
        );
      }

      // The load-bearing invariant: NEVER two active memberships / two orgs for
      // the same free account, regardless of which arm won or whether one aborted.
      const memberships = await h.membershipRows(userId);
      const active = memberships.filter((m) => m.status === 'active');
      assert.ok(
        active.length <= 1,
        `round ${round}: at most one active membership after concurrent creates — no free second workspace slipped (got ${active.length})`,
      );
      assert.ok(
        (await h.orgCount()) <= orgsBefore + 1,
        `round ${round}: at most one org created across both concurrent attempts`,
      );
    }
  });
});
