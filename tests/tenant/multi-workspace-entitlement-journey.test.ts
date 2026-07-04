/**
 * Multi-workspace Phase 2 — Decision 13 entitlement JOURNEY pins (mock level)
 * (docs/plans/2026-07-03-multi-workspace-membership.md: Decision 13; CEO
 * "Additional test specs" → Entitlement; choke-point map 13a–13e).
 *
 * The single-state entitlement cases live in workspace-invitations-phase2.test
 * (0/1/pro of assertMultiWorkspaceEntitlement + one accept-denied case). THIS
 * file pins the multi-step JOURNEY and the choke-point discrimination the plan
 * enumerates, all against acceptJoinInvitation (the Phase-2 choke point 13a):
 *
 *   1. free account, second membership   → denied 402-style, membership STILL
 *      'invited', invitation PERSISTS (rolled back, nothing consumed);
 *   2. same account after set-user-plan pro → the SAME token now accepts;
 *   3. absorb flow (no membership row → not_join here, and the real absorb path
 *      never calls the entitlement helper — choke point 13c is exempt);
 *   4. first membership (zero active) never pays — never even reads users.plan;
 *   5. pro account unaffected at the choke point.
 *
 * Choke-point exemptions (13c/13d/13e) are asserted structurally: the helper is
 * consulted ONLY when an ADDITION would occur.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { assertMultiWorkspaceEntitlement } from '../../backend/tenant/entitlements';
import { acceptJoinInvitation } from '../../backend/tenant/workspace-invitations';

const FLAG_ON = { ARIES_MULTI_WORKSPACE_ENABLED: '1', NODE_ENV: 'test' } as NodeJS.ProcessEnv;

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
const PLAN_READ_RE = /select plan from users/;

const USER_ID = 42;
const ORG_A = 11;

function activeUserRow(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    organization_id: 58, // their CURRENT workspace, not the invited org 11
    email: 'existing@acme.com',
    full_name: 'Existing User',
    role: 'tenant_admin',
    password_hash: '$2a$12$realbcrypthashaaaaaaaaaaaa',
    ...overrides,
  };
}

/**
 * A join fixture where the entitlement helper's active-membership count and the
 * account's plan are driven by mutable closures — so a single fixture can model
 * the "denied, then upgraded, then accepted" JOURNEY across two accept calls.
 */
function journeyDb(state: { activeCount: number; plan: string; membershipStatus: 'invited' | 'active' }) {
  const invitation = {
    id: 7,
    user_id: USER_ID,
    organization_id: ORG_A,
    email: 'existing@acme.com',
    role: 'tenant_analyst',
    invited_by_user_id: 3,
    expires_at: new Date(Date.now() + 60_000),
    accepted_at: null as Date | null,
  };
  return makeFakeDb([
    [
      /from workspace_invitations\s+where token_hash/,
      () => ({ rows: invitation.accepted_at ? [{ ...invitation }] : [{ ...invitation }], rowCount: 1 }),
    ],
    [/from users\s+where id = \$1\s+limit 1\s+for update/, () => ({ rows: [activeUserRow()], rowCount: 1 })],
    [/select id from organizations where id = \$1/, () => ({ rows: [{ id: ORG_A }], rowCount: 1 })],
    [
      MEMBERSHIP_LOOKUP_RE,
      () => ({ rows: [{ role: 'tenant_analyst', status: state.membershipStatus }], rowCount: 1 }),
    ],
    [
      ENTITLEMENT_LOCK_RE,
      () => ({
        rows: Array.from({ length: state.activeCount }, (_, i) => ({ organization_id: 100 + i })),
        rowCount: state.activeCount,
      }),
    ],
    [PLAN_READ_RE, () => ({ rows: [{ plan: state.plan }], rowCount: 1 })],
    ...PASSTHROUGH,
    [/update organization_memberships/, () => ({ rows: [] })],
    [/insert into organization_membership_events/, () => ({ rows: [] })],
    [/update users set organization_id/, () => ({ rows: [] })],
    [/update workspace_invitations set accepted_at/, () => ({ rows: [] })],
  ]);
}

// ── The full journey: denied → persists → upgrade → accepts ─────────────────

test('entitlement journey: free account is denied the second workspace, invite PERSISTS, then accepts after plan=pro', async () => {
  // Step 1: free account, already 1 active membership → the invited second
  // membership is denied. Nothing is consumed; the invited row + invitation
  // persist for accept-after-upgrade.
  const denied = journeyDb({ activeCount: 1, plan: 'free', membershipStatus: 'invited' });
  const deniedResult = await acceptJoinInvitation(
    denied.queryable,
    { rawToken: 'tok', sessionUserId: String(USER_ID), sessionEmail: 'existing@acme.com' },
    FLAG_ON,
  );
  assert.deepEqual(deniedResult, { status: 'requires_pro' });

  // The membership stays 'invited' (never activated) and the invitation is
  // never consumed — the paywall must never destroy the invite (Decision 13).
  assert.ok(denied.calls.some((c) => /^\s*rollback/i.test(c.sql)), 'the txn rolls back on denial');
  assert.ok(!denied.calls.some((c) => /^\s*commit/i.test(c.sql)));
  assert.ok(
    !denied.calls.some((c) => /update organization_memberships/i.test(c.sql)),
    'the invited membership is NOT activated on denial',
  );
  assert.ok(
    !denied.calls.some((c) => /update workspace_invitations set accepted_at/i.test(c.sql)),
    'the invitation is NOT consumed on denial (persists for accept-after-upgrade)',
  );

  // Step 2: the operator runs `set-user-plan --plan pro`. The SAME invitation
  // token (never consumed) now accepts.
  const upgraded = journeyDb({ activeCount: 1, plan: 'pro', membershipStatus: 'invited' });
  const upgradedResult = await acceptJoinInvitation(
    upgraded.queryable,
    { rawToken: 'tok', sessionUserId: String(USER_ID), sessionEmail: 'existing@acme.com' },
    FLAG_ON,
  );
  assert.deepEqual(upgradedResult, { status: 'ok', email: 'existing@acme.com', organizationId: String(ORG_A) });
  assert.ok(upgraded.calls.some((c) => /update organization_memberships/i.test(c.sql)), 'pro now activates the membership');
  assert.ok(upgraded.calls.some((c) => /update workspace_invitations set accepted_at/i.test(c.sql)));
  assert.ok(upgraded.calls.some((c) => /^\s*commit/i.test(c.sql)));
});

// ── Choke-point discrimination (13c / 13d / 13e) ────────────────────────────

test('entitlement 13d: a FIRST membership (zero active) is free — the helper never reads users.plan', async () => {
  const first = journeyDb({ activeCount: 0, plan: 'free', membershipStatus: 'invited' });
  const result = await acceptJoinInvitation(
    first.queryable,
    { rawToken: 'tok', sessionUserId: String(USER_ID), sessionEmail: 'existing@acme.com' },
    FLAG_ON,
  );
  assert.equal(result.status, 'ok', 'a free account joining its FIRST workspace is never paywalled');
  assert.ok(
    !first.calls.some((c) => PLAN_READ_RE.test(c.sql.toLowerCase())),
    "zero active memberships → allowed without even reading users.plan (13d)",
  );
});

test('entitlement 13e: a pro account is unaffected at the choke point (second membership activates)', async () => {
  const pro = journeyDb({ activeCount: 1, plan: 'pro', membershipStatus: 'invited' });
  const result = await acceptJoinInvitation(
    pro.queryable,
    { rawToken: 'tok', sessionUserId: String(USER_ID), sessionEmail: 'existing@acme.com' },
    FLAG_ON,
  );
  assert.equal(result.status, 'ok');
});

test('entitlement 13c: the join choke point does NOT paywall a no-membership (absorb-type) invitation — it is not an addition here', async () => {
  // An absorb-type invitation has no (user, org) membership row: acceptJoin
  // returns not_join BEFORE the entitlement helper is ever consulted. The real
  // absorb path (acceptAbsorbInvitation) has no entitlement call at all — a
  // replacement is never an addition (13c). Assert the helper is not reached.
  const absorb = makeFakeDb([
    [
      /from workspace_invitations\s+where token_hash/,
      () => ({
        rows: [
          {
            id: 7,
            user_id: USER_ID,
            organization_id: ORG_A,
            email: 'existing@acme.com',
            role: 'tenant_analyst',
            invited_by_user_id: 3,
            expires_at: new Date(Date.now() + 60_000),
            accepted_at: null,
          },
        ],
        rowCount: 1,
      }),
    ],
    [/from users\s+where id = \$1\s+limit 1\s+for update/, () => ({ rows: [activeUserRow()], rowCount: 1 })],
    [/select id from organizations where id = \$1/, () => ({ rows: [{ id: ORG_A }], rowCount: 1 })],
    [MEMBERSHIP_LOOKUP_RE, () => ({ rows: [], rowCount: 0 })], // no membership → absorb-type
    ...PASSTHROUGH,
  ]);
  const result = await acceptJoinInvitation(
    absorb.queryable,
    { rawToken: 'tok', sessionUserId: String(USER_ID), sessionEmail: 'existing@acme.com' },
    FLAG_ON,
  );
  assert.deepEqual(result, { status: 'not_join' });
  assert.ok(
    !absorb.calls.some((c) => ENTITLEMENT_LOCK_RE.test(c.sql.toLowerCase())),
    'the entitlement gate is never consulted for a non-addition (absorb-type) invitation',
  );
});

// ── The helper's own FOR-UPDATE lock discipline (13b TOCTOU) ────────────────

test('entitlement helper locks the active-membership rows FOR UPDATE before counting (TOCTOU discipline 13b)', async () => {
  const free = makeFakeDb([
    [ENTITLEMENT_LOCK_RE, () => ({ rows: [{ organization_id: 58 }], rowCount: 1 })],
    [PLAN_READ_RE, () => ({ rows: [{ plan: 'free' }], rowCount: 1 })],
  ]);
  const result = await assertMultiWorkspaceEntitlement(free.queryable, USER_ID);
  assert.deepEqual(result, { allowed: false, code: 'multi_workspace_requires_pro' });
  const lock = free.calls.find((c) => ENTITLEMENT_LOCK_RE.test(c.sql.toLowerCase()));
  assert.ok(lock, 'expected the active-membership count query');
  assert.match(lock!.sql.toLowerCase(), /for update/, 'the count must lock FOR UPDATE so concurrent accepts serialize');
});
