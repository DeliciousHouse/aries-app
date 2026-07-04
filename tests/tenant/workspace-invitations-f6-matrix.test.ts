/**
 * Multi-workspace Phase 2 — CEO review F6 hybrid credential-state matrix
 * (docs/plans/2026-07-03-multi-workspace-membership.md: "Additional test specs"
 * — Hybrid credential-state matrix; Decision 4; hardening 1/6).
 *
 * The F6 invariant, stated as a security property rather than a per-invitation
 * check: for ANY account that already holds ≥1 real credential (password_hash
 * is NOT the pending sentinel), the `UPDATE users SET password_hash` in
 * `acceptWorkspaceInvitation` is UNREACHABLE — across BOTH accept surfaces
 * (legacy set-password `acceptWorkspaceInvitation` AND the new
 * `acceptJoinInvitation`) — no matter what membership state the account carries
 * in org A vs org B, and the (user, org)-scoped supersede/consume never
 * resurrects a stale sibling-org token into a password reset.
 *
 * This is a systematic permutation SWEEP:
 *   credential state ∈ { pending-sentinel, active-credential }
 *   × membership in org A ∈ { none, invited, active }
 *   × membership in org B ∈ { none, invited, active }
 * evaluated against BOTH accept entry points, asserting the single load-bearing
 * property (no password write) holds for every active-credential permutation,
 * and that a password write happens ONLY for the pending-sentinel account via
 * the set-password surface (never via join).
 *
 * Everything here runs flag ON; the bottom fixes a flag-OFF pin.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acceptJoinInvitation,
  acceptWorkspaceInvitation,
} from '../../backend/tenant/workspace-invitations';

const FLAG_ON = { ARIES_MULTI_WORKSPACE_ENABLED: '1', NODE_ENV: 'test' } as NodeJS.ProcessEnv;
const FLAG_OFF = { ARIES_MULTI_WORKSPACE_ENABLED: '0', NODE_ENV: 'test' } as NodeJS.ProcessEnv;

const STRONG_PASSWORD = 'Aa1!aaaa';
const PENDING = 'invited_pending';
const REAL_HASH = '$2a$12$realbcrypthashaaaaaaaaaaaa';

type Handler = (params: unknown[]) => { rows: Array<Record<string, unknown>>; rowCount?: number | null };

function makeFakeDb(routes: Array<[RegExp, Handler]>) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const queryable = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      const lowered = sql.toLowerCase();
      for (const [pattern, handler] of routes) {
        if (pattern.test(lowered)) return handler(params);
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { queryable, calls };
}

const PASSTHROUGH: Array<[RegExp, Handler]> = [
  [/^\s*begin/, () => ({ rows: [] })],
  [/^\s*commit/, () => ({ rows: [] })],
  [/^\s*rollback/, () => ({ rows: [] })],
];

const MEMBERSHIP_LOOKUP_RE = /select role, status from organization_memberships/;
const ENTITLEMENT_LOCK_RE = /select organization_id from organization_memberships where user_id = \$1 and status = 'active'/;
const PASSWORD_WRITE_RE = /update users set password_hash/;

/** Detects the ONE statement the invariant forbids for an active account. */
function didWritePassword(calls: Array<{ sql: string }>): boolean {
  return calls.some((c) => PASSWORD_WRITE_RE.test(c.sql.toLowerCase()));
}

// ── Matrix cell definition ──────────────────────────────────────────────────
// The account is invited to org A (organization_id 11, the token's org) while
// carrying an independent membership in org B (organization_id 22). We sweep the
// invitee's credential state and both memberships, then accept the org-A token
// via BOTH surfaces. ORG_A is always the accept target.

const ORG_A = 11;
const ORG_B = 22;
const USER_ID = 42;

type MembershipState = 'none' | 'invited' | 'active';

function membershipRow(state: MembershipState, role = 'tenant_analyst') {
  if (state === 'none') return null;
  return { role, status: state };
}

/**
 * The org-A invitation token row (shared shape). The (user, org) membership in
 * org A is what `acceptJoinInvitation` reads; `acceptWorkspaceInvitation` also
 * reads it (for the activation role) but branches on the USER credential state.
 */
function orgAInvitation(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    user_id: USER_ID,
    organization_id: ORG_A,
    email: 'hybrid@acme.com',
    role: 'tenant_analyst',
    invited_by_user_id: 3,
    expires_at: new Date(Date.now() + 60_000),
    accepted_at: null,
    ...overrides,
  };
}

/**
 * Build a fake DB for the set-password surface. The invitation targets org A;
 * `orgAMembership` is what the flag-ON accept reads to pick the activation role.
 */
function setPasswordDb(input: { credential: string; orgAMembership: MembershipState }) {
  const consumeCalls: Array<unknown[]> = [];
  const db = makeFakeDb([
    [/from workspace_invitations\s+where token_hash/, () => ({ rows: [orgAInvitation()], rowCount: 1 })],
    ...PASSTHROUGH,
    [
      /from users\s+where id = \$1\s+limit 1\s+for update/,
      () => ({ rows: [{ id: USER_ID, password_hash: input.credential }], rowCount: 1 }),
    ],
    [
      MEMBERSHIP_LOOKUP_RE,
      () => {
        const row = membershipRow(input.orgAMembership);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      },
    ],
    [PASSWORD_WRITE_RE, () => ({ rows: [] })],
    [/insert into organization_memberships/, () => ({ rows: [] })],
    [
      /update workspace_invitations set accepted_at/,
      (params) => {
        consumeCalls.push(params);
        return { rows: [] };
      },
    ],
    [/insert into organization_membership_events/, () => ({ rows: [] })],
    [/update users set organization_id/, () => ({ rows: [] })],
  ]);
  return { ...db, consumeCalls };
}

/**
 * Build a fake DB for the join surface. `orgAMembership` is the (user, org-A)
 * membership row `acceptJoinInvitation` locks; `activeCount`/`plan` drive the
 * entitlement gate. The account's other-org (B) membership only matters through
 * `activeCount` — the entitlement lock counts ALL active memberships.
 */
function joinDb(input: {
  credential: string;
  orgAMembership: MembershipState;
  activeCount: number;
  plan?: string;
}) {
  const consumeCalls: Array<unknown[]> = [];
  const db = makeFakeDb([
    [/from workspace_invitations\s+where token_hash/, () => ({ rows: [orgAInvitation()], rowCount: 1 })],
    [
      /from users\s+where id = \$1\s+limit 1\s+for update/,
      () => ({
        rows: [
          {
            id: USER_ID,
            email: 'hybrid@acme.com',
            organization_id: ORG_B,
            role: 'tenant_admin',
            password_hash: input.credential,
          },
        ],
        rowCount: 1,
      }),
    ],
    [/select id from organizations where id = \$1/, () => ({ rows: [{ id: ORG_A }], rowCount: 1 })],
    [
      MEMBERSHIP_LOOKUP_RE,
      () => {
        const row = membershipRow(input.orgAMembership);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      },
    ],
    [
      ENTITLEMENT_LOCK_RE,
      () => ({
        rows: Array.from({ length: input.activeCount }, (_, i) => ({ organization_id: 100 + i })),
        rowCount: input.activeCount,
      }),
    ],
    [/select plan from users/, () => ({ rows: [{ plan: input.plan ?? 'pro' }], rowCount: 1 })],
    ...PASSTHROUGH,
    [PASSWORD_WRITE_RE, () => ({ rows: [] })],
    [/update organization_memberships/, () => ({ rows: [] })],
    [/insert into organization_membership_events/, () => ({ rows: [] })],
    [/update users set organization_id/, () => ({ rows: [] })],
    [
      /update workspace_invitations set accepted_at/,
      (params) => {
        consumeCalls.push(params);
        return { rows: [] };
      },
    ],
  ]);
  return { ...db, consumeCalls };
}

// ── The load-bearing sweep: active credentials NEVER reach the password write ─

const MEMBERSHIP_STATES: MembershipState[] = ['none', 'invited', 'active'];

test('F6: an ACTIVE-credential account NEVER reaches the password write on the set-password surface, for every org-A membership state', async () => {
  for (const orgAMembership of MEMBERSHIP_STATES) {
    const { queryable, calls } = setPasswordDb({ credential: REAL_HASH, orgAMembership });
    const result = await acceptWorkspaceInvitation(
      queryable,
      { rawToken: 'tok', password: STRONG_PASSWORD },
      FLAG_ON,
    );
    // An account with real credentials that hits the legacy set-password route
    // gets the VISIBLE not_pending redirect — never a password overwrite.
    assert.deepEqual(
      result,
      { status: 'not_pending' },
      `active credential + org-A membership=${orgAMembership} must report not_pending`,
    );
    assert.ok(
      !didWritePassword(calls),
      `PASSWORD WRITE REACHED for active credential + org-A membership=${orgAMembership} (F6 violation)`,
    );
    // Nothing was consumed either — the rollback leaves the invitation live.
    assert.ok(
      calls.some((c) => /^\s*rollback/i.test(c.sql)),
      `active credential + org-A membership=${orgAMembership} rolls back`,
    );
    assert.ok(!calls.some((c) => /update workspace_invitations set accepted_at/i.test(c.sql)));
  }
});

test('F6: an ACTIVE-credential account NEVER reaches the password write on the join surface, for every org-A membership state', async () => {
  for (const orgAMembership of MEMBERSHIP_STATES) {
    // Give a pro plan + 1 active membership so the entitlement gate never masks
    // the invariant — we want the accept to proceed as far as it possibly can
    // and STILL never touch password_hash.
    const { queryable, calls } = joinDb({
      credential: REAL_HASH,
      orgAMembership,
      activeCount: 1,
      plan: 'pro',
    });
    await acceptJoinInvitation(
      queryable,
      { rawToken: 'tok', sessionUserId: String(USER_ID), sessionEmail: 'hybrid@acme.com' },
      FLAG_ON,
    );
    assert.ok(
      !didWritePassword(calls),
      `PASSWORD WRITE REACHED on join for active credential + org-A membership=${orgAMembership} (F6 violation)`,
    );
  }
});

test('F6: the join surface NEVER writes a password even for a pending-sentinel account (set-password owns that)', async () => {
  // A pending account that somehow reaches the join endpoint is refused
  // (not_join) with zero writes — the credential path belongs to set-password.
  const { queryable, calls } = joinDb({
    credential: PENDING,
    orgAMembership: 'invited',
    activeCount: 0,
  });
  const result = await acceptJoinInvitation(
    queryable,
    { rawToken: 'tok', sessionUserId: String(USER_ID), sessionEmail: 'hybrid@acme.com' },
    FLAG_ON,
  );
  assert.deepEqual(result, { status: 'not_join' });
  assert.ok(!didWritePassword(calls), 'join must never write a password, even for a pending account');
});

// ── The complementary pin: the pending sentinel IS the only path that writes ─

test('F6 boundary: ONLY a pending-sentinel account on the set-password surface writes the password (and org-scoped consume)', async () => {
  const { queryable, calls, consumeCalls } = setPasswordDb({
    credential: PENDING,
    orgAMembership: 'invited',
  });
  const result = await acceptWorkspaceInvitation(
    queryable,
    { rawToken: 'tok', password: STRONG_PASSWORD },
    FLAG_ON,
  );
  assert.deepEqual(result, { status: 'ok', email: 'hybrid@acme.com' });
  assert.ok(didWritePassword(calls), 'a genuinely pending account DOES set its password (the legitimate path)');

  // The write is scoped to the token's user, and consume is (user, org)-scoped
  // so the sibling org-B token is never resurrected into a password reset.
  const consume = calls.find((c) => /update workspace_invitations set accepted_at/i.test(c.sql));
  assert.match(consume!.sql.toLowerCase(), /and organization_id = \$2/);
  assert.deepEqual(consumeCalls[0], [USER_ID, ORG_A], 'consume is (user, org)-scoped — org B survives');
});

// ── Stale-sibling-token TOCTOU: pending→active between issue and second accept ─

test('F6 TOCTOU: a token minted while pending, accepted AFTER the account went active, cannot re-write the password', async () => {
  // The org-A token was issued when the account had no credentials. Between
  // issue and accept the account set a password (e.g. accepted org B's invite
  // first). The in-transaction sentinel re-check on the LOCKED user row (not a
  // pre-BEGIN read) sees the fresh 'active' state and refuses the write.
  const { queryable, calls } = setPasswordDb({ credential: REAL_HASH, orgAMembership: 'invited' });
  const result = await acceptWorkspaceInvitation(
    queryable,
    { rawToken: 'tok', password: STRONG_PASSWORD },
    FLAG_ON,
  );
  assert.deepEqual(result, { status: 'not_pending' });
  assert.ok(!didWritePassword(calls), 'a stale sibling token must never resurrect into a password reset');

  // The sentinel re-check must read the user row INSIDE the transaction (FOR
  // UPDATE), after BEGIN — the whole point of the TOCTOU fix.
  const idx = (re: RegExp) => calls.findIndex((c) => re.test(c.sql.toLowerCase()));
  const beginIdx = idx(/^\s*begin/);
  const userLockIdx = idx(/from users\s+where id = \$1\s+limit 1\s+for update/);
  assert.ok(beginIdx >= 0 && userLockIdx > beginIdx, 'the sentinel re-check locks the user row inside the txn');
});

// ── Flag-OFF fork boundary: still non-disclosing 'invalid', still no write ────

test('F6 flag-OFF pin: an active-credential account on the set-password surface collapses to invalid, no write', async () => {
  const { queryable, calls } = setPasswordDb({ credential: REAL_HASH, orgAMembership: 'none' });
  const result = await acceptWorkspaceInvitation(
    queryable,
    { rawToken: 'tok', password: STRONG_PASSWORD },
    FLAG_OFF,
  );
  assert.deepEqual(result, { status: 'invalid' }, 'flag OFF stays non-disclosing (no typed not_pending)');
  assert.ok(!didWritePassword(calls), 'flag OFF also never writes the password for an active account');
});
