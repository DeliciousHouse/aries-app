import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  acceptAbsorbInvitation,
  acceptWorkspaceInvitation,
  declineAbsorbInvitation,
  describeInvitationAcceptContext,
  describeInvitationByToken,
  evaluateOrphanWorkspace,
  generateInviteToken,
  hashInviteToken,
  inviteWorkspaceMember,
  resendWorkspaceInvitation,
} from '../../backend/tenant/workspace-invitations';

type Handler = (params: unknown[]) => { rows: Array<Record<string, unknown>>; rowCount?: number | null };

/**
 * A tiny SQL-routing fake. Each entry's regex is tested against the (lowercased)
 * SQL in order; the first match handles the query. Every call is recorded so a
 * test can assert what was (and was not) written.
 */
function makeFakeDb(routes: Array<[RegExp, Handler]>) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const queryable = {
    async query(sql: string, params: unknown[]) {
      calls.push({ sql, params });
      const lowered = sql.toLowerCase();
      for (const [pattern, handler] of routes) {
        if (pattern.test(lowered)) {
          return handler(params);
        }
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

const STRONG_PASSWORD = 'Aa1!aaaa';

test('hashInviteToken is the sha256 of the raw token', () => {
  const { rawToken, tokenHash } = generateInviteToken();
  assert.equal(tokenHash, crypto.createHash('sha256').update(rawToken).digest('hex'));
  assert.equal(hashInviteToken(rawToken), tokenHash);
  // base64url alphabet only — safe to drop in a URL without escaping.
  assert.match(rawToken, /^[A-Za-z0-9_-]+$/);
});

test('inviteWorkspaceMember creates a user + invitation and returns a fresh token', async () => {
  let invitationTokenHash: string | null = null;
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
      }),
    ],
    [
      /insert into workspace_invitations/,
      (params) => {
        invitationTokenHash = params[4] as string;
        return { rows: [] };
      },
    ],
  ]);

  const result = await inviteWorkspaceMember(queryable, {
    organizationId: '11',
    email: 'New@Acme.com',
    fullName: 'New User',
    role: 'tenant_analyst',
    invitedByUserId: '3',
  });

  assert.equal(result.status, 'invited');
  if (result.status !== 'invited') return;
  assert.equal(result.profile.userId, '88');
  assert.equal(result.profile.status, 'invited');
  assert.equal(result.profile.role, 'tenant_analyst');
  // The persisted hash must match the emailed raw token, and the raw token is
  // never written to the DB.
  assert.equal(invitationTokenHash, hashInviteToken(result.rawToken));
  assert.ok(!calls.some((c) => JSON.stringify(c.params).includes(result.rawToken)));
});

test('inviteWorkspaceMember refuses an already-active member of the same org', async () => {
  const { queryable, calls } = makeFakeDb([
    [
      /from users where lower\(email\)/,
      () => ({ rows: [{ id: 5, organization_id: 11, password_hash: '$2a$12$abcdefghijklmnopqrstuv' }], rowCount: 1 }),
    ],
  ]);

  const result = await inviteWorkspaceMember(queryable, { organizationId: '11', email: 'existing@acme.com' });
  assert.equal(result.status, 'already_member');
  // No transaction, no invitation row.
  assert.ok(!calls.some((c) => /insert into workspace_invitations/i.test(c.sql)));
  assert.ok(!calls.some((c) => /^\s*begin/i.test(c.sql)));
});

test('inviteWorkspaceMember refuses an email that belongs to a different org', async () => {
  const { queryable } = makeFakeDb([
    [
      /from users where lower\(email\)/,
      () => ({ rows: [{ id: 5, organization_id: 99, password_hash: 'invited_pending' }], rowCount: 1 }),
    ],
  ]);

  const result = await inviteWorkspaceMember(queryable, { organizationId: '11', email: 'taken@acme.com' });
  assert.equal(result.status, 'email_taken');
});

test('inviteWorkspaceMember re-invites a still-pending member with a new token', async () => {
  let invitationTokenHash: string | null = null;
  const { queryable } = makeFakeDb([
    [
      /from users where lower\(email\)/,
      () => ({ rows: [{ id: 5, organization_id: 11, password_hash: 'invited_pending' }], rowCount: 1 }),
    ],
    ...PASSTHROUGH,
    // updateTenantUserProfile loads the row first...
    [
      /from users u\s+where u\.id = \$1/,
      () => ({
        rows: [
          {
            id: 5,
            organization_id: 11,
            email: 'pending@acme.com',
            full_name: 'Pending',
            role: 'tenant_viewer',
            password_hash: 'invited_pending',
            created_at: '2026-06-25T00:00:00.000Z',
          },
        ],
      }),
    ],
    // ...then writes the new role.
    [
      /update users\s+set full_name/,
      (params) => ({
        rows: [
          {
            id: 5,
            organization_id: 11,
            email: 'pending@acme.com',
            full_name: 'Pending',
            role: params[1],
            password_hash: 'invited_pending',
            created_at: '2026-06-25T00:00:00.000Z',
          },
        ],
      }),
    ],
    [
      /insert into workspace_invitations/,
      (params) => {
        invitationTokenHash = params[4] as string;
        return { rows: [] };
      },
    ],
  ]);

  const result = await inviteWorkspaceMember(queryable, {
    organizationId: '11',
    email: 'pending@acme.com',
    role: 'tenant_admin',
  });

  assert.equal(result.status, 'reinvited');
  if (result.status !== 'reinvited') return;
  assert.equal(result.profile.role, 'tenant_admin');
  assert.equal(invitationTokenHash, hashInviteToken(result.rawToken));
});

test('issuing an invitation supersedes the user\'s prior live tokens', async () => {
  const { queryable, calls } = makeFakeDb([
    [/from users where lower\(email\)/, () => ({ rows: [], rowCount: 0 })],
    ...PASSTHROUGH,
    [
      /insert into users/,
      (params) => ({
        rows: [
          { id: 88, organization_id: Number(params[3]), email: params[0], full_name: params[2], role: params[4], password_hash: 'invited_pending', created_at: '2026-06-25T00:00:00.000Z' },
        ],
      }),
    ],
    [/insert into workspace_invitations/, () => ({ rows: [] })],
  ]);

  await inviteWorkspaceMember(queryable, { organizationId: '11', email: 'new@acme.com', role: 'tenant_analyst' });

  const supersede = calls.find((c) => /update workspace_invitations\s+set expires_at = now\(\)/i.test(c.sql));
  assert.ok(supersede, 'expected prior live tokens to be expired before the new INSERT');
  assert.deepEqual(supersede?.params, [88]);
  // Supersede must run BEFORE the new token is inserted.
  const supersedeIdx = calls.findIndex((c) => /update workspace_invitations\s+set expires_at = now\(\)/i.test(c.sql));
  const insertIdx = calls.findIndex((c) => /insert into workspace_invitations/i.test(c.sql));
  assert.ok(supersedeIdx >= 0 && insertIdx >= 0 && supersedeIdx < insertIdx);
});

test('accepting an invitation consumes every outstanding token for that user', async () => {
  const { queryable, calls } = makeFakeDb(
    acceptRoutes({ id: 7, user_id: 42, organization_id: 11, role: 'tenant_viewer', email: 'invitee@acme.com', expires_at: new Date(Date.now() + 60_000), accepted_at: null }),
  );

  await acceptWorkspaceInvitation(queryable, { rawToken: 'tok', password: STRONG_PASSWORD });

  const consume = calls.find((c) => /update workspace_invitations set accepted_at/i.test(c.sql));
  assert.ok(consume, 'expected an accepted_at UPDATE');
  // Keyed on user_id (all siblings), not the single row id.
  assert.deepEqual(consume?.params, [42]);
  assert.match(consume?.sql.toLowerCase() ?? '', /where user_id = \$1/);
});

test('inviteWorkspaceMember rejects an empty email and an invalid role', async () => {
  const { queryable } = makeFakeDb([]);
  assert.equal((await inviteWorkspaceMember(queryable, { organizationId: '11', email: '   ' })).status, 'missing_email');
  assert.equal(
    (await inviteWorkspaceMember(queryable, { organizationId: '11', email: 'x@y.com', role: 'root' as never })).status,
    'invalid_role',
  );
});

function acceptRoutes(invitation: Record<string, unknown> | null): Array<[RegExp, Handler]> {
  return [
    [/from workspace_invitations\s+where token_hash/, () => ({ rows: invitation ? [invitation] : [], rowCount: invitation ? 1 : 0 })],
    ...PASSTHROUGH,
    [/update users set password_hash/, () => ({ rows: [] })],
    [/update workspace_invitations set accepted_at/, () => ({ rows: [] })],
  ];
}

test('acceptWorkspaceInvitation sets the password and consumes a live invitation', async () => {
  const { queryable, calls } = makeFakeDb(
    acceptRoutes({
      id: 7,
      user_id: 42,
      organization_id: 11,
      role: 'tenant_viewer',
      email: 'invitee@acme.com',
      expires_at: new Date(Date.now() + 60_000),
      accepted_at: null,
    }),
  );

  const result = await acceptWorkspaceInvitation(queryable, { rawToken: 'tok', password: STRONG_PASSWORD });
  assert.deepEqual(result, { status: 'ok', email: 'invitee@acme.com' });

  const passwordWrite = calls.find((c) => /update users set password_hash/i.test(c.sql));
  assert.ok(passwordWrite, 'expected a users password UPDATE');
  // The stored value is a bcrypt hash, never the plaintext.
  assert.notEqual(passwordWrite?.params[0], STRONG_PASSWORD);
  assert.match(String(passwordWrite?.params[0]), /^\$2[aby]\$/);
  assert.ok(calls.some((c) => /update workspace_invitations set accepted_at/i.test(c.sql)));
});

test('acceptWorkspaceInvitation rejects a weak password before touching the DB', async () => {
  const { queryable, calls } = makeFakeDb(acceptRoutes({ id: 1, user_id: 1, email: 'a@b.com', expires_at: new Date(Date.now() + 60_000), accepted_at: null }));
  const result = await acceptWorkspaceInvitation(queryable, { rawToken: 'tok', password: 'weak' });
  assert.deepEqual(result, { status: 'weak_password' });
  assert.equal(calls.length, 0);
});

test('acceptWorkspaceInvitation reports unknown, expired, and already-accepted tokens distinctly', async () => {
  const unknown = makeFakeDb(acceptRoutes(null));
  assert.deepEqual(
    await acceptWorkspaceInvitation(unknown.queryable, { rawToken: 'nope', password: STRONG_PASSWORD }),
    { status: 'invalid' },
  );

  const expired = makeFakeDb(
    acceptRoutes({ id: 7, user_id: 42, email: 'e@acme.com', expires_at: new Date(Date.now() - 1000), accepted_at: null }),
  );
  assert.deepEqual(
    await acceptWorkspaceInvitation(expired.queryable, { rawToken: 'tok', password: STRONG_PASSWORD }),
    { status: 'expired' },
  );
  assert.ok(!expired.calls.some((c) => /update users set password_hash/i.test(c.sql)));

  const used = makeFakeDb(
    acceptRoutes({ id: 7, user_id: 42, email: 'u@acme.com', expires_at: new Date(Date.now() + 60_000), accepted_at: new Date() }),
  );
  assert.deepEqual(
    await acceptWorkspaceInvitation(used.queryable, { rawToken: 'tok', password: STRONG_PASSWORD }),
    { status: 'already_accepted' },
  );
});

test('describeInvitationByToken classifies tokens without consuming them', async () => {
  const valid = makeFakeDb([
    [/from workspace_invitations\s+where token_hash/, () => ({ rows: [{ id: 1, user_id: 1, email: 'v@acme.com', expires_at: new Date(Date.now() + 60_000), accepted_at: null }], rowCount: 1 })],
  ]);
  assert.deepEqual(await describeInvitationByToken(valid.queryable, 'tok'), { status: 'valid', email: 'v@acme.com' });

  const missing = makeFakeDb([[/from workspace_invitations/, () => ({ rows: [], rowCount: 0 })]]);
  assert.deepEqual(await describeInvitationByToken(missing.queryable, 'tok'), { status: 'invalid' });
  assert.deepEqual(await describeInvitationByToken(missing.queryable, ''), { status: 'invalid' });
});

test('resendWorkspaceInvitation only re-issues for a still-pending member', async () => {
  const pending = makeFakeDb([
    [
      /from users u\s+where u\.id = \$1/,
      () => ({
        rows: [
          { id: 9, organization_id: 11, email: 'p@acme.com', full_name: 'P', role: 'tenant_viewer', password_hash: 'invited_pending', created_at: '2026-06-25T00:00:00.000Z' },
        ],
      }),
    ],
    [/insert into workspace_invitations/, () => ({ rows: [] })],
  ]);
  const ok = await resendWorkspaceInvitation(pending.queryable, { organizationId: '11', userId: '9' });
  assert.equal(ok.status, 'ok');

  const active = makeFakeDb([
    [
      /from users u\s+where u\.id = \$1/,
      () => ({
        rows: [
          { id: 9, organization_id: 11, email: 'p@acme.com', full_name: 'P', role: 'tenant_admin', password_hash: '$2a$12$abcdefghijklmnopqrstuv', created_at: '2026-06-25T00:00:00.000Z' },
        ],
      }),
    ],
  ]);
  assert.equal((await resendWorkspaceInvitation(active.queryable, { organizationId: '11', userId: '9' })).status, 'already_active');

  const crossTenant = makeFakeDb([
    [
      /from users u\s+where u\.id = \$1/,
      () => ({
        rows: [
          { id: 9, organization_id: 99, email: 'p@acme.com', full_name: 'P', role: 'tenant_viewer', password_hash: 'invited_pending', created_at: '2026-06-25T00:00:00.000Z' },
        ],
      }),
    ],
  ]);
  assert.equal((await resendWorkspaceInvitation(crossTenant.queryable, { organizationId: '11', userId: '9' })).status, 'tenant_mismatch');
});

// ── Phase 0.5 — absorb-orphan-workspace invite relief ───────────────────────

const ORPHAN_PREDICATE_RE = /count\(\*\)::int from users where organization_id/;

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

test('evaluateOrphanWorkspace fails closed on every disqualifier', async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ member_count: 2 }, 'has_other_members'],
    [{ other_membership_count: 1 }, 'has_other_members'],
    [{ invitee_onboarding_completed_at: '2026-05-01T00:00:00.000Z' }, 'onboarding_completed'],
    [{ has_business_profile: true }, 'onboarding_completed'],
    [{ has_posts: true }, 'has_activity'],
    [{ has_connected_accounts: true }, 'has_activity'],
    [{ has_creative_assets: true }, 'has_activity'],
  ];
  for (const [overrides, reason] of cases) {
    const { queryable } = makeFakeDb([[ORPHAN_PREDICATE_RE, () => ({ rows: [orphanPredicateRow(overrides)] })]]);
    const check = await evaluateOrphanWorkspace(queryable, { organizationId: 58, userId: 42 });
    assert.deepEqual(check, { orphan: false, reason }, JSON.stringify(overrides));
  }

  const clean = makeFakeDb([[ORPHAN_PREDICATE_RE, () => ({ rows: [orphanPredicateRow()] })]]);
  assert.deepEqual(await evaluateOrphanWorkspace(clean.queryable, { organizationId: 58, userId: 42 }), { orphan: true });

  // No workspace at all → not eligible (nothing to absorb), no query issued.
  const noOrg = makeFakeDb([]);
  assert.deepEqual(await evaluateOrphanWorkspace(noOrg.queryable, { organizationId: null, userId: 42 }), {
    orphan: false,
    reason: 'no_workspace',
  });
  assert.equal(noOrg.calls.length, 0);
});

test('inviteWorkspaceMember invites an existing account whose workspace is an orphan', async () => {
  let invitationParams: unknown[] | null = null;
  const { queryable, calls } = makeFakeDb([
    [
      /from users where lower\(email\)/,
      () => ({ rows: [{ id: 42, organization_id: 58, password_hash: '$2a$12$abcdefghijklmnopqrstuv' }], rowCount: 1 }),
    ],
    [ORPHAN_PREDICATE_RE, () => ({ rows: [orphanPredicateRow()] })],
    ...PASSTHROUGH,
    [
      /insert into workspace_invitations/,
      (params) => {
        invitationParams = params;
        return { rows: [] };
      },
    ],
  ]);

  const result = await inviteWorkspaceMember(queryable, {
    organizationId: '11',
    email: 'orphan@acme.com',
    role: 'tenant_analyst',
    invitedByUserId: '3',
  });

  assert.equal(result.status, 'invited_existing_orphan');
  if (result.status !== 'invited_existing_orphan') return;
  assert.equal(result.email, 'orphan@acme.com');
  assert.equal(result.role, 'tenant_analyst');
  assert.ok(result.rawToken);
  // Invitation row targets the INVITING org and the EXISTING user.
  assert.equal(invitationParams?.[0], 11);
  assert.equal(invitationParams?.[1], 42);
  // Invite time touches nothing on the account: no user insert/update, no
  // membership write — the repoint happens only on the invitee's accept click.
  assert.ok(!calls.some((c) => /insert into users/i.test(c.sql)));
  assert.ok(!calls.some((c) => /update users/i.test(c.sql)));
  assert.ok(!calls.some((c) => /organization_memberships/i.test(c.sql) && !ORPHAN_PREDICATE_RE.test(c.sql.toLowerCase())));
});

test('inviteWorkspaceMember keeps email_taken when the other workspace is not an orphan', async () => {
  const { queryable, calls } = makeFakeDb([
    [
      /from users where lower\(email\)/,
      () => ({ rows: [{ id: 42, organization_id: 58, password_hash: '$2a$12$abcdefghijklmnopqrstuv' }], rowCount: 1 }),
    ],
    [ORPHAN_PREDICATE_RE, () => ({ rows: [orphanPredicateRow({ has_posts: true })] })],
  ]);

  const result = await inviteWorkspaceMember(queryable, { organizationId: '11', email: 'busy@acme.com' });
  assert.equal(result.status, 'email_taken');
  assert.ok(!calls.some((c) => /insert into workspace_invitations/i.test(c.sql)));
  assert.ok(!calls.some((c) => /^\s*begin/i.test(c.sql)));
});

test('inviteWorkspaceMember keeps email_taken for a pending-sentinel account in another org', async () => {
  const { queryable, calls } = makeFakeDb([
    [
      /from users where lower\(email\)/,
      () => ({ rows: [{ id: 42, organization_id: 58, password_hash: 'invited_pending' }], rowCount: 1 }),
    ],
  ]);

  const result = await inviteWorkspaceMember(queryable, { organizationId: '11', email: 'pending@acme.com' });
  assert.equal(result.status, 'email_taken');
  // A credential-less account can never give signed-in consent — the orphan
  // predicate is not even evaluated.
  assert.ok(!calls.some((c) => ORPHAN_PREDICATE_RE.test(c.sql.toLowerCase())));
});

type AbsorbOverrides = {
  invitation?: Record<string, unknown> | null;
  user?: Record<string, unknown> | null;
  predicate?: Record<string, unknown>;
};

function absorbRoutes(overrides: AbsorbOverrides = {}) {
  const invitation =
    overrides.invitation === undefined
      ? {
          id: 7,
          user_id: 42,
          organization_id: 11,
          email: 'orphan@acme.com',
          role: 'tenant_analyst',
          invited_by_user_id: 3,
          expires_at: new Date(Date.now() + 60_000),
          accepted_at: null,
        }
      : overrides.invitation;
  const user =
    overrides.user === undefined
      ? {
          id: 42,
          email: 'orphan@acme.com',
          organization_id: 58,
          role: 'tenant_admin',
          password_hash: '$2a$12$abcdefghijklmnopqrstuv',
        }
      : overrides.user;
  const routes: Array<[RegExp, Handler]> = [
    [/from workspace_invitations\s+where token_hash/, () => ({ rows: invitation ? [invitation] : [], rowCount: invitation ? 1 : 0 })],
    [ORPHAN_PREDICATE_RE, () => ({ rows: [orphanPredicateRow(overrides.predicate ?? {})] })],
    [/from users\s+where id = \$1\s+limit 1\s+for update/, () => ({ rows: user ? [user] : [], rowCount: user ? 1 : 0 })],
    ...PASSTHROUGH,
  ];
  return makeFakeDb(routes);
}

test('acceptAbsorbInvitation repoints the account, moves the membership, and writes the audit event', async () => {
  const { queryable, calls } = absorbRoutes();

  const result = await acceptAbsorbInvitation(queryable, {
    rawToken: 'tok',
    sessionUserId: '42',
    sessionEmail: 'Orphan@Acme.com',
  });
  assert.deepEqual(result, { status: 'ok', email: 'orphan@acme.com', organizationId: '11' });

  // Locking discipline: both the invitation and the user row are locked.
  const invitationSelect = calls.find((c) => /from workspace_invitations\s+where token_hash/i.test(c.sql));
  assert.match(invitationSelect?.sql.toLowerCase() ?? '', /for update/);
  const userSelect = calls.find((c) => /from users\s+where id = \$1/i.test(c.sql));
  assert.match(userSelect?.sql.toLowerCase() ?? '', /for update/);

  // Repoint carries the ADMIN-CHOSEN invitation role, never the source-org
  // tenant_admin — and NEVER touches password_hash.
  const repoint = calls.find((c) => /update users set organization_id/i.test(c.sql));
  assert.deepEqual(repoint?.params, [11, 'tenant_analyst', 42]);
  assert.ok(!calls.some((c) => /^\s*update[\s\S]*password_hash/i.test(c.sql)));

  // Membership row moves in the SAME transaction: old (user, org-58) deleted,
  // new (user, org-11) upserted active.
  const membershipDelete = calls.find((c) => /delete from organization_memberships/i.test(c.sql));
  assert.deepEqual(membershipDelete?.params, [42, 58]);
  const membershipUpsert = calls.find((c) => /insert into organization_memberships/i.test(c.sql));
  assert.ok(membershipUpsert, 'expected a membership upsert');
  assert.deepEqual(membershipUpsert?.params.slice(0, 4), [42, 11, 'tenant_analyst', 'active']);

  // Audit: absorbed event on the inviting org, actor = the invitee (consent
  // executes the absorb), source org + inviting admin in metadata.
  const event = calls.find((c) => /insert into organization_membership_events/i.test(c.sql));
  assert.ok(event, 'expected an absorbed event row');
  assert.equal(event?.params[0], 11);
  assert.equal(event?.params[1], 42);
  assert.equal(event?.params[2], 42);
  const metadata = JSON.parse(String(event?.params[3]));
  assert.equal(metadata.source_organization_id, 58);
  assert.equal(metadata.invited_by_user_id, 3);
  assert.equal(metadata.role, 'tenant_analyst');

  // The invitation (and any sibling) is consumed, and the txn commits.
  const consume = calls.find((c) => /update workspace_invitations set accepted_at/i.test(c.sql));
  assert.deepEqual(consume?.params, [42]);
  assert.ok(calls.some((c) => /^\s*commit/i.test(c.sql)));
});

test('acceptAbsorbInvitation re-checks the orphan predicate inside the txn and terminates loudly', async () => {
  const { queryable, calls } = absorbRoutes({ predicate: { member_count: 2 } });

  const result = await acceptAbsorbInvitation(queryable, {
    rawToken: 'tok',
    sessionUserId: '42',
    sessionEmail: 'orphan@acme.com',
  });
  assert.deepEqual(result, { status: 'workspace_in_use' });

  // The invitation is expired (terminated), NOT silently consumed — and the
  // termination is committed so a later click reports a dead link.
  const terminate = calls.find((c) => /update workspace_invitations set expires_at = now\(\) where id/i.test(c.sql));
  assert.deepEqual(terminate?.params, [7]);
  assert.ok(!calls.some((c) => /update workspace_invitations set accepted_at/i.test(c.sql)));
  assert.ok(calls.some((c) => /^\s*commit/i.test(c.sql)));
  // No repoint, no membership move, no event.
  assert.ok(!calls.some((c) => /update users set organization_id/i.test(c.sql)));
  assert.ok(!calls.some((c) => /delete from organization_memberships/i.test(c.sql)));
  assert.ok(!calls.some((c) => /organization_membership_events/i.test(c.sql)));
});

test('acceptAbsorbInvitation rejects a session that is not the invited account', async () => {
  const wrongUser = absorbRoutes();
  const byId = await acceptAbsorbInvitation(wrongUser.queryable, {
    rawToken: 'tok',
    sessionUserId: '99',
    sessionEmail: 'orphan@acme.com',
  });
  assert.deepEqual(byId, { status: 'email_mismatch' });
  assert.ok(!wrongUser.calls.some((c) => /^\s*(update|insert|delete)/i.test(c.sql)));
  assert.ok(wrongUser.calls.some((c) => /^\s*rollback/i.test(c.sql)));

  const wrongEmail = absorbRoutes();
  const byEmail = await acceptAbsorbInvitation(wrongEmail.queryable, {
    rawToken: 'tok',
    sessionUserId: '42',
    sessionEmail: 'someoneelse@acme.com',
  });
  assert.deepEqual(byEmail, { status: 'email_mismatch' });
  assert.ok(!wrongEmail.calls.some((c) => /^\s*(update|insert|delete)/i.test(c.sql)));
});

test('acceptAbsorbInvitation refuses expired, used, and pending-sentinel states', async () => {
  const expired = absorbRoutes({
    invitation: { id: 7, user_id: 42, organization_id: 11, email: 'o@a.com', role: 'tenant_analyst', invited_by_user_id: 3, expires_at: new Date(Date.now() - 1000), accepted_at: null },
  });
  assert.deepEqual(
    await acceptAbsorbInvitation(expired.queryable, { rawToken: 'tok', sessionUserId: '42', sessionEmail: 'o@a.com' }),
    { status: 'expired' },
  );

  const used = absorbRoutes({
    invitation: { id: 7, user_id: 42, organization_id: 11, email: 'o@a.com', role: 'tenant_analyst', invited_by_user_id: 3, expires_at: new Date(Date.now() + 60_000), accepted_at: new Date() },
  });
  assert.deepEqual(
    await acceptAbsorbInvitation(used.queryable, { rawToken: 'tok', sessionUserId: '42', sessionEmail: 'o@a.com' }),
    { status: 'already_accepted' },
  );

  const pending = absorbRoutes({
    user: { id: 42, email: 'orphan@acme.com', organization_id: 58, role: 'tenant_viewer', password_hash: 'invited_pending' },
  });
  assert.deepEqual(
    await acceptAbsorbInvitation(pending.queryable, { rawToken: 'tok', sessionUserId: '42', sessionEmail: 'orphan@acme.com' }),
    { status: 'not_absorb' },
  );
  assert.ok(!pending.calls.some((c) => /update users/i.test(c.sql)));
});

test('acceptAbsorbInvitation converges idempotently when the account is already in the inviting org', async () => {
  const { queryable, calls } = absorbRoutes({
    user: { id: 42, email: 'orphan@acme.com', organization_id: 11, role: 'tenant_analyst', password_hash: '$2a$12$abcdefghijklmnopqrstuv' },
  });
  const result = await acceptAbsorbInvitation(queryable, {
    rawToken: 'tok',
    sessionUserId: '42',
    sessionEmail: 'orphan@acme.com',
  });
  assert.deepEqual(result, { status: 'already_member', email: 'orphan@acme.com' });
  assert.ok(calls.some((c) => /update workspace_invitations set accepted_at/i.test(c.sql)));
  assert.ok(!calls.some((c) => /update users/i.test(c.sql)));
  assert.ok(!calls.some((c) => /organization_membership/i.test(c.sql)));
});

test('declineAbsorbInvitation expires the token for the invited account only', async () => {
  const invitation = {
    id: 7,
    user_id: 42,
    organization_id: 11,
    email: 'orphan@acme.com',
    role: 'tenant_analyst',
    expires_at: new Date(Date.now() + 60_000),
    accepted_at: null,
  };
  const ok = makeFakeDb([
    [/from workspace_invitations\s+where token_hash/, () => ({ rows: [invitation], rowCount: 1 })],
    [/update workspace_invitations set expires_at = now\(\)/, () => ({ rows: [] })],
  ]);
  assert.deepEqual(
    await declineAbsorbInvitation(ok.queryable, { rawToken: 'tok', sessionUserId: '42', sessionEmail: 'orphan@acme.com' }),
    { status: 'ok' },
  );
  const expire = ok.calls.find((c) => /update workspace_invitations set expires_at = now\(\)/i.test(c.sql));
  assert.deepEqual(expire?.params, [7]);

  const mismatch = makeFakeDb([
    [/from workspace_invitations\s+where token_hash/, () => ({ rows: [invitation], rowCount: 1 })],
  ]);
  assert.deepEqual(
    await declineAbsorbInvitation(mismatch.queryable, { rawToken: 'tok', sessionUserId: '99', sessionEmail: 'x@y.com' }),
    { status: 'email_mismatch' },
  );
  assert.ok(!mismatch.calls.some((c) => /update/i.test(c.sql)));
});

test('describeInvitationAcceptContext distinguishes set_password from absorb', async () => {
  const base = {
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

  const absorb = makeFakeDb([
    [/from workspace_invitations wi/, () => ({
      rows: [{ ...base, invitee_password_hash: '$2a$12$abcdefghijklmnopqrstuv', invitee_organization_id: 58 }],
      rowCount: 1,
    })],
  ]);
  assert.deepEqual(await describeInvitationAcceptContext(absorb.queryable, 'tok'), {
    status: 'valid',
    email: 'invitee@acme.com',
    mode: 'absorb',
    workspaceName: 'Sugar & Leather',
    inviterName: 'Brendan',
    role: 'tenant_analyst',
  });

  const pending = makeFakeDb([
    [/from workspace_invitations wi/, () => ({
      rows: [{ ...base, invitee_password_hash: 'invited_pending', invitee_organization_id: 11 }],
      rowCount: 1,
    })],
  ]);
  const pendingResult = await describeInvitationAcceptContext(pending.queryable, 'tok');
  assert.equal(pendingResult.status, 'valid');
  if (pendingResult.status === 'valid') {
    assert.equal(pendingResult.mode, 'set_password');
  }

  // Active account already in the inviting org with a live token → nothing to accept.
  const alreadyIn = makeFakeDb([
    [/from workspace_invitations wi/, () => ({
      rows: [{ ...base, invitee_password_hash: '$2a$12$abcdefghijklmnopqrstuv', invitee_organization_id: 11 }],
      rowCount: 1,
    })],
  ]);
  assert.deepEqual(await describeInvitationAcceptContext(alreadyIn.queryable, 'tok'), {
    status: 'already_accepted',
    email: 'invitee@acme.com',
  });
});
