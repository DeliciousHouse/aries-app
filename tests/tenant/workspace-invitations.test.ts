import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  acceptWorkspaceInvitation,
  describeInvitationByToken,
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
