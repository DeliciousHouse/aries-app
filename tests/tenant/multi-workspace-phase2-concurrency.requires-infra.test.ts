/**
 * Multi-workspace Phase 2 — TRUE concurrency races against live Postgres
 * (docs/plans/2026-07-03-multi-workspace-membership.md: CEO hardening 1/2/6,
 * E4 last-admin guard, eng findings 3/4/5/6; Decision 13 entitlement TOCTOU).
 *
 * The mock-level tests prove the SQL is SHAPED right; only real Postgres proves
 * the LOCKS actually serialize. Each test runs the real backend functions
 * (acceptWorkspaceInvitation / acceptJoinInvitation / inviteWorkspaceMember /
 * updateTenantUserProfile / deleteTenantUserProfile) against a live schema,
 * driving two overlapping transactions and asserting the invariant that a
 * READ COMMITTED interleaving would otherwise violate:
 *
 *   1. accept-vs-signin TOCTOU — a token minted while pending, accepted after
 *      the account flips active (concurrent password set), never writes a
 *      second password / never double-activates.
 *   2. concurrent duplicate invite (same org) → ONE membership row, newest
 *      token wins (ON CONFLICT, no 500).
 *   3. cross-org concurrent FIRST invite (same brand-new email) → ONE users
 *      row, BOTH memberships (ON CONFLICT (email)), no 500.
 *   4. symmetric concurrent admin demotes → never zero admins (E4 FOR UPDATE).
 *   5. concurrent double-accept of a second workspace under the free limit →
 *      exactly ONE succeeds, the other 402 (entitlement FOR UPDATE count).
 *   6. accept-vs-revoke race → the revoked accept sees expired/not_join, never
 *      a silent 0-row success.
 *
 * Isolation: a uniquely-named throwaway SCHEMA (search_path pinned per-pool)
 * that is CREATEd then DROPped — the same pattern as
 * tests/tenant/membership-backfill.requires-infra.test.ts. A real database is
 * never touched beyond CREATE/DROP SCHEMA of a test-only schema. Point DB_* at a
 * THROWAWAY Postgres 16 (never prod) with ARIES_TEST_REQUIRES_INFRA_ENABLED=1;
 * see tests/REQUIRES_INFRA.md.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import pg from 'pg';

import { requireDbEnvOrSkip } from '../helpers/requires-infra';
import {
  acceptJoinInvitation,
  acceptWorkspaceInvitation,
  generateInviteToken,
  hashInviteToken,
  inviteWorkspaceMember,
} from '../../backend/tenant/workspace-invitations';
import {
  deleteTenantUserProfile,
  updateTenantUserProfile,
} from '../../backend/tenant/user-profiles';

const FLAG_ON = { ARIES_MULTI_WORKSPACE_ENABLED: '1', NODE_ENV: 'test' } as NodeJS.ProcessEnv;

// Minimal live schema: the tables Phase 2's writes touch. Column shapes mirror
// scripts/init-db.js (only what the accept/invite/remove paths read/write).
const SCHEMA_DDL = `
  CREATE TABLE organizations (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT UNIQUE,
    created_at TIMESTAMPTZ DEFAULT now()
  );
  -- email TEXT UNIQUE NOT NULL mirrors scripts/init-db.js: the column-level
  -- UNIQUE is what the code's ON CONFLICT (email) targets (the LOWER(email)
  -- functional index is an ADDITIONAL case-insensitive guard, not the conflict
  -- arbiter). Reproducing both is load-bearing for the cross-org race test.
  CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name TEXT,
    organization_id INTEGER REFERENCES organizations(id),
    role TEXT NOT NULL DEFAULT 'tenant_admin',
    plan TEXT NOT NULL DEFAULT 'free',
    onboarding_completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE UNIQUE INDEX idx_users_email_lower_unique ON users (LOWER(email));
  CREATE TABLE workspace_invitations (
    id BIGSERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    role TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    invited_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    accepted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX idx_workspace_invitations_token_hash ON workspace_invitations (token_hash);
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
  -- The orphan predicate the invite path reads; supply the tables it EXISTS-checks
  -- so a non-orphan (has activity) forces the second-workspace path, never absorb.
  CREATE TABLE business_profiles (tenant_id INTEGER, id SERIAL PRIMARY KEY);
  CREATE TABLE posts (tenant_id INTEGER, id SERIAL PRIMARY KEY);
  CREATE TABLE connected_accounts (tenant_id INTEGER, id SERIAL PRIMARY KEY);
  CREATE TABLE creative_assets (tenant_id INTEGER, id SERIAL PRIMARY KEY, checksum TEXT);
`;

const STRONG_PASSWORD = 'Aa1!aaaa';
const PENDING = 'invited_pending';
const REAL_HASH = '$2a$12$realbcrypthashaaaaaaaaaaaa';

type PoolLike = pg.Pool;

/**
 * Per-arm outcome of a concurrent race. Under genuine transaction overlap a
 * losing arm may not return a typed status at all — Postgres can abort it with
 * a serialization/deadlock error (SQLSTATE 40P01 / 40001). That is a SAFE
 * resolution (the aborted txn rolled back, so the invariant is preserved) but
 * it is NOT a graceful typed status: the route handler surfaces it as a 500 the
 * client retries. race2 therefore hands each outcome back per-arm instead of
 * throwing, so a test can assert the real safety contract ("invariant held AND
 * every arm resolved to a typed status OR a serialization abort — never a
 * silent success") rather than a graceful-status contract the implementation
 * does not actually guarantee under a symmetric cross-table lock race.
 */
type RaceOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code?: string; message: string } };

/**
 * SQLSTATE codes under which Postgres SAFELY aborts one arm of a concurrent
 * transaction race (the aborted txn rolls back → invariant preserved). Each is
 * a retriable failure the route surfaces as a 500 the client retries, NOT a
 * broken-state bug:
 *   - 40P01 deadlock_detected: two txns took cross-table row locks in opposing
 *     order (the symmetric-demote + accept-vs-revoke races).
 *   - 40001 serialization_failure: a serialization-isolation conflict.
 *   - 23505 unique_violation: the create-or-select ON CONFLICT (email) race can
 *     surface a raw unique_violation on the LOWER(email) functional index (the
 *     `ON CONFLICT (email)` arbiter targets the column-level UNIQUE, not the
 *     functional one) — see the fresh-eyes finding filed with this suite. It is
 *     a safe abort (no partial write commits) but it is a rougher edge than the
 *     eng-finding-6 "never 500s" claim implies.
 */
const SAFE_ABORT_CODES = new Set(['40P01', '40001', '23505']);

function isSerializationAbort<T>(outcome: RaceOutcome<T>): boolean {
  return !outcome.ok && Boolean(outcome.error.code && SAFE_ABORT_CODES.has(outcome.error.code));
}

/** The typed status of an arm that returned, or a sentinel for an aborted arm. */
function statusOf<T extends { status: string }>(outcome: RaceOutcome<T>): string {
  return outcome.ok ? outcome.value.status : `abort:${outcome.error.code ?? 'unknown'}`;
}

async function withHarness(
  fn: (ctx: {
    pool: PoolLike;
    /**
     * Run TWO operations concurrently, each on its OWN dedicated, pre-warmed
     * PoolClient, exactly as two overlapping route-handler requests would
     * (`const client = await pool.connect(); … client.release()`, see
     * app/api/auth/invite/join/route.ts + app/api/tenant/profiles/[userId]/route.ts).
     *
     * Two things this fixes over the previous `Promise.all([fn(h.pool), …])`:
     *
     * 1. DEDICATED CONNECTIONS. The accept/invite/CRUD functions issue
     *    BEGIN/COMMIT/ROLLBACK and SELECT … FOR UPDATE assuming ONE dedicated
     *    connection. Handing them a `pg.Pool` lets each `.query()` grab a
     *    DIFFERENT backend, so the BEGIN and the FOR UPDATE land on separate
     *    connections — the transaction framing and the row locks are silently
     *    no-ops and the "race" never actually serializes (its green proves
     *    nothing). Each arm here gets its own `pool.connect()` client.
     *
     * 2. GENUINE OVERLAP. Both clients are connected AND round-tripped
     *    (`SELECT 1`) BEFORE either operation starts, so connection-establish
     *    latency is out of the critical path. Both ops are then fired on the
     *    same microtask turn behind a shared barrier — so under cold-start
     *    `tsx --test` the two transactions genuinely BEGIN and take their first
     *    lock before either commits. Without the pre-warm, connect latency
     *    dominates and the first txn commits before the second's BEGIN lands —
     *    the window closes and the lock is never exercised (a false green). See
     *    the harness-fix notes: this is what makes the FOR-UPDATE red-proof
     *    reproducible instead of timing-dependent.
     */
    race2: <A, B>(
      opA: (client: pg.PoolClient) => Promise<A>,
      opB: (client: pg.PoolClient) => Promise<B>,
    ) => Promise<[RaceOutcome<A>, RaceOutcome<B>]>;
    /** Insert an org, return its id. */
    org: (name: string) => Promise<number>;
    /** Insert a user, return its id. */
    user: (input: {
      email: string;
      passwordHash?: string;
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
    /** Mint an invitation row + return the raw token. */
    invitation: (input: {
      organizationId: number;
      userId: number;
      email: string;
      role: string;
      invitedByUserId?: number | null;
      expiresAt?: Date;
    }) => Promise<string>;
    activeCount: (userId: number) => Promise<number>;
    activeAdmins: (orgId: number) => Promise<number[]>;
    /**
     * TRUNCATE every table (restart identity) so a test can re-seed and re-run
     * a race MANY times inside ONE warm process. Multi-statement races (the
     * symmetric demote + accept-vs-revoke, whose two txns lock rows in opposing
     * order across tables) only reliably overlap when the connections + JIT are
     * warm: a single cold `tsx --test` invocation of one race often lets the
     * first txn commit before the second reaches its critical read, so a single
     * shot is NOT a dependable red-proof of the lock. Looping the race warm is
     * what makes both the green (invariant holds every round) AND the red-proof
     * (strip the lock → the invariant breaks within a handful of rounds)
     * reproducible. See the harness-fix notes.
     */
    reset: () => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const schema = `mw_p2_conc_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
  const admin = new pg.Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    max: 1,
  });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  // max high enough for two concurrent long-held transactions + helper queries.
  const pool = new pg.Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    max: 8,
    options: `-c search_path="${schema}"`,
  });
  try {
    await pool.query(SCHEMA_DDL);
    await fn({
      pool,
      async race2(opA, opB) {
        // search_path is pinned at the pool level (options: -c search_path),
        // so a checked-out client already resolves the throwaway schema — the
        // client just guarantees each operation's whole txn rides ONE backend.
        const clientA = await pool.connect();
        const clientB = await pool.connect();
        // Pre-warm both backends so connection-establish latency is OUT of the
        // critical path — otherwise the first txn commits before the second's
        // BEGIN lands and the row-lock window never opens (a false green).
        await Promise.all([clientA.query('SELECT 1'), clientB.query('SELECT 1')]);
        // Fire both on the same turn behind a shared barrier so the two
        // transactions genuinely overlap (both BEGIN + take their first lock
        // before either commits).
        let release!: () => void;
        const barrier = new Promise<void>((resolve) => {
          release = resolve;
        });
        const wrap = <T>(p: Promise<T>): Promise<RaceOutcome<T>> =>
          p.then(
            (value): RaceOutcome<T> => ({ ok: true, value }),
            (error): RaceOutcome<T> => ({
              ok: false,
              error: {
                code: (error as { code?: string } | null)?.code,
                message: error instanceof Error ? error.message : String(error),
              },
            }),
          );
        const runA = wrap(barrier.then(() => opA(clientA)));
        const runB = wrap(barrier.then(() => opB(clientB)));
        release();
        try {
          return await Promise.all([runA, runB]);
        } finally {
          clientA.release();
          clientB.release();
        }
      },
      async org(name) {
        const r = await pool.query(`INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`, [
          name,
          `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${crypto.randomBytes(2).toString('hex')}`,
        ]);
        return Number(r.rows[0].id);
      },
      async user(input) {
        const r = await pool.query(
          `INSERT INTO users (email, password_hash, organization_id, role, plan) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [
            input.email,
            input.passwordHash ?? REAL_HASH,
            input.organizationId ?? null,
            input.role ?? 'tenant_admin',
            input.plan ?? 'free',
          ],
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
      async invitation(input) {
        const { rawToken, tokenHash } = generateInviteToken();
        await pool.query(
          `INSERT INTO workspace_invitations (organization_id, user_id, email, role, token_hash, invited_by_user_id, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            input.organizationId,
            input.userId,
            input.email,
            input.role,
            tokenHash,
            input.invitedByUserId ?? null,
            input.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          ],
        );
        return rawToken;
      },
      async activeCount(userId) {
        const r = await pool.query(
          `SELECT count(*)::int AS n FROM organization_memberships WHERE user_id=$1 AND status='active'`,
          [userId],
        );
        return Number(r.rows[0].n);
      },
      async activeAdmins(orgId) {
        const r = await pool.query(
          `SELECT user_id FROM organization_memberships WHERE organization_id=$1 AND role='tenant_admin' AND status='active' ORDER BY user_id`,
          [orgId],
        );
        return r.rows.map((row: { user_id: number }) => Number(row.user_id));
      },
      async reset() {
        await pool.query(
          `TRUNCATE organization_membership_events, organization_memberships, workspace_invitations,
                    creative_assets, connected_accounts, posts, business_profiles, users, organizations
             RESTART IDENTITY CASCADE`,
        );
      },
    });
  } finally {
    await pool.end().catch(() => {});
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => {});
    await admin.end().catch(() => {});
  }
}

// ── 1. accept-vs-signin TOCTOU ──────────────────────────────────────────────

test('concurrency: accept-vs-signin TOCTOU — a pending token accepted after the account flips active never writes a second password', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;
  await withHarness(async (h) => {
    const orgA = await h.org('OrgA');
    const orgB = await h.org('OrgB');
    // The account is pending, invited to BOTH orgs (the classic dual-invite).
    const userId = await h.user({ email: 'toctou@acme.com', passwordHash: PENDING, organizationId: orgA });
    await h.membership({ userId, organizationId: orgA, role: 'tenant_analyst', status: 'invited' });
    await h.membership({ userId, organizationId: orgB, role: 'tenant_viewer', status: 'invited' });
    const tokenA = await h.invitation({ organizationId: orgA, userId, email: 'toctou@acme.com', role: 'tenant_analyst' });
    const tokenB = await h.invitation({ organizationId: orgB, userId, email: 'toctou@acme.com', role: 'tenant_viewer' });

    // Two accepts race: A via set-password (the account is pending), B via
    // set-password too. Exactly one may write a password; the other must see
    // the account already credentialed and refuse (not_pending), never
    // overwriting the password the winner just set.
    const [resA, resB] = await h.race2(
      (c) => acceptWorkspaceInvitation(c, { rawToken: tokenA, password: STRONG_PASSWORD }, FLAG_ON),
      (c) => acceptWorkspaceInvitation(c, { rawToken: tokenB, password: 'Zz9@zzzz' }, FLAG_ON),
    );

    // Both accepts take the SAME user row FOR UPDATE as their first lock (same
    // account), so they serialize consistently on that one row — no cross-table
    // lock cycle, no deadlock: this race resolves gracefully. Exactly one writes
    // the password; the other re-reads the now-credentialed row under its lock
    // and refuses (not_pending), never overwriting the winner's password. (An
    // abort is a legal-but-not-expected fallback; the primary contract is the
    // graceful split, which the shared-row lock guarantees deterministically.)
    const statuses = [statusOf(resA), statusOf(resB)].sort();
    assert.deepEqual(
      statuses,
      ['not_pending', 'ok'],
      'exactly one accept sets the password; the other is refused not_pending (shared user-row lock serializes them)',
    );

    // The winning password stands: exactly one bcrypt hash is stored, it is NOT
    // the pending sentinel, and it is one of the two candidate passwords (never
    // a torn/overwritten value).
    const row = (await h.pool.query(`SELECT password_hash FROM users WHERE id=$1`, [userId])).rows[0];
    assert.notEqual(row.password_hash, PENDING, 'the account is no longer pending');
    assert.ok((row.password_hash as string).startsWith('$2'), 'a real bcrypt hash is stored');

    // Exactly ONE membership is active (the winner's org); the loser's stays invited.
    const active = await h.activeCount(userId);
    assert.equal(active, 1, 'only the winning org membership activated — no double-activation');
  });
});

// ── 2. concurrent duplicate invite (same org) ──────────────────────────────

test('concurrency: two admins inviting the same existing account into the SAME org → one membership, newest token, no 500', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;
  await withHarness(async (h) => {
    const orgHome = await h.org('OrgHome');
    const orgTarget = await h.org('OrgTarget');
    // Existing ACTIVE account whose own workspace is NOT an orphan (has posts) →
    // the second-workspace invite path, not absorb.
    const existing = await h.user({ email: 'dup@acme.com', organizationId: orgHome, role: 'tenant_admin' });
    await h.membership({ userId: existing, organizationId: orgHome, role: 'tenant_admin', status: 'active' });
    await h.pool.query(`INSERT INTO posts (tenant_id) VALUES ($1)`, [orgHome]);
    const admin1 = await h.user({ email: 'admin1@target.com', organizationId: orgTarget, role: 'tenant_admin' });
    const admin2 = await h.user({ email: 'admin2@target.com', organizationId: orgTarget, role: 'tenant_admin' });

    const [r1, r2] = await h.race2(
      (c) => inviteWorkspaceMember(c, { organizationId: String(orgTarget), email: 'dup@acme.com', role: 'tenant_analyst', invitedByUserId: String(admin1) }, FLAG_ON),
      (c) => inviteWorkspaceMember(c, { organizationId: String(orgTarget), email: 'dup@acme.com', role: 'tenant_viewer', invitedByUserId: String(admin2) }, FLAG_ON),
    );

    // No BUSINESS 500 (the ON CONFLICT idempotency claim): every arm that
    // returns a status returns the existing-account happy path — never an
    // unexpected typed failure. An arm MAY instead be aborted by Postgres with
    // a serialization/deadlock error (two invites racing the same membership +
    // token supersede can cycle); that is a retriable 500 the route surfaces,
    // NOT the idempotency-500 this test guards. Either way the PERSISTED state
    // below must be coherent — that is the real invariant.
    for (const r of [r1, r2]) {
      if (r.ok) {
        assert.equal(
          r.value.status,
          'invited_existing_account',
          'a returning arm reports the idempotent existing-account happy path, never an unexpected status',
        );
      } else {
        assert.ok(
          isSerializationAbort(r),
          `a non-returning arm aborted only via serialization/deadlock, never an unhandled error (got ${r.error.code}: ${r.error.message})`,
        );
      }
    }
    // At least one arm committed (the race can't lose both).
    assert.ok(r1.ok || r2.ok, 'at least one concurrent invite commits');

    // Exactly ONE (existing, orgTarget) membership row, still invited.
    const memberships = (
      await h.pool.query(
        `SELECT role, status FROM organization_memberships WHERE user_id=$1 AND organization_id=$2`,
        [existing, orgTarget],
      )
    ).rows;
    assert.equal(memberships.length, 1, 'exactly one membership row despite the race');
    assert.equal(memberships[0].status, 'invited');

    // Newest token wins: exactly one live (unexpired, unaccepted) invitation.
    const live = (
      await h.pool.query(
        `SELECT count(*)::int AS n FROM workspace_invitations WHERE user_id=$1 AND organization_id=$2 AND accepted_at IS NULL AND expires_at > now()`,
        [existing, orgTarget],
      )
    ).rows[0];
    assert.equal(live.n, 1, 'the supersede leaves exactly one live token (newest wins)');
  });
});

// ── 3. cross-org concurrent FIRST invite (brand-new email) ─────────────────

test('concurrency: two orgs inviting the SAME brand-new email → one users row, both memberships, no 500', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;
  await withHarness(async (h) => {
    const orgX = await h.org('OrgX');
    const orgY = await h.org('OrgY');
    const adminX = await h.user({ email: 'adminx@x.com', organizationId: orgX, role: 'tenant_admin' });
    const adminY = await h.user({ email: 'adminy@y.com', organizationId: orgY, role: 'tenant_admin' });

    const [rx, ry] = await h.race2(
      (c) => inviteWorkspaceMember(c, { organizationId: String(orgX), email: 'fresh@new.com', role: 'tenant_analyst', invitedByUserId: String(adminX) }, FLAG_ON),
      (c) => inviteWorkspaceMember(c, { organizationId: String(orgY), email: 'fresh@new.com', role: 'tenant_viewer', invitedByUserId: String(adminY) }, FLAG_ON),
    );

    // Every arm that RETURNS reports a create-or-select happy path (eng
    // finding 6). Under genuine overlap a losing arm may instead abort with a
    // SAFE serialization/unique-violation error — the loser's whole txn rolls
    // back (no partial write commits). NOTE the honest edge: `ON CONFLICT
    // (email)` targets the column-level UNIQUE, not the LOWER(email) functional
    // index, so a same-instant collision can surface a raw 23505 rather than
    // the clean loser-attaches path — a rougher edge than "never 500s" implies
    // (filed with this suite as a fresh-eyes finding). Both are safe: the users
    // invariant below holds regardless.
    for (const r of [rx, ry]) {
      if (r.ok) {
        assert.ok(
          r.value.status === 'invited' || r.value.status === 'invited_existing_account',
          `a returning arm reports the create-or-select happy path (got ${r.value.status})`,
        );
      } else {
        assert.ok(
          isSerializationAbort(r),
          `a non-returning arm aborted only via a SAFE serialization/unique error, never an unhandled failure (got ${r.error.code}: ${r.error.message})`,
        );
      }
    }
    assert.ok(rx.ok || ry.ok, 'at least one concurrent invite commits');

    // THE load-bearing invariant: exactly ONE users row for the email — never a
    // duplicate account — no matter how the race resolves (both-commit OR
    // one-aborts). This is what the UNIQUE(LOWER(email)) guard protects and it
    // holds unconditionally.
    const userRows = (await h.pool.query(`SELECT id FROM users WHERE LOWER(email)=LOWER($1)`, ['fresh@new.com'])).rows;
    assert.equal(userRows.length, 1, 'one email → one users row despite the cross-org race');
    const userId = Number(userRows[0].id);

    // Membership shape follows how the race resolved: both arms committed →
    // both orgs present (the loser attached to the winner's row); one arm
    // aborted → only the committed arm's membership, and it belongs to that
    // arm's org. Every membership is 'invited'.
    const memberships = (
      await h.pool.query(
        `SELECT organization_id, status FROM organization_memberships WHERE user_id=$1 ORDER BY organization_id`,
        [userId],
      )
    ).rows;
    const bothCommitted = rx.ok && ry.ok;
    const orgIds = memberships.map((m: { organization_id: number }) => Number(m.organization_id)).sort();
    if (bothCommitted) {
      assert.equal(memberships.length, 2, 'both commits → the loser attaches a membership to the winner row (both orgs present)');
      assert.deepEqual(orgIds, [orgX, orgY].sort());
    } else {
      assert.equal(memberships.length, 1, 'one arm aborted → exactly the committed arm’s single membership');
      const committedOrg = rx.ok ? orgX : orgY;
      assert.deepEqual(orgIds, [committedOrg], 'the surviving membership belongs to the committed arm’s org');
    }
    assert.ok(memberships.every((m: { status: string }) => m.status === 'invited'));
  });
});

// ── 4. symmetric concurrent admin demotes ──────────────────────────────────

test('concurrency: symmetric demotes (A demotes B while B demotes A) never produce zero admins', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;
  // Run the race WARM in a loop within one process — a single cold `tsx --test`
  // shot of this multi-statement race often lets the first txn commit before
  // the second reaches its critical section, so it does NOT reliably overlap.
  // Looping warm forces genuine simultaneity every round.
  //
  // GRACEFUL CONTRACT (Phase 4 hardening — the deadlock-retry fix landed). Under
  // genuine overlap the two demotes lock the users / organization_memberships
  // rows AND take FK share-locks (the `organization_membership_events` insert
  // references BOTH user_id and actor_user_id → each demote needs a share lock
  // on the OTHER admin's users row, which the other txn holds exclusive) in
  // OPPOSING order, so Postgres aborts one arm with a deadlock (40P01) before
  // the E4 last-admin count runs. `updateTenantUserProfile` now wraps the whole
  // membership txn in `withDeadlockRetry` (backend/tenant/txn-retry.ts): the
  // aborted arm's connection is already rolled back + clean, so it re-runs, and
  // on the retry it re-reads the winner's now-committed demotion under fresh
  // FOR UPDATE locks — sees zero OTHER active admins — and returns the graceful
  // `last_admin` 409 instead of surfacing a retriable 500. So the contract is
  // now the crisp one:
  //   • the zero-admins invariant holds every round (unchanged);
  //   • exactly one arm commits 'ok', the loser resolves to 'last_admin' (the
  //     graceful guard result) — a raw deadlock abort no longer leaks out;
  //   • the guard's FOR UPDATE serialization is what does the work on the retry.
  const ROUNDS = 25;
  await withHarness(async (h) => {
    let sawGraceful = false;
    let sawUnretriedDeadlock = false;
    for (let round = 0; round < ROUNDS; round++) {
      await h.reset();
      const org = await h.org('OrgAdmins');
      // Two admins, each the active pointer of this org (so the mirror is defined).
      const adminA = await h.user({ email: 'a@org.com', organizationId: org, role: 'tenant_admin' });
      const adminB = await h.user({ email: 'b@org.com', organizationId: org, role: 'tenant_admin' });
      await h.membership({ userId: adminA, organizationId: org, role: 'tenant_admin', status: 'active' });
      await h.membership({ userId: adminB, organizationId: org, role: 'tenant_admin', status: 'active' });

      // A demotes B while B demotes A — both to viewer, concurrently.
      const [rAB, rBA] = await h.race2(
        (c) => updateTenantUserProfile(c, { tenantId: String(org), userId: String(adminB), role: 'tenant_viewer', actorUserId: String(adminA) }, FLAG_ON),
        (c) => updateTenantUserProfile(c, { tenantId: String(org), userId: String(adminA), role: 'tenant_viewer', actorUserId: String(adminB) }, FLAG_ON),
      );

      // THE invariant, asserted every round and unconditionally: the org never
      // drops to zero active admins, no matter HOW the race resolves.
      const admins = await h.activeAdmins(org);
      assert.equal(
        admins.length,
        1,
        `round ${round}: exactly one active admin survives the symmetric demote race (never zero)`,
      );

      // Never a silent double-success (that WOULD be zero admins): at most one
      // arm committed 'ok'.
      const okCount = [rAB, rBA].filter((r) => r.ok && r.value.status === 'ok').length;
      assert.ok(
        okCount <= 1,
        `round ${round}: never both demotes succeed — that would be zero admins (got ${statusOf(rAB)} / ${statusOf(rBA)})`,
      );

      // Every arm resolves to a KNOWN safe shape — a typed status
      // (ok / last_admin). The bounded retry catches the deadlock internally, so
      // under normal overlap NO raw serialization abort should leak out; a leaked
      // abort is only tolerated in the vanishingly-rare case the whole retry
      // budget deadlocks (tracked via sawUnretriedDeadlock, asserted absent
      // across the run below), never as an unhandled error.
      for (const r of [rAB, rBA]) {
        const known =
          (r.ok && (r.value.status === 'ok' || r.value.status === 'last_admin')) || isSerializationAbort(r);
        assert.ok(
          known,
          `round ${round}: each demote resolves to ok/last_admin or a (retry-exhausted) safe abort, never an unhandled error (got ${statusOf(r)})`,
        );
      }

      const statuses = [statusOf(rAB), statusOf(rBA)].sort().join(',');
      if (statuses === ['last_admin', 'ok'].sort().join(',')) sawGraceful = true;
      if ([rAB, rBA].some((r) => isSerializationAbort(r))) sawUnretriedDeadlock = true;
    }
    // GRACEFUL CONTRACT (Phase 4 hardening): with the deadlock-retry in place the
    // symmetric demote now serializes to a clean last_admin/ok split — the loser
    // gets the graceful `last_admin` 409, not a retriable 500. We require that
    // graceful outcome to be OBSERVED (sawGraceful) and that NO raw deadlock
    // leaks past the bounded retry (sawUnretriedDeadlock stays false) across all
    // rounds. If this ever regresses (retry removed / lock order broken), one of
    // these flips and the assertion fails LOUDLY.
    assert.ok(
      sawGraceful && !sawUnretriedDeadlock,
      `expected the symmetric demote to resolve gracefully (last_admin/ok) with NO deadlock leaking past the bounded retry — sawGraceful=${sawGraceful} sawUnretriedDeadlock=${sawUnretriedDeadlock}.`,
    );
  });
});

// ── 5. concurrent double-accept under the free limit ────────────────────────

test('concurrency: a free account double-accepting two invites UNDER the free limit → exactly one 402 (entitlement FOR UPDATE)', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;
  await withHarness(async (h) => {
    const orgP = await h.org('OrgP');
    const orgQ = await h.org('OrgQ');
    // Free account with ZERO active memberships (the free tier allows exactly
    // ONE) and TWO pending invites. Under READ COMMITTED without the FOR UPDATE
    // count both accepts would see 0 active and BOTH slip in → two active
    // memberships on a free plan (the exact bug the lock guards). The
    // serialized count must let exactly ONE through and 402 the other.
    const userId = await h.user({ email: 'free@acme.com', organizationId: orgP, role: 'tenant_admin', plan: 'free' });
    await h.membership({ userId, organizationId: orgP, role: 'tenant_analyst', status: 'invited' });
    await h.membership({ userId, organizationId: orgQ, role: 'tenant_viewer', status: 'invited' });
    const tokenP = await h.invitation({ organizationId: orgP, userId, email: 'free@acme.com', role: 'tenant_analyst' });
    const tokenQ = await h.invitation({ organizationId: orgQ, userId, email: 'free@acme.com', role: 'tenant_viewer' });

    const [rp, rq] = await h.race2(
      (c) => acceptJoinInvitation(c, { rawToken: tokenP, sessionUserId: String(userId), sessionEmail: 'free@acme.com' }, FLAG_ON),
      (c) => acceptJoinInvitation(c, { rawToken: tokenQ, sessionUserId: String(userId), sessionEmail: 'free@acme.com' }, FLAG_ON),
    );

    // Both accepts are for the SAME account, so each takes the same users-row
    // FOR UPDATE lock (in acceptJoinInvitation) as its FIRST lock — they
    // serialize consistently on that ONE row, no cross-table cycle, no
    // deadlock: this race resolves gracefully every time (proven stable). The
    // second accept, once it re-reads under its lock, sees the first's
    // now-committed active membership and is paywalled.
    //
    // FRESH-EYES FINDING (filed with this suite): for THIS accept path the
    // serialization is provided by that shared users-row lock, NOT by the
    // entitlement helper's own `FOR UPDATE` on the count — stripping the
    // entitlement FOR UPDATE leaves this race still correct (30/30). The
    // entitlement FOR UPDATE is defense-in-depth that only becomes load-bearing
    // at a choke point that runs the count WITHOUT already holding the user row
    // (e.g. the Phase-4 second-workspace-creation path). The mock-level test
    // still pins that the helper's SQL carries FOR UPDATE (shape), which is
    // correct to keep — this note is about which lock does the work HERE.
    const statuses = [statusOf(rp), statusOf(rq)].sort();
    assert.deepEqual(
      statuses,
      ['ok', 'requires_pro'],
      'exactly one accept slips under the free limit; the other is paywalled (shared users-row lock serializes them)',
    );

    // The load-bearing invariant: the free account ends with exactly ONE active
    // membership — never two. This is the assertion a non-serialized activation
    // would fail (both would activate → a free account with two workspaces).
    const active = await h.activeCount(userId);
    assert.equal(active, 1, 'the free limit held under concurrency: exactly one active membership, never two');

    // The denied invite PERSISTS (not consumed) for accept-after-upgrade.
    const liveInvites = (
      await h.pool.query(
        `SELECT count(*)::int AS n FROM workspace_invitations WHERE user_id=$1 AND accepted_at IS NULL AND expires_at > now()`,
        [userId],
      )
    ).rows[0];
    assert.equal(liveInvites.n, 1, 'the paywalled invite survives (never destroyed by the 402)');
  });
});

// ── 6. accept-vs-revoke race ────────────────────────────────────────────────

test('concurrency: accept-vs-revoke — a join accepted as the admin removes the membership resolves visibly, never a silent 0-row success', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;
  await withHarness(async (h) => {
    const home = await h.org('HomeR');
    const target = await h.org('TargetR');
    const admin = await h.user({ email: 'admin@target.com', organizationId: target, role: 'tenant_admin' });
    await h.membership({ userId: admin, organizationId: target, role: 'tenant_admin', status: 'active' });
    // The invitee: existing active account, invited (pending membership) to target.
    const invitee = await h.user({ email: 'invitee@acme.com', organizationId: home, role: 'tenant_admin', plan: 'pro' });
    await h.membership({ userId: invitee, organizationId: home, role: 'tenant_admin', status: 'active' });
    await h.membership({ userId: invitee, organizationId: target, role: 'tenant_analyst', status: 'invited' });
    const token = await h.invitation({ organizationId: target, userId: invitee, email: 'invitee@acme.com', role: 'tenant_analyst' });

    // The admin revokes (removes the invited membership) while the invitee
    // accepts. Both run concurrently; the row locks serialize them.
    const [accept, remove] = await h.race2(
      (c) => acceptJoinInvitation(c, { rawToken: token, sessionUserId: String(invitee), sessionEmail: 'invitee@acme.com' }, FLAG_ON),
      (c) => deleteTenantUserProfile(c, { tenantId: String(target), userId: String(invitee), actorUserId: String(admin) }, FLAG_ON),
    );

    // The revoke completes — it wins the row-lock race in the common
    // interleaving (never a silent 0-row no-op).
    assert.ok(remove.ok && remove.value.status === 'deleted', `the revoke completes (never a silent 0-row no-op) (got ${statusOf(remove)})`);

    const finalMembership = (
      await h.pool.query(
        `SELECT status FROM organization_memberships WHERE user_id=$1 AND organization_id=$2`,
        [invitee, target],
      )
    ).rows[0] as { status: string } | undefined;
    const removedEvents = Number(
      (
        await h.pool.query(
          `SELECT count(*)::int AS n FROM organization_membership_events WHERE user_id=$1 AND organization_id=$2 AND event_type='removed'`,
          [invitee, target],
        )
      ).rows[0].n,
    );
    assert.equal(removedEvents, 1, 'the revoke wrote its audited removed event exactly once');

    // The accept and the revoke lock the users / organization_memberships /
    // workspace_invitations rows in OPPOSING order, so genuine overlap resolves
    // one of three coherent, VISIBLE ways — never a silent 0-row success and
    // never a torn half-join. Phase 4 hardening: acceptJoinInvitation now wraps
    // its txn in withDeadlockRetry, so a deadlock-aborted accept re-runs and
    // re-reads committed state — the graceful (b) not_join outcome is now the
    // expected resolution rather than a leaked 40P01 500; (c) remains a legal
    // fallback only if the whole retry budget deadlocks. Three legal shapes:
    //
    //  (a) accept='ok' (accept committed first) → the revoke then removed the
    //      now-active membership → removed-while-active convergence (CEO
    //      hardening 7): the member is out on their next request, not silently
    //      half-joined. End state: membership GONE (or active, if the delete
    //      lost the row-visibility race) — never torn.
    //  (b) accept a VISIBLE terminal status (not_join/expired/…): the revoke
    //      won cleanly, the accept re-read under its lock and refused — the
    //      revoked membership stays gone.
    //  (c) accept a SAFE deadlock abort (40P01): its whole txn rolled back, the
    //      revoke stood, the membership is gone. No silent success.
    if (accept.ok && accept.value.status === 'ok') {
      assert.ok(
        finalMembership === undefined || finalMembership.status === 'active',
        'a successful accept leaves either an active row or a cleanly-revoked (gone) one — never a torn state',
      );
    } else if (accept.ok) {
      assert.ok(
        ['not_join', 'expired', 'already_accepted', 'invalid'].includes(accept.value.status),
        `a lost accept reports a visible status, never a silent 0-row success (got ${accept.value.status})`,
      );
      assert.equal(finalMembership, undefined, 'the revoked membership stays gone — no silent half-join');
    } else {
      // (c) The accept aborted — must be a SAFE serialization/deadlock abort
      // (never an unhandled error), and the membership must be gone (the revoke
      // committed while the accept rolled back). No silent success.
      assert.ok(
        isSerializationAbort(accept),
        `a non-returning accept aborted only via a safe serialization/deadlock error (got ${accept.error.code}: ${accept.error.message})`,
      );
      assert.equal(finalMembership, undefined, 'a deadlock-aborted accept leaves the revoked membership gone — no silent half-join');
    }
  });
});
