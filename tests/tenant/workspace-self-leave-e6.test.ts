/**
 * E6 self-service "Leave workspace" (multi-workspace plan Phase 3; design gate
 * D4/E6 ACCEPTED — reuse remove-member semantics + the last-admin guard).
 *
 * The remove-member DOMAIN function (deleteTenantUserProfile) is covered by
 * tests/tenant/user-profiles-phase2.test.ts (membership-only delete, repoint,
 * last-admin, flag-OFF byte-identity). This file adds the E6-specific pieces
 * that file does not:
 *   1. The ROUTE-level `isSelfLeave` AUTHORIZATION gate — flag ON, a NON-admin
 *      may remove THEIR OWN membership (leaving), but admin-removing-someone-else
 *      stays admin-gated; flag OFF, self-leave is UNREACHABLE by the flag (the
 *      DELETE path stays admin-gated → the legacy account-delete, never a
 *      viewer self-serve), i.e. byte-identical.
 *   2. A behavioral re-assert that self-leave through the domain fn removes ONLY
 *      the membership (the users row + the user's OTHER memberships survive),
 *      the last-admin self-leave is BLOCKED, and the resolver repoints in the
 *      same txn so the next request converges.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { deleteTenantUserProfile } from '../../backend/tenant/user-profiles';
import { repoPath } from '../prd-invariants/_helpers';

const FLAG_ON = { ARIES_MULTI_WORKSPACE_ENABLED: '1', NODE_ENV: 'production' } as NodeJS.ProcessEnv;
const FLAG_OFF = { ARIES_MULTI_WORKSPACE_ENABLED: '0', NODE_ENV: 'production' } as NodeJS.ProcessEnv;

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

const USER_LOCK_RE = /from users\s+where id = \$1\s+limit 1\s+for update/;
const MEMBERSHIP_LOCK_RE = /select role, status, created_at\s+from organization_memberships/;
const ADMIN_LOCK_RE = /select user_id\s+from organization_memberships\s+where organization_id = \$1 and role = 'tenant_admin' and status = 'active'\s+for update/;
const OTHER_ADMIN_EXISTS_RE = /select 1\s+from organization_memberships\s+where organization_id = \$1[\s\S]*and user_id <> \$2/;
const MRU_RE = /order by last_active_at desc nulls last/;

function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 5,
    organization_id: 11,
    email: 'analyst@acme.com',
    full_name: 'Analyst',
    role: 'tenant_analyst',
    password_hash: '$2a$12$realhash',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ── Behavioral: self-leave removes ONLY the membership, repoints, last-admin ──

test('E6 self-leave (flag ON): removes ONLY the membership row — the account + other memberships survive — and repoints in the same txn', async () => {
  const { queryable, calls } = makeFakeDb([
    ...PASSTHROUGH,
    [USER_LOCK_RE, () => ({ rows: [userRow()] })],
    // The leaver is a non-admin analyst here (self-leave regardless of role).
    [MEMBERSHIP_LOCK_RE, () => ({ rows: [{ role: 'tenant_analyst', status: 'active', created_at: '2026-01-01' }] })],
    // MRU next-membership: repoint to org 22 (another workspace the user is in).
    [MRU_RE, () => ({ rows: [{ organization_id: 22, role: 'tenant_viewer' }] })],
    [/organization_membership_events/, () => ({ rows: [] })],
  ]);

  const result = await deleteTenantUserProfile(
    queryable,
    { tenantId: '11', userId: '5', actorUserId: '5' /* self */ },
    FLAG_ON,
  );
  assert.equal(result.status, 'deleted');

  // Membership deleted; users row NEVER deleted (the account + its data survive).
  assert.ok(calls.some((c) => /delete from organization_memberships/i.test(c.sql)), 'the membership row must be deleted');
  assert.ok(!calls.some((c) => /delete from users/i.test(c.sql)), 'the users row must NEVER be deleted on self-leave');

  // Resolver repoint in the SAME txn (pointer + role mirror together) → converges next request.
  const repoint = calls.find((c) => /update users set organization_id = \$1, role = \$2/i.test(c.sql));
  assert.ok(repoint, 'the active pointer must repoint to the next membership in the same txn');
  assert.deepEqual(repoint!.params, [22, 'tenant_viewer', 5]);
  assert.ok(calls.some((c) => MRU_RE.test(c.sql.toLowerCase())), 'the next workspace is chosen by MRU order');
  assert.ok(calls.some((c) => /^\s*commit/i.test(c.sql)), 'the leave commits');
});

test('E6 self-leave (flag ON): last-admin self-leave is BLOCKED (cannot orphan the workspace)', async () => {
  const { queryable, calls } = makeFakeDb([
    ...PASSTHROUGH,
    [USER_LOCK_RE, () => ({ rows: [userRow({ role: 'tenant_admin' })] })],
    [MEMBERSHIP_LOCK_RE, () => ({ rows: [{ role: 'tenant_admin', status: 'active', created_at: '2026-01-01' }] })],
    // No OTHER active admin exists → last-admin guard fires.
    [OTHER_ADMIN_EXISTS_RE, () => ({ rows: [], rowCount: 0 })],
  ]);

  const result = await deleteTenantUserProfile(
    queryable,
    { tenantId: '11', userId: '5', actorUserId: '5' },
    FLAG_ON,
  );
  assert.equal(result.status, 'last_admin', 'the sole admin cannot leave and orphan the workspace');
  assert.ok(!calls.some((c) => /delete from organization_memberships/i.test(c.sql)), 'no membership delete on a blocked leave');
  assert.ok(calls.some((c) => /^\s*rollback/i.test(c.sql)), 'a blocked leave rolls back');
});

// ── ROUTE authorization: isSelfLeave gate (route imports auth()+pool) ─────────

test('the profile DELETE route authorizes self-leave ONLY flag-ON, and only for the acting user (non-admins may leave; admin-removing-others stays admin-gated)', () => {
  const route = readFileSync(repoPath('app/api/tenant/profiles/[userId]/route.ts'), 'utf8');

  const del = route.slice(route.indexOf('export async function DELETE'));

  // Self-leave is gated on BOTH the flag AND "the target is the acting user".
  assert.match(
    del,
    /const isSelfLeave\s*=\s*[\s\S]*isMultiWorkspaceEnabled\(\)[\s\S]*String\(userId\)\s*===\s*String\(tenantContext\.userId\)/,
    'self-leave must require flag ON AND target userId === acting userId',
  );

  // A NON-self, NON-admin caller is forbidden (admin-removing-others stays
  // admin-gated); a self-leave bypasses the admin gate.
  assert.match(
    del,
    /if\s*\(!isSelfLeave\s*&&\s*tenantContext\.role\s*!==\s*'tenant_admin'\)\s*\{\s*[\s\S]*?'forbidden'[\s\S]*?403/,
    'only a self-leave OR a tenant_admin may reach the delete; everyone else is 403 forbidden',
  );

  // Flag OFF: isSelfLeave is false by construction (the && short-circuits on the
  // flag), so a non-admin self-DELETE is forbidden — the path is byte-identical
  // to the legacy admin-only account-delete. Assert the flag is the first
  // conjunct so a viewer can never self-serve flag-OFF.
  assert.match(
    del,
    /isSelfLeave\s*=\s*\n?\s*isMultiWorkspaceEnabled\(\)\s*&&/,
    'the flag must be the leading conjunct — flag OFF makes self-leave unreachable',
  );
});
