/**
 * Multi-workspace Phase 2 — invite/accept membership semantics, flag ON
 * (docs/plans/2026-07-03-multi-workspace-membership.md: Decision 4 invite/accept,
 * Decision 13 entitlement, CEO E4/F6 + hardening 1/2/6, eng findings 2/4/5/6).
 *
 * Everything here passes an explicit FLAG_ON env; the flag-OFF byte-identical
 * behavior stays pinned by tests/tenant/workspace-invitations.test.ts (which
 * runs with the flag unset) plus the explicit flag-OFF pins at the bottom.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { assertMultiWorkspaceEntitlement } from '../../backend/tenant/entitlements';
import {
  acceptJoinInvitation,
  acceptWorkspaceInvitation,
  describeInvitationAcceptContext,
  hashInviteToken,
  inviteWorkspaceMember,
} from '../../backend/tenant/workspace-invitations';

const FLAG_ON = { ARIES_MULTI_WORKSPACE_ENABLED: '1', NODE_ENV: 'test' } as NodeJS.ProcessEnv;
const FLAG_OFF = { ARIES_MULTI_WORKSPACE_ENABLED: '0', NODE_ENV: 'test' } as NodeJS.ProcessEnv;

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

const ORPHAN_PREDICATE_RE = /count\(\*\)::int from users where organization_id/;
const MEMBERSHIP_LOOKUP_RE = /select role, status from organization_memberships/;
const ENTITLEMENT_LOCK_RE = /select organization_id from organization_memberships where user_id = \$1 and status = 'active'/;

function orphanPredicateRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    member_count: 1,
    other_membership_count: 0,
    invitee_onboarding_completed_at: null,
    has_business_profile: false,
    has_posts: false,
    has_connected_accounts: false,
    has_creative_assets: false,
    ...overrides,
  };
}

function activeUserRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    organization_id: 58,
    email: 'existing@acme.com',
    full_name: 'Existing User',
    role: 'tenant_admin',
    password_hash: '$2a$12$abcdefghijklmnopqrstuv',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ── Invite: the flag-ON state machine ───────────────────────────────────────

test('flag ON: inviting an existing ACTIVE account (non-orphan) creates an invited membership + invitation — never email_taken', async () => {
  let invitationParams: unknown[] | null = null;
  const { queryable, calls } = makeFakeDb([
    [/from users where lower\(email\)/, () => ({ rows: [activeUserRow({ has: 1 })], rowCount: 1 })],
    [MEMBERSHIP_LOOKUP_RE, () => ({ rows: [], rowCount: 0 })],
    // Not an orphan → the absorb relief does not fire; the membership path does.
    [ORPHAN_PREDICATE_RE, () => ({ rows: [orphanPredicateRow({ has_posts: true })] })],
    ...PASSTHROUGH,
    [
      /insert into workspace_invitations/,
      (params) => {
        invitationParams = params;
        return { rows: [] };
      },
    ],
  ]);

  const result = await inviteWorkspaceMember(
    queryable,
    { organizationId: '11', email: 'existing@acme.com', role: 'tenant_analyst', invitedByUserId: '3' },
    FLAG_ON,
  );

  assert.equal(result.status, 'invited_existing_account');
  if (result.status !== 'invited_existing_account') return;
  assert.equal(result.email, 'existing@acme.com');
  assert.equal(result.role, 'tenant_analyst');
  assert.ok(result.rawToken);

  // Membership row: (user 42, org 11) invited with the admin-chosen role, via
  // the non-downgrading ON CONFLICT upsert (concurrent duplicate invite safe).
  const membershipUpsert = calls.find((c) => /insert into organization_memberships/i.test(c.sql));
  assert.ok(membershipUpsert, 'expected an invited membership upsert');
  assert.deepEqual(membershipUpsert!.params, [42, 11, 'tenant_analyst', 3]);
  assert.match(membershipUpsert!.sql.toLowerCase(), /on conflict \(user_id, organization_id\) do update/);
  assert.match(
    membershipUpsert!.sql.toLowerCase(),
    /when organization_memberships\.status = 'active' then organization_memberships\.role/,
    'the invite upsert must never downgrade an active membership',
  );

  // Audit event with the acting admin.
  const event = calls.find((c) => /insert into organization_membership_events/i.test(c.sql));
  assert.ok(event, 'expected an invited event row');
  assert.equal(event!.params[0], 11);
  assert.equal(event!.params[1], 42);
  assert.equal(event!.params[2], 3);
  assert.equal(event!.params[3], 'invited');

  // Invitation targets (org 11, user 42); supersede is (user, org)-scoped —
  // an org-11 invite must not kill a pending org-A token.
  assert.equal(invitationParams?.[0], 11);
  assert.equal(invitationParams?.[1], 42);
  const supersede = calls.find((c) => /update workspace_invitations\s+set expires_at = now\(\)/i.test(c.sql));
  assert.ok(supersede);
  assert.match(supersede!.sql.toLowerCase(), /and organization_id = \$2/);
  assert.deepEqual(supersede!.params, [42, 11]);

  // The account itself is untouched: no user INSERT/UPDATE, no password write.
  assert.ok(!calls.some((c) => /insert into users/i.test(c.sql)));
  assert.ok(!calls.some((c) => /update users/i.test(c.sql)));
});

test('flag ON: an ACTIVE membership in this org still refuses with already_member', async () => {
  const { queryable, calls } = makeFakeDb([
    [/from users where lower\(email\)/, () => ({ rows: [activeUserRow()], rowCount: 1 })],
    [MEMBERSHIP_LOOKUP_RE, () => ({ rows: [{ role: 'tenant_analyst', status: 'active' }], rowCount: 1 })],
  ]);

  const result = await inviteWorkspaceMember(
    queryable,
    { organizationId: '11', email: 'existing@acme.com' },
    FLAG_ON,
  );
  assert.equal(result.status, 'already_member');
  assert.ok(!calls.some((c) => /^\s*begin/i.test(c.sql)));
  assert.ok(!calls.some((c) => /insert into workspace_invitations/i.test(c.sql)));
});

test('flag ON: orphan-absorb keeps precedence — no membership row is written for an orphan account', async () => {
  const { queryable, calls } = makeFakeDb([
    [/from users where lower\(email\)/, () => ({ rows: [activeUserRow()], rowCount: 1 })],
    [MEMBERSHIP_LOOKUP_RE, () => ({ rows: [], rowCount: 0 })],
    [ORPHAN_PREDICATE_RE, () => ({ rows: [orphanPredicateRow()] })],
    ...PASSTHROUGH,
    [/insert into workspace_invitations/, () => ({ rows: [] })],
  ]);

  const result = await inviteWorkspaceMember(
    queryable,
    { organizationId: '11', email: 'existing@acme.com', role: 'tenant_analyst' },
    FLAG_ON,
  );
  assert.equal(result.status, 'invited_existing_orphan');
  // Absorb consent decides — no membership, no event, until they accept.
  assert.ok(!calls.some((c) => /insert into organization_memberships/i.test(c.sql)));
  assert.ok(!calls.some((c) => /organization_membership_events/i.test(c.sql)));
});

test('flag ON: a pending account in ANOTHER org becomes invitable (membership invite, set-password flow)', async () => {
  const { queryable, calls } = makeFakeDb([
    [
      /from users where lower\(email\)/,
      () => ({ rows: [activeUserRow({ password_hash: 'invited_pending', organization_id: 58 })], rowCount: 1 }),
    ],
    [MEMBERSHIP_LOOKUP_RE, () => ({ rows: [], rowCount: 0 })],
    ...PASSTHROUGH,
    [/insert into workspace_invitations/, () => ({ rows: [] })],
  ]);

  const result = await inviteWorkspaceMember(
    queryable,
    { organizationId: '11', email: 'existing@acme.com', role: 'tenant_viewer', fullName: 'Renamed' },
    FLAG_ON,
  );
  assert.equal(result.status, 'invited');
  if (result.status !== 'invited') return;
  assert.equal(result.profile.tenantId, '11');
  assert.equal(result.profile.status, 'invited');
  // Cross-org: never rename or role-mirror an account owned by another org.
  assert.ok(!calls.some((c) => /update users/i.test(c.sql)));
  const membershipUpsert = calls.find((c) => /insert into organization_memberships/i.test(c.sql));
  assert.deepEqual(membershipUpsert!.params.slice(0, 2), [42, 11]);
});

test('flag ON: same-org pending re-invite refreshes name/role mirror + membership and returns reinvited', async () => {
  const { queryable, calls } = makeFakeDb([
    [
      /from users where lower\(email\)/,
      () => ({ rows: [activeUserRow({ password_hash: 'invited_pending', organization_id: 11 })], rowCount: 1 }),
    ],
    [MEMBERSHIP_LOOKUP_RE, () => ({ rows: [{ role: 'tenant_viewer', status: 'invited' }], rowCount: 1 })],
    ...PASSTHROUGH,
    [/insert into workspace_invitations/, () => ({ rows: [] })],
  ]);

  const result = await inviteWorkspaceMember(
    queryable,
    { organizationId: '11', email: 'existing@acme.com', role: 'tenant_admin' },
    FLAG_ON,
  );
  assert.equal(result.status, 'reinvited');
  if (result.status !== 'reinvited') return;
  assert.equal(result.profile.role, 'tenant_admin');
  // Pointer is this org → the legacy users.role mirror tracks the invite role.
  const mirror = calls.find((c) => /update users set role = \$1/i.test(c.sql));
  assert.deepEqual(mirror?.params, ['tenant_admin', 42]);
});

test('flag ON: brand-new email is create-or-select (ON CONFLICT) so cross-org first-invite races never 500', async () => {
  const { queryable, calls } = makeFakeDb([
    [/from users where lower\(email\)/, () => ({ rows: [], rowCount: 0 })],
    ...PASSTHROUGH,
    [
      /insert into users/,
      (params) => ({
        rows: [
          {
            id: 88,
            organization_id: Number(params[3]),
            email: params[0],
            full_name: params[2],
            role: params[4],
            password_hash: 'invited_pending',
            created_at: '2026-06-25T00:00:00.000Z',
          },
        ],
        rowCount: 1,
      }),
    ],
    [/insert into workspace_invitations/, () => ({ rows: [] })],
  ]);

  const result = await inviteWorkspaceMember(
    queryable,
    { organizationId: '11', email: 'new@acme.com', role: 'tenant_analyst', invitedByUserId: '3' },
    FLAG_ON,
  );
  assert.equal(result.status, 'invited');
  if (result.status !== 'invited') return;
  assert.equal(result.profile.userId, '88');

  const userInsert = calls.find((c) => /insert into users/i.test(c.sql));
  assert.match(
    userInsert!.sql.toLowerCase(),
    /on conflict \(email\) do nothing/,
    'user creation must be create-or-select (eng finding 6)',
  );
  const membershipUpsert = calls.find((c) => /insert into organization_memberships/i.test(c.sql));
  assert.deepEqual(membershipUpsert!.params, [88, 11, 'tenant_analyst', 3]);
});

test('flag ON: losing the create race to an existing ACTIVE account attaches a membership to the winner row', async () => {
  const { queryable, calls } = makeFakeDb([
    // Pre-check: no user yet…
    [/from users\s+where lower\(email\)/, (params) =>
      // …but by the time the in-txn select-after-conflict runs, the winner exists.
      calls.some((c) => /insert into users/i.test(c.sql))
        ? { rows: [activeUserRow({ id: 77, email: String(params[0]) })], rowCount: 1 }
        : { rows: [], rowCount: 0 },
    ],
    ...PASSTHROUGH,
    // The INSERT loses the race: ON CONFLICT DO NOTHING → zero rows.
    [/insert into users/, () => ({ rows: [], rowCount: 0 })],
    [/insert into workspace_invitations/, () => ({ rows: [] })],
  ]);

  const result = await inviteWorkspaceMember(
    queryable,
    { organizationId: '11', email: 'racer@acme.com', role: 'tenant_analyst' },
    FLAG_ON,
  );
  assert.equal(result.status, 'invited_existing_account');
  const membershipUpsert = calls.find((c) => /insert into organization_memberships/i.test(c.sql));
  assert.deepEqual(membershipUpsert!.params.slice(0, 2), [77, 11], 'membership attaches to the WINNER user row');
  assert.ok(!calls.some((c) => /update users/i.test(c.sql)), 'the winner account is never mutated');
});

// ── acceptJoinInvitation: the security core ─────────────────────────────────

type JoinOverrides = {
  invitation?: Record<string, unknown> | null;
  user?: Record<string, unknown> | null;
  membership?: Record<string, unknown> | null;
  activeMemberships?: number;
  plan?: string;
  orgExists?: boolean;
};

function joinRoutes(overrides: JoinOverrides = {}) {
  const invitation =
    overrides.invitation === undefined
      ? {
          id: 7,
          user_id: 42,
          organization_id: 11,
          email: 'existing@acme.com',
          role: 'tenant_analyst',
          invited_by_user_id: 3,
          expires_at: new Date(Date.now() + 60_000),
          accepted_at: null,
        }
      : overrides.invitation;
  const user = overrides.user === undefined ? activeUserRow() : overrides.user;
  const membership =
    overrides.membership === undefined
      ? { role: 'tenant_analyst', status: 'invited' }
      : overrides.membership;
  const activeCount = overrides.activeMemberships ?? 1;
  const routes: Array<[RegExp, Handler]> = [
    [/from workspace_invitations\s+where token_hash/, () => ({ rows: invitation ? [invitation] : [], rowCount: invitation ? 1 : 0 })],
    [/from users\s+where id = \$1\s+limit 1\s+for update/, () => ({ rows: user ? [user] : [], rowCount: user ? 1 : 0 })],
    [/select id from organizations where id = \$1/, () => (overrides.orgExists === false ? { rows: [], rowCount: 0 } : { rows: [{ id: 11 }], rowCount: 1 })],
    [MEMBERSHIP_LOOKUP_RE, () => ({ rows: membership ? [membership] : [], rowCount: membership ? 1 : 0 })],
    [ENTITLEMENT_LOCK_RE, () => ({ rows: Array.from({ length: activeCount }, (_, i) => ({ organization_id: 100 + i })), rowCount: activeCount })],
    [/select plan from users/, () => ({ rows: [{ plan: overrides.plan ?? 'free' }], rowCount: 1 })],
    ...PASSTHROUGH,
  ];
  return makeFakeDb(routes);
}

test('acceptJoinInvitation activates the membership, repoints the pointer, and NEVER touches credentials', async () => {
  const { queryable, calls } = joinRoutes({ activeMemberships: 0 });

  const result = await acceptJoinInvitation(
    queryable,
    { rawToken: 'tok', sessionUserId: '42', sessionEmail: 'Existing@Acme.com' },
    FLAG_ON,
  );
  assert.deepEqual(result, { status: 'ok', email: 'existing@acme.com', organizationId: '11' });

  // Locking discipline (eng finding 5): invitation, user, and membership rows.
  const invitationSelect = calls.find((c) => /from workspace_invitations\s+where token_hash/i.test(c.sql));
  assert.match(invitationSelect!.sql.toLowerCase(), /for update/);
  const userSelect = calls.find((c) => /from users\s+where id = \$1/i.test(c.sql));
  assert.match(userSelect!.sql.toLowerCase(), /for update/);
  const membershipSelect = calls.find((c) => MEMBERSHIP_LOOKUP_RE.test(c.sql.toLowerCase()));
  assert.match(membershipSelect!.sql.toLowerCase(), /for update/);

  // Activation: exactly that (user, org) membership flips to active.
  const activate = calls.find((c) => /update organization_memberships\s+set status = 'active'/i.test(c.sql));
  assert.ok(activate, 'expected the membership activation UPDATE');
  assert.deepEqual(activate!.params, ['tenant_analyst', 42, 11]);

  // Post-accept: pointer + role mirror move together; NO password write ever.
  const pointer = calls.find((c) => /update users set organization_id = \$1, role = \$2/i.test(c.sql));
  assert.deepEqual(pointer!.params, [11, 'tenant_analyst', 42]);
  assert.ok(!calls.some((c) => /password_hash/i.test(c.sql) && /^\s*update/i.test(c.sql)), 'no password write on join');

  // Accepted event, actor = the invitee.
  const event = calls.find((c) => /insert into organization_membership_events/i.test(c.sql));
  assert.equal(event!.params[1], 42);
  assert.equal(event!.params[2], 42);
  assert.equal(event!.params[3], 'accepted');

  // Consume is (user, org)-scoped (CEO F6) — a sibling org-A token survives.
  const consume = calls.find((c) => /update workspace_invitations set accepted_at/i.test(c.sql));
  assert.match(consume!.sql.toLowerCase(), /and organization_id = \$2/);
  assert.deepEqual(consume!.params, [42, 11]);
  assert.ok(calls.some((c) => /^\s*commit/i.test(c.sql)));
});

test('acceptJoinInvitation: a free account attaching a SECOND workspace is denied 402-style and NOTHING is consumed', async () => {
  const { queryable, calls } = joinRoutes({ activeMemberships: 1, plan: 'free' });

  const result = await acceptJoinInvitation(
    queryable,
    { rawToken: 'tok', sessionUserId: '42', sessionEmail: 'existing@acme.com' },
    FLAG_ON,
  );
  assert.deepEqual(result, { status: 'requires_pro' });

  // Rolled back: the invited membership + invitation persist for
  // accept-after-upgrade (Decision 13 — the paywall never destroys the invite).
  assert.ok(calls.some((c) => /^\s*rollback/i.test(c.sql)));
  assert.ok(!calls.some((c) => /^\s*commit/i.test(c.sql)));
  assert.ok(!calls.some((c) => /update organization_memberships/i.test(c.sql)));
  assert.ok(!calls.some((c) => /update users/i.test(c.sql)));
  assert.ok(!calls.some((c) => /update workspace_invitations set accepted_at/i.test(c.sql)));
  assert.ok(!calls.some((c) => /organization_membership_events/i.test(c.sql)));
  // The entitlement count ran FOR UPDATE inside the txn (TOCTOU discipline).
  const lock = calls.find((c) => ENTITLEMENT_LOCK_RE.test(c.sql.toLowerCase()));
  assert.match(lock!.sql.toLowerCase(), /for update/);
});

test('acceptJoinInvitation: a pro account attaches the second workspace', async () => {
  const { queryable } = joinRoutes({ activeMemberships: 1, plan: 'pro' });
  const result = await acceptJoinInvitation(
    queryable,
    { rawToken: 'tok', sessionUserId: '42', sessionEmail: 'existing@acme.com' },
    FLAG_ON,
  );
  assert.equal(result.status, 'ok');
});

test('acceptJoinInvitation: a zero-active-membership account joins free (first membership never pays)', async () => {
  const { queryable, calls } = joinRoutes({ activeMemberships: 0, plan: 'free' });
  const result = await acceptJoinInvitation(
    queryable,
    { rawToken: 'tok', sessionUserId: '42', sessionEmail: 'existing@acme.com' },
    FLAG_ON,
  );
  assert.equal(result.status, 'ok');
  // Zero active rows → allowed without even reading users.plan.
  assert.ok(!calls.some((c) => /select plan from users/i.test(c.sql)));
});

test('acceptJoinInvitation rejects a session that is not the invited account, writing nothing', async () => {
  const wrongUser = joinRoutes();
  const byId = await acceptJoinInvitation(
    wrongUser.queryable,
    { rawToken: 'tok', sessionUserId: '99', sessionEmail: 'existing@acme.com' },
    FLAG_ON,
  );
  assert.deepEqual(byId, { status: 'email_mismatch' });
  assert.ok(!wrongUser.calls.some((c) => /^\s*(update|insert|delete)/i.test(c.sql)));

  const wrongEmail = joinRoutes();
  const byEmail = await acceptJoinInvitation(
    wrongEmail.queryable,
    { rawToken: 'tok', sessionUserId: '42', sessionEmail: 'someoneelse@acme.com' },
    FLAG_ON,
  );
  assert.deepEqual(byEmail, { status: 'email_mismatch' });
  assert.ok(!wrongEmail.calls.some((c) => /^\s*(update|insert|delete)/i.test(c.sql)));
});

test('acceptJoinInvitation converges idempotently when the membership is already active', async () => {
  const { queryable, calls } = joinRoutes({ membership: { role: 'tenant_analyst', status: 'active' } });
  const result = await acceptJoinInvitation(
    queryable,
    { rawToken: 'tok', sessionUserId: '42', sessionEmail: 'existing@acme.com' },
    FLAG_ON,
  );
  assert.deepEqual(result, { status: 'already_member', email: 'existing@acme.com' });
  const consume = calls.find((c) => /update workspace_invitations set accepted_at/i.test(c.sql));
  assert.deepEqual(consume?.params, [42, 11]);
  assert.ok(calls.some((c) => /^\s*commit/i.test(c.sql)));
  assert.ok(!calls.some((c) => /update organization_memberships/i.test(c.sql)));
  assert.ok(!calls.some((c) => /update users/i.test(c.sql)));
});

test('acceptJoinInvitation refuses when no membership row exists (absorb-type or revoked) — not_join', async () => {
  const { queryable, calls } = joinRoutes({ membership: null });
  const result = await acceptJoinInvitation(
    queryable,
    { rawToken: 'tok', sessionUserId: '42', sessionEmail: 'existing@acme.com' },
    FLAG_ON,
  );
  assert.deepEqual(result, { status: 'not_join' });
  assert.ok(!calls.some((c) => /^\s*(update|insert|delete)/i.test(c.sql)));
});

test('acceptJoinInvitation rescues an org deleted before accept as workspace_gone (never a 500)', async () => {
  const { queryable } = joinRoutes({ orgExists: false });
  const result = await acceptJoinInvitation(
    queryable,
    { rawToken: 'tok', sessionUserId: '42', sessionEmail: 'existing@acme.com' },
    FLAG_ON,
  );
  assert.deepEqual(result, { status: 'workspace_gone' });
});

test('acceptJoinInvitation refuses a pending-sentinel account (set-password flow owns it)', async () => {
  const { queryable } = joinRoutes({ user: activeUserRow({ password_hash: 'invited_pending' }) });
  const result = await acceptJoinInvitation(
    queryable,
    { rawToken: 'tok', sessionUserId: '42', sessionEmail: 'existing@acme.com' },
    FLAG_ON,
  );
  assert.deepEqual(result, { status: 'not_join' });
});

test('acceptJoinInvitation reports expired and used tokens', async () => {
  const expired = joinRoutes({
    invitation: { id: 7, user_id: 42, organization_id: 11, email: 'e@a.com', role: 'tenant_analyst', invited_by_user_id: 3, expires_at: new Date(Date.now() - 1000), accepted_at: null },
  });
  assert.deepEqual(
    await acceptJoinInvitation(expired.queryable, { rawToken: 'tok', sessionUserId: '42', sessionEmail: 'e@a.com' }, FLAG_ON),
    { status: 'expired' },
  );

  const used = joinRoutes({
    invitation: { id: 7, user_id: 42, organization_id: 11, email: 'u@a.com', role: 'tenant_analyst', invited_by_user_id: 3, expires_at: new Date(Date.now() + 60_000), accepted_at: new Date() },
  });
  assert.deepEqual(
    await acceptJoinInvitation(used.queryable, { rawToken: 'tok', sessionUserId: '42', sessionEmail: 'u@a.com' }, FLAG_ON),
    { status: 'already_accepted' },
  );
});

test('acceptJoinInvitation is invisible flag-OFF (no queries, invalid)', async () => {
  const { queryable, calls } = joinRoutes();
  const result = await acceptJoinInvitation(
    queryable,
    { rawToken: 'tok', sessionUserId: '42', sessionEmail: 'existing@acme.com' },
    FLAG_OFF,
  );
  assert.deepEqual(result, { status: 'invalid' });
  assert.equal(calls.length, 0);
});

// ── Set-password accept, flag ON ────────────────────────────────────────────

const STRONG_PASSWORD = 'Aa1!aaaa';

function setPasswordRoutes(options: { membershipRole?: string | null; userPending?: boolean } = {}) {
  const invitation = {
    id: 7,
    user_id: 42,
    organization_id: 11,
    email: 'invitee@acme.com',
    role: 'tenant_viewer',
    expires_at: new Date(Date.now() + 60_000),
    accepted_at: null,
  };
  return makeFakeDb([
    [/from workspace_invitations\s+where token_hash/, () => ({ rows: [invitation], rowCount: 1 })],
    ...PASSTHROUGH,
    [
      /from users\s+where id = \$1\s+limit 1\s+for update/,
      () => ({
        rows: [{ id: 42, password_hash: options.userPending === false ? '$2a$12$realhash' : 'invited_pending' }],
      }),
    ],
    [
      MEMBERSHIP_LOOKUP_RE,
      () =>
        options.membershipRole === null
          ? { rows: [], rowCount: 0 }
          : { rows: [{ role: options.membershipRole ?? 'tenant_viewer', status: 'invited' }], rowCount: 1 },
    ],
    [/update users set password_hash/, () => ({ rows: [] })],
    [/update workspace_invitations set accepted_at/, () => ({ rows: [] })],
  ]);
}

test('flag ON set-password accept: org-scoped consume, pointer repoint, accepted event — and the membership role wins', async () => {
  const { queryable, calls } = setPasswordRoutes({ membershipRole: 'tenant_admin' });

  const result = await acceptWorkspaceInvitation(queryable, { rawToken: 'tok', password: STRONG_PASSWORD }, FLAG_ON);
  assert.deepEqual(result, { status: 'ok', email: 'invitee@acme.com' });

  // Consume scoped to (user, org) — a sibling org's pending invitation survives (CEO F6).
  const consume = calls.find((c) => /update workspace_invitations set accepted_at/i.test(c.sql));
  assert.match(consume!.sql.toLowerCase(), /and organization_id = \$2/);
  assert.deepEqual(consume!.params, [42, 11]);

  // The membership row's role (freshest admin intent) drives activation + mirror.
  const membershipUpsert = calls.find((c) => /insert into organization_memberships/i.test(c.sql));
  assert.deepEqual(membershipUpsert!.params.slice(0, 4), [42, 11, 'tenant_admin', 'active']);
  const pointer = calls.find((c) => /update users set organization_id = \$1, role = \$2/i.test(c.sql));
  assert.deepEqual(pointer!.params, [11, 'tenant_admin', 42]);

  const event = calls.find((c) => /insert into organization_membership_events/i.test(c.sql));
  assert.equal(event!.params[3], 'accepted');
});

test('flag ON set-password accept: an account that gained a password reports the VISIBLE not_pending (flag OFF pins invalid)', async () => {
  const flagOn = setPasswordRoutes({ userPending: false });
  assert.deepEqual(
    await acceptWorkspaceInvitation(flagOn.queryable, { rawToken: 'tok', password: STRONG_PASSWORD }, FLAG_ON),
    { status: 'not_pending' },
  );
  assert.ok(!flagOn.calls.some((c) => /update users set password_hash/i.test(c.sql)));

  const flagOff = setPasswordRoutes({ userPending: false });
  assert.deepEqual(
    await acceptWorkspaceInvitation(flagOff.queryable, { rawToken: 'tok', password: STRONG_PASSWORD }, FLAG_OFF),
    { status: 'invalid' },
  );
  assert.ok(!flagOff.calls.some((c) => /update users set password_hash/i.test(c.sql)));
});

// ── describeInvitationAcceptContext, flag ON ────────────────────────────────

function contextRoutes(row: Record<string, unknown>) {
  return makeFakeDb([[/from workspace_invitations wi/, () => ({ rows: [row], rowCount: 1 })]]);
}

const CONTEXT_BASE = {
  id: 7,
  user_id: 42,
  organization_id: 11,
  email: 'invitee@acme.com',
  role: 'tenant_analyst',
  expires_at: new Date(Date.now() + 60_000),
  accepted_at: null,
  workspace_name: 'Sugar & Leather',
  inviter_name: 'Brendan',
};

test('flag ON accept context: invited membership + active account → join mode (with the membership role)', async () => {
  const { queryable, calls } = contextRoutes({
    ...CONTEXT_BASE,
    invitee_password_hash: '$2a$12$realhash',
    invitee_organization_id: 58,
    membership_status: 'invited',
    membership_role: 'tenant_admin',
  });
  const result = await describeInvitationAcceptContext(queryable, 'tok', FLAG_ON);
  assert.deepEqual(result, {
    status: 'valid',
    email: 'invitee@acme.com',
    mode: 'join',
    workspaceName: 'Sugar & Leather',
    inviterName: 'Brendan',
    role: 'tenant_admin',
  });
  // The flag-ON query carries the membership join.
  assert.match(calls[0].sql.toLowerCase(), /left join organization_memberships m/);
});

test('flag ON accept context: no membership row + active account → absorb mode (Phase 0.5 unchanged)', async () => {
  const { queryable } = contextRoutes({
    ...CONTEXT_BASE,
    invitee_password_hash: '$2a$12$realhash',
    invitee_organization_id: 58,
    membership_status: null,
    membership_role: null,
  });
  const result = await describeInvitationAcceptContext(queryable, 'tok', FLAG_ON);
  assert.equal(result.status, 'valid');
  if (result.status !== 'valid') return;
  assert.equal(result.mode, 'absorb');
});

test('flag ON accept context: active membership → already_accepted; pending account → set_password', async () => {
  const active = contextRoutes({
    ...CONTEXT_BASE,
    invitee_password_hash: '$2a$12$realhash',
    invitee_organization_id: 58,
    membership_status: 'active',
    membership_role: 'tenant_analyst',
  });
  assert.deepEqual(await describeInvitationAcceptContext(active.queryable, 'tok', FLAG_ON), {
    status: 'already_accepted',
    email: 'invitee@acme.com',
  });

  const pending = contextRoutes({
    ...CONTEXT_BASE,
    invitee_password_hash: 'invited_pending',
    invitee_organization_id: 11,
    membership_status: 'invited',
    membership_role: 'tenant_analyst',
  });
  const pendingResult = await describeInvitationAcceptContext(pending.queryable, 'tok', FLAG_ON);
  assert.equal(pendingResult.status, 'valid');
  if (pendingResult.status !== 'valid') return;
  assert.equal(pendingResult.mode, 'set_password');
});

// ── Entitlement helper (Decision 13) ────────────────────────────────────────

test('assertMultiWorkspaceEntitlement: 0 active → allowed; 1 active + free → denied; 1 active + pro → allowed', async () => {
  const zero = makeFakeDb([[ENTITLEMENT_LOCK_RE, () => ({ rows: [], rowCount: 0 })]]);
  assert.deepEqual(await assertMultiWorkspaceEntitlement(zero.queryable, 42), { allowed: true });
  assert.ok(!zero.calls.some((c) => /select plan/i.test(c.sql)), 'first membership never reads the plan');

  const free = makeFakeDb([
    [ENTITLEMENT_LOCK_RE, () => ({ rows: [{ organization_id: 58 }], rowCount: 1 })],
    [/select plan from users/, () => ({ rows: [{ plan: 'free' }], rowCount: 1 })],
  ]);
  assert.deepEqual(await assertMultiWorkspaceEntitlement(free.queryable, 42), {
    allowed: false,
    code: 'multi_workspace_requires_pro',
  });

  const pro = makeFakeDb([
    [ENTITLEMENT_LOCK_RE, () => ({ rows: [{ organization_id: 58 }], rowCount: 1 })],
    [/select plan from users/, () => ({ rows: [{ plan: 'pro' }], rowCount: 1 })],
  ]);
  assert.deepEqual(await assertMultiWorkspaceEntitlement(pro.queryable, 42), { allowed: true });
});

// ── Flag-OFF fork-boundary pin ──────────────────────────────────────────────

test('flag OFF pin: an existing non-orphan account in another org still gets email_taken (byte-identical master behavior)', async () => {
  const { queryable, calls } = makeFakeDb([
    [/from users where lower\(email\)/, () => ({ rows: [{ id: 42, organization_id: 58, password_hash: '$2a$12$abcdefghijklmnopqrstuv' }], rowCount: 1 })],
    [ORPHAN_PREDICATE_RE, () => ({ rows: [orphanPredicateRow({ has_posts: true })] })],
  ]);
  const result = await inviteWorkspaceMember(
    queryable,
    { organizationId: '11', email: 'busy@acme.com' },
    FLAG_OFF,
  );
  assert.equal(result.status, 'email_taken');
  assert.ok(!calls.some((c) => MEMBERSHIP_LOOKUP_RE.test(c.sql.toLowerCase())), 'flag OFF never reads membership status');
});
