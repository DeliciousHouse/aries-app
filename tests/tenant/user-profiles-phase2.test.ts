/**
 * Multi-workspace Phase 2 — member CRUD membership semantics, flag ON
 * (docs/plans/2026-07-03-multi-workspace-membership.md: Decision 5 delete =
 * membership row only, CEO E4 last-admin guard + eng finding 4 per-org FOR
 * UPDATE serialization, eng finding 10 deliberate role-mirror writes).
 *
 * Flag-OFF byte-identical behavior stays pinned by
 * tests/tenant/user-profiles-isolation.test.ts (runs with the flag unset).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deleteTenantUserProfile,
  listTenantUserProfiles,
  updateTenantUserProfile,
} from '../../backend/tenant/user-profiles';

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

const USER_LOCK_RE = /from users\s+where id = \$1\s+limit 1\s+for update/;
const MEMBERSHIP_LOCK_RE = /select role, status, created_at\s+from organization_memberships/;
const ADMIN_LOCK_RE = /select user_id\s+from organization_memberships\s+where organization_id = \$1 and role = 'tenant_admin' and status = 'active'\s+for update/;
const MRU_RE = /order by last_active_at desc nulls last/;

function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    organization_id: 11,
    email: 'member@acme.com',
    full_name: 'Member',
    role: 'tenant_admin',
    password_hash: '$2a$12$realhash',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ── List ────────────────────────────────────────────────────────────────────

test('flag ON: listTenantUserProfiles joins memberships — status/role come from the membership row, not the sentinel', async () => {
  const { queryable, calls } = makeFakeDb([
    [
      /from organization_memberships m\s+join users u/,
      (params) => {
        assert.deepEqual(params, [11]);
        return {
          rows: [
            // An existing ACTIVE account (real credentials) that is only
            // INVITED here — the sentinel projection would wrongly say active.
            {
              id: 42,
              organization_id: 11,
              email: 'consultant@other.com',
              full_name: 'Consultant',
              role: 'tenant_analyst',
              membership_status: 'invited',
              created_at: '2026-07-01T00:00:00.000Z',
            },
            {
              id: 7,
              organization_id: 11,
              email: 'owner@acme.com',
              full_name: 'Owner',
              role: 'tenant_admin',
              membership_status: 'active',
              created_at: '2026-01-01T00:00:00.000Z',
            },
          ],
        };
      },
    ],
  ]);

  const profiles = await listTenantUserProfiles(queryable, '11', FLAG_ON);
  assert.equal(profiles.length, 2);
  assert.equal(profiles[0]?.status, 'invited');
  assert.equal(profiles[0]?.role, 'tenant_analyst');
  assert.equal(profiles[1]?.status, 'active');
  // No sentinel read on the wire.
  assert.ok(!calls.some((c) => /password_hash/i.test(c.sql)));
});

// ── Update role ─────────────────────────────────────────────────────────────

function updateRoutes(options: {
  pointerOrg?: number;
  membership?: Record<string, unknown> | null;
  otherAdmins?: number[];
}) {
  return makeFakeDb([
    ...PASSTHROUGH,
    [USER_LOCK_RE, () => ({ rows: [userRow({ organization_id: options.pointerOrg ?? 11 })] })],
    [
      MEMBERSHIP_LOCK_RE,
      () =>
        options.membership === null
          ? { rows: [], rowCount: 0 }
          : {
              rows: [options.membership ?? { role: 'tenant_admin', status: 'active', created_at: '2026-01-01T00:00:00.000Z' }],
              rowCount: 1,
            },
    ],
    [ADMIN_LOCK_RE, () => ({ rows: (options.otherAdmins ?? []).map((id) => ({ user_id: id })).concat([{ user_id: 42 }]) })],
  ]);
}

test('flag ON: update-role targets the membership row and syncs the users.role mirror ONLY for the active workspace', async () => {
  // Pointer IS this org → mirror syncs.
  const active = updateRoutes({ pointerOrg: 11, otherAdmins: [7] });
  const result = await updateTenantUserProfile(
    active.queryable,
    { tenantId: '11', userId: '42', role: 'tenant_analyst', actorUserId: '7' },
    FLAG_ON,
  );
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  assert.equal(result.profile.role, 'tenant_analyst');

  const membershipUpdate = active.calls.find((c) => /update organization_memberships set role/i.test(c.sql));
  assert.deepEqual(membershipUpdate!.params, ['tenant_analyst', 42, 11]);
  const mirror = active.calls.find((c) => /update users set role = \$1/i.test(c.sql));
  assert.deepEqual(mirror!.params, ['tenant_analyst', 42], 'active-workspace edit syncs the legacy mirror');
  const event = active.calls.find((c) => /organization_membership_events/i.test(c.sql));
  assert.equal(event!.params[3], 'role_changed');
  assert.equal(event!.params[2], 7, 'actor is the editing admin');

  // Pointer is ANOTHER org → membership updates, mirror untouched (eng 10).
  const other = updateRoutes({ pointerOrg: 99, otherAdmins: [7] });
  const otherResult = await updateTenantUserProfile(
    other.queryable,
    { tenantId: '11', userId: '42', role: 'tenant_analyst' },
    FLAG_ON,
  );
  assert.equal(otherResult.status, 'ok');
  assert.ok(other.calls.some((c) => /update organization_memberships set role/i.test(c.sql)));
  assert.ok(
    !other.calls.some((c) => /update users set role/i.test(c.sql)),
    'editing a NON-active workspace membership must not touch the global mirror',
  );
});

test('flag ON: demoting the org\'s only active admin is refused under FOR UPDATE serialization (E4 + eng 4)', async () => {
  const { queryable, calls } = updateRoutes({ pointerOrg: 11, otherAdmins: [] });
  const result = await updateTenantUserProfile(
    queryable,
    { tenantId: '11', userId: '42', role: 'tenant_viewer' },
    FLAG_ON,
  );
  assert.deepEqual(result, { status: 'last_admin' });

  // The guard locked the org's active-admin rows before deciding.
  const lock = calls.find((c) => ADMIN_LOCK_RE.test(c.sql.toLowerCase()));
  assert.ok(lock, 'expected the per-org admin FOR UPDATE lock');
  // Nothing was written and the txn rolled back.
  assert.ok(!calls.some((c) => /update organization_memberships/i.test(c.sql)));
  assert.ok(!calls.some((c) => /update users/i.test(c.sql)));
  assert.ok(calls.some((c) => /^\s*rollback/i.test(c.sql)));
});

test('flag ON: demote succeeds when another active admin exists', async () => {
  const { queryable, calls } = updateRoutes({ pointerOrg: 11, otherAdmins: [7] });
  const result = await updateTenantUserProfile(
    queryable,
    { tenantId: '11', userId: '42', role: 'tenant_viewer' },
    FLAG_ON,
  );
  assert.equal(result.status, 'ok');
  assert.ok(calls.some((c) => /update organization_memberships set role/i.test(c.sql)));
});

test('flag ON: update denies when neither membership nor pointer matches (tenant_mismatch)', async () => {
  const { queryable } = updateRoutes({ pointerOrg: 99, membership: null });
  const result = await updateTenantUserProfile(
    queryable,
    { tenantId: '11', userId: '42', role: 'tenant_viewer' },
    FLAG_ON,
  );
  assert.deepEqual(result, { status: 'tenant_mismatch' });
});

// ── Delete (remove member) ──────────────────────────────────────────────────

function deleteRoutes(options: {
  pointerOrg?: number;
  membership?: Record<string, unknown> | null;
  otherAdmins?: number[];
  nextMembership?: { organization_id: number; role: string } | null;
}) {
  return makeFakeDb([
    ...PASSTHROUGH,
    [USER_LOCK_RE, () => ({ rows: [userRow({ organization_id: options.pointerOrg ?? 11 })] })],
    [
      MEMBERSHIP_LOCK_RE,
      () =>
        options.membership === null
          ? { rows: [], rowCount: 0 }
          : {
              rows: [options.membership ?? { role: 'tenant_analyst', status: 'active', created_at: '2026-01-01T00:00:00.000Z' }],
              rowCount: 1,
            },
    ],
    [ADMIN_LOCK_RE, () => ({ rows: (options.otherAdmins ?? []).map((id) => ({ user_id: id })).concat([{ user_id: 42 }]) })],
    [MRU_RE, () => (options.nextMembership ? { rows: [options.nextMembership], rowCount: 1 } : { rows: [], rowCount: 0 })],
  ]);
}

test('flag ON: remove deletes the MEMBERSHIP row only — never the users row — and expires the org\'s invitations', async () => {
  const { queryable, calls } = deleteRoutes({ pointerOrg: 99 });
  const result = await deleteTenantUserProfile(
    queryable,
    { tenantId: '11', userId: '42', actorUserId: '7' },
    FLAG_ON,
  );
  assert.deepEqual(result, { status: 'deleted' });

  const membershipDelete = calls.find((c) => /delete from organization_memberships/i.test(c.sql));
  assert.deepEqual(membershipDelete!.params, [42, 11]);
  assert.ok(!calls.some((c) => /delete from users/i.test(c.sql)), 'Decision 5: the account survives removal');

  // Accept-vs-revoke: the (user, org) invitation tokens die with the membership.
  const expire = calls.find((c) => /update workspace_invitations\s+set expires_at = now\(\)/i.test(c.sql));
  assert.deepEqual(expire!.params, [42, 11]);

  // Pointer was elsewhere → no repoint.
  assert.ok(!calls.some((c) => /update users set organization_id/i.test(c.sql)));

  const event = calls.find((c) => /organization_membership_events/i.test(c.sql));
  assert.equal(event!.params[3], 'removed');
  assert.equal(event!.params[2], 7, 'actor is the removing admin');
  assert.ok(calls.some((c) => /^\s*commit/i.test(c.sql)));
});

test('flag ON: removing the member whose ACTIVE pointer is this org repoints to the MRU membership in the SAME txn', async () => {
  const { queryable, calls } = deleteRoutes({
    pointerOrg: 11,
    membership: { role: 'tenant_analyst', status: 'active', created_at: '2026-01-01T00:00:00.000Z' },
    nextMembership: { organization_id: 58, role: 'tenant_viewer' },
  });
  const result = await deleteTenantUserProfile(queryable, { tenantId: '11', userId: '42' }, FLAG_ON);
  assert.deepEqual(result, { status: 'deleted' });

  // MRU repoint: pointer + legacy role mirror move together, inside the txn.
  const repoint = calls.find((c) => /update users set organization_id = \$1, role = \$2/i.test(c.sql));
  assert.deepEqual(repoint!.params, [58, 'tenant_viewer', 42]);
  const idx = (re: RegExp) => calls.findIndex((c) => re.test(c.sql.toLowerCase()));
  assert.ok(idx(/^\s*begin/) < idx(/update users set organization_id/), 'repoint is inside the txn');
  assert.ok(idx(/update users set organization_id/) < idx(/^\s*commit/), 'repoint commits with the delete');
  // The MRU ordering is the deterministic-default ordering.
  const mru = calls.find((c) => MRU_RE.test(c.sql.toLowerCase()));
  assert.match(mru!.sql.toLowerCase(), /status = 'active'/);
});

test('flag ON: removing the last workspace nulls the pointer (picker on next visit)', async () => {
  const { queryable, calls } = deleteRoutes({
    pointerOrg: 11,
    membership: { role: 'tenant_analyst', status: 'active', created_at: '2026-01-01T00:00:00.000Z' },
    nextMembership: null,
  });
  const result = await deleteTenantUserProfile(queryable, { tenantId: '11', userId: '42' }, FLAG_ON);
  assert.deepEqual(result, { status: 'deleted' });
  const nullPointer = calls.find((c) => /update users set organization_id = null/i.test(c.sql));
  assert.deepEqual(nullPointer!.params, [42]);
});

test('flag ON: removing the org\'s only active admin is refused (E4), serialized per-org', async () => {
  const { queryable, calls } = deleteRoutes({
    pointerOrg: 11,
    membership: { role: 'tenant_admin', status: 'active', created_at: '2026-01-01T00:00:00.000Z' },
    otherAdmins: [],
  });
  const result = await deleteTenantUserProfile(queryable, { tenantId: '11', userId: '42' }, FLAG_ON);
  assert.deepEqual(result, { status: 'last_admin' });
  assert.ok(calls.some((c) => ADMIN_LOCK_RE.test(c.sql.toLowerCase())), 'the admin rows are locked FOR UPDATE');
  assert.ok(!calls.some((c) => /delete from organization_memberships/i.test(c.sql)));
  assert.ok(calls.some((c) => /^\s*rollback/i.test(c.sql)));
});

test('flag ON: removing an INVITED admin membership needs no last-admin guard (not an active admin)', async () => {
  const { queryable, calls } = deleteRoutes({
    pointerOrg: 99,
    membership: { role: 'tenant_admin', status: 'invited', created_at: '2026-07-01T00:00:00.000Z' },
    otherAdmins: [],
  });
  const result = await deleteTenantUserProfile(queryable, { tenantId: '11', userId: '42' }, FLAG_ON);
  assert.deepEqual(result, { status: 'deleted' });
  assert.ok(!calls.some((c) => ADMIN_LOCK_RE.test(c.sql.toLowerCase())));
});

test('flag ON: delete denies when neither membership nor pointer matches (tenant_mismatch)', async () => {
  const { queryable, calls } = deleteRoutes({ pointerOrg: 99, membership: null });
  const result = await deleteTenantUserProfile(queryable, { tenantId: '11', userId: '42' }, FLAG_ON);
  assert.deepEqual(result, { status: 'tenant_mismatch' });
  assert.ok(!calls.some((c) => /delete/i.test(c.sql) && !/^\s*rollback/i.test(c.sql)));
});

// ── Flag-OFF fork-boundary pin ──────────────────────────────────────────────

test('flag OFF pin: delete still removes the users row (legacy behavior, byte-identical)', async () => {
  const { queryable, calls } = makeFakeDb([
    [
      /from users u\s+where u\.id = \$1/,
      () => ({ rows: [userRow()] }),
    ],
    [/delete from users/, () => ({ rows: [] })],
  ]);
  const result = await deleteTenantUserProfile(queryable, { tenantId: '11', userId: '42' }, FLAG_OFF);
  assert.deepEqual(result, { status: 'deleted' });
  assert.ok(calls.some((c) => /delete from users/i.test(c.sql)));
  assert.ok(!calls.some((c) => /organization_memberships/i.test(c.sql)), 'flag OFF never reads/writes memberships');
  assert.ok(!calls.some((c) => /^\s*begin/i.test(c.sql)), 'flag OFF runs no transaction');
});
