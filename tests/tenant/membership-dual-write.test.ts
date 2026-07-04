import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  assignUserToOrganization,
  upsertOrganizationMembership,
} from '../../lib/auth-tenant-membership';
import { createTenantUserProfile } from '../../backend/tenant/user-profiles';
import { acceptWorkspaceInvitation } from '../../backend/tenant/workspace-invitations';
import { resolveProjectRoot } from '../helpers/project-root';

// Mock-level (self-contained) coverage for the multi-workspace Phase 0 dual-write
// (docs/plans/2026-07-03-multi-workspace-membership.md — Eng finding 1 dual-write,
// finding 11 no role default). Every legacy provisioning path that sets
// users.organization_id must ALSO upsert the matching organization_memberships
// row so the dark tables never drift from the pointer between backfill and
// flag-flip. These tests inject a queryable and assert the exact membership
// write each path emits — the same injection pattern as the pinned
// auth-tenant-membership / user-profiles / workspace-invitations tests. The
// live-schema half is tests/tenant/membership-backfill.requires-infra.test.ts.

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

function membershipCall(calls: Array<{ sql: string; params: unknown[] }>) {
  return calls.find((c) => /insert into organization_memberships/i.test(c.sql));
}

// ── upsertOrganizationMembership: the shared write both statuses flow through ──

test('upsertOrganizationMembership writes an active row with role, status, and now()-stamped accepted/last_active timestamps', async () => {
  const { queryable, calls } = makeFakeDb([]);
  await upsertOrganizationMembership(queryable as never, {
    userId: '7',
    organizationId: '11',
    role: 'tenant_admin',
    status: 'active',
  });

  const call = membershipCall(calls);
  assert.ok(call, 'expected an organization_memberships upsert');
  // Params are stringified→Number in the helper.
  assert.deepEqual(call!.params, [7, 11, 'tenant_admin', 'active', null]);
  const sql = call!.sql.toLowerCase();
  // The CASE expressions drive the invited/active timestamp split off the status
  // parameter ($4) — assert they are present so the active row stamps accepted_at
  // + last_active_at and leaves invited_at NULL.
  assert.match(sql, /on conflict \(user_id, organization_id\) do update/);
  assert.match(sql, /when \$4 = 'active'\s+then now\(\)/, 'active status stamps accepted_at/last_active_at');
  assert.match(sql, /when \$4 = 'invited' then now\(\) else null end/, 'invited status stamps invited_at');
});

test('upsertOrganizationMembership defaults status to active and passes invitedBy through', async () => {
  const { queryable, calls } = makeFakeDb([]);
  await upsertOrganizationMembership(queryable as never, {
    userId: 3,
    organizationId: 4,
    role: 'tenant_viewer',
    // status omitted → defaults to 'active'
    invitedByUserId: 9,
  });
  const call = membershipCall(calls);
  assert.deepEqual(call!.params, [3, 4, 'tenant_viewer', 'active', 9]);
});

// ── createTenantUserProfile: invite path writes an 'invited' membership ──

test('createTenantUserProfile writes an invited membership AFTER the users INSERT', async () => {
  const { queryable, calls } = makeFakeDb([
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
            created_at: '2026-03-15T00:00:00.000Z',
          },
        ],
      }),
    ],
  ]);

  const profile = await createTenantUserProfile(queryable as never, {
    tenantId: '11',
    email: 'new@acme.com',
    fullName: 'New User',
    role: 'tenant_analyst',
  });

  assert.equal(profile.status, 'invited', 'the sentinel-created user reads as invited');
  const call = membershipCall(calls);
  assert.ok(call, 'expected an organization_memberships dual-write');
  assert.deepEqual(call!.params, [88, 11, 'tenant_analyst', 'invited', null]);

  // Ordering: the membership FK requires the user row to exist first.
  const userIdx = calls.findIndex((c) => /insert into users/i.test(c.sql));
  const memberIdx = calls.findIndex((c) => /insert into organization_memberships/i.test(c.sql));
  assert.ok(userIdx >= 0 && memberIdx >= 0 && userIdx < memberIdx, 'users INSERT precedes the membership upsert');
});

// ── acceptWorkspaceInvitation: flips the membership to active in the txn ──
//
// This also closes a coverage gap: the pinned workspace-invitations accept test
// fixtures omit organization_id/role, so the membership upsert there rides the
// fall-through mock with NaN/undefined params and asserts nothing. Here we supply
// a real invitation row and assert the active flip carries the right identifiers.

test('acceptWorkspaceInvitation flips the membership to active inside the accept transaction', async () => {
  const invitation = {
    id: 7,
    user_id: 42,
    organization_id: 11,
    email: 'invitee@acme.com',
    role: 'tenant_viewer',
    expires_at: new Date(Date.now() + 60_000),
    accepted_at: null,
  };
  const { queryable, calls } = makeFakeDb([
    [/from workspace_invitations\s+where token_hash/, () => ({ rows: [invitation], rowCount: 1 })],
    ...PASSTHROUGH,
    // The set-password accept path is pending-sentinel-only (security fix,
    // e0aec3ea): it re-loads + locks the user row inside the txn and refuses
    // unless password_hash is still the INVITED_PENDING_PASSWORD sentinel.
    // Seed the locked user SELECT with a pending row so this legacy
    // brand-new-teammate accept reaches the membership flip (mirrors
    // acceptRoutes in tests/tenant/workspace-invitations.test.ts).
    [
      /from users\s+where id = \$1\s+limit 1\s+for update/,
      () => ({ rows: [{ id: invitation.user_id, password_hash: 'invited_pending' }] }),
    ],
    [/update users set password_hash/, () => ({ rows: [] })],
    [/update workspace_invitations set accepted_at/, () => ({ rows: [] })],
  ]);

  const result = await acceptWorkspaceInvitation(queryable as never, {
    rawToken: 'tok',
    password: 'Aa1!aaaa',
  });
  assert.deepEqual(result, { status: 'ok', email: 'invitee@acme.com' });

  const call = membershipCall(calls);
  assert.ok(call, 'accept must upsert the membership to active');
  assert.deepEqual(
    call!.params,
    [42, 11, 'tenant_viewer', 'active', null],
    'membership flipped to active with the invitation user/org/role',
  );

  // It runs inside the transaction: BEGIN before the upsert, COMMIT after,
  // password write before, and NO rollback.
  const idx = (re: RegExp) => calls.findIndex((c) => re.test(c.sql.toLowerCase()));
  const beginIdx = idx(/^\s*begin/);
  const pwIdx = idx(/update users set password_hash/);
  const memberIdx = idx(/insert into organization_memberships/);
  const commitIdx = idx(/^\s*commit/);
  assert.ok(beginIdx >= 0 && beginIdx < memberIdx, 'membership upsert is inside the txn (after BEGIN)');
  assert.ok(pwIdx >= 0 && pwIdx < memberIdx, 'password write precedes the membership flip');
  assert.ok(commitIdx > memberIdx, 'COMMIT follows the membership flip');
  assert.ok(!calls.some((c) => /^\s*rollback/i.test(c.sql)), 'happy path never rolls back');
});

// ── assignUserToOrganization: explicit role vs resolve-from-users.role ──

test('assignUserToOrganization upserts an active membership with the explicit role', async () => {
  const { queryable, calls } = makeFakeDb([]);
  await assignUserToOrganization(queryable as never, {
    userId: 6,
    organizationId: 20,
    role: 'tenant_admin',
  });

  // The pointer + role mirror update, then the membership upsert.
  assert.match(calls[0].sql, /update users set organization_id/i);
  assert.match(calls[1].sql, /update users set role/i);
  const call = membershipCall(calls);
  assert.ok(call, 'expected an organization_memberships upsert');
  assert.deepEqual(call!.params, [6, 20, 'tenant_admin', 'active', null]);
  // With an explicit role, it must NOT read users.role.
  assert.ok(!calls.some((c) => /select role from users/i.test(c.sql)), 'explicit role skips the users.role read');
});

test('assignUserToOrganization resolves the role from users.role when none is supplied', async () => {
  const { queryable, calls } = makeFakeDb([
    [/select role from users/, () => ({ rows: [{ role: 'tenant_analyst' }], rowCount: 1 })],
  ]);
  await assignUserToOrganization(queryable as never, {
    userId: 6,
    organizationId: 20,
    // no role
  });

  // Pointer set (no role mirror UPDATE), then resolve, then upsert with the
  // resolved role — the membership never lands role-less (the table has no
  // default by design, Eng finding 11).
  assert.match(calls[0].sql, /update users set organization_id/i);
  assert.ok(!calls.some((c) => /update users set role/i.test(c.sql)), 'no role passed → no role-mirror UPDATE');
  const resolveIdx = calls.findIndex((c) => /select role from users/i.test(c.sql));
  const memberIdx = calls.findIndex((c) => /insert into organization_memberships/i.test(c.sql));
  assert.ok(resolveIdx >= 0 && memberIdx >= 0 && resolveIdx < memberIdx, 'role is resolved before the membership upsert');
  const call = membershipCall(calls);
  assert.deepEqual(call!.params, [6, 20, 'tenant_analyst', 'active', null]);
});

test('assignUserToOrganization writes NO membership when users.role is not a valid tenant role', async () => {
  const { queryable, calls } = makeFakeDb([
    [/select role from users/, () => ({ rows: [{ role: 'super_root' }], rowCount: 1 })],
  ]);
  await assignUserToOrganization(queryable as never, { userId: 6, organizationId: 20 });
  // A non-TenantRole must not land a role-less/garbage membership row.
  assert.ok(!calls.some((c) => /insert into organization_memberships/i.test(c.sql)), 'unresolvable role writes no membership');
});

// ── registerUserAction (credentials signup): source-structural wiring ──
//
// registerUserAction is a "use server" action that reads the module-scoped pool
// via pool.connect() and calls next/headers cookies() — it cannot be invoked
// with an injected queryable, and the repo's test runner has no module-mock flag
// (no `--experimental-test-module-mocks`; grep shows zero mock.module call
// sites). So, matching tests/signup-email-normalization.regression-017.test.ts,
// we assert the dual-write wiring at the source: email normalized on write, and
// an ACTIVE tenant_admin membership upserted only when an org was created. The
// live SQL semantics behind upsertOrganizationMembership are proven by the tests
// above + the requires-infra backfill test.

test('registerUserAction wires the active tenant_admin membership dual-write + email normalization', () => {
  const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
  const source = readFileSync(path.join(PROJECT_ROOT, '..', 'app', 'actions', 'auth.ts'), 'utf8');

  // Email normalized on write (Eng finding 7) before any users INSERT/lookup.
  assert.match(
    source,
    /normalizeEmail\(rawEmail\)/,
    'signup must normalize the raw email on write',
  );
  // The membership upsert is imported and called with active + tenant_admin,
  // guarded by an org having been created (orgId !== null).
  assert.match(
    source,
    /import\s+\{[^}]*upsertOrganizationMembership[^}]*\}\s+from\s+'@\/lib\/auth-tenant-membership'/,
    'signup must import the membership upsert helper',
  );
  assert.match(
    source,
    /if\s*\(orgId !== null\)\s*\{\s*await upsertOrganizationMembership\(client, \{[\s\S]*?role: 'tenant_admin',[\s\S]*?status: 'active',/,
    "signup must upsert an active tenant_admin membership only when an org was created",
  );
});
