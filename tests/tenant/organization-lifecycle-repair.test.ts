/**
 * Multi-workspace Phase 4 — org-deletion pointer repair (Decision 11 + the
 * Error & Rescue Registry "organization delete (Phase 4)" row).
 *
 * Mock-level shape tests over repairPointersForDeletedOrganization: it removes
 * the deleted org's memberships + audit rows and, for any user whose ACTIVE
 * pointer targeted the org, repoints to the MRU next active membership (moving
 * the legacy role mirror in the same statement) or NULL — all in the caller's
 * transaction. Flag OFF clears strayed pointers only (no membership-derived
 * repoint), byte-identical to what a bare cascade requires. The true-lock
 * serialization is proved separately against live Postgres.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { repairPointersForDeletedOrganization } from '../../backend/tenant/organization-lifecycle';

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

const STRANDED_SELECT_RE = /select id from users where organization_id = \$1 order by id asc for update/;
const DELETE_EVENTS_RE = /delete from organization_membership_events where organization_id = \$1/;
const DELETE_MEMBERSHIPS_RE = /delete from organization_memberships where organization_id = \$1/;
const MRU_RE = /order by last_active_at desc nulls last/;
const REPOINT_ROLE_RE = /update users set organization_id = \$1, role = \$2 where id = \$3/;
const REPOINT_NULL_RE = /update users set organization_id = null where id = \$1/;

test('flag ON: repoints a stranded pointer to the MRU next active membership + moves the role mirror', async () => {
  const { queryable, calls } = makeFakeDb([
    [STRANDED_SELECT_RE, () => ({ rows: [{ id: 7 }] })],
    [DELETE_EVENTS_RE, () => ({ rows: [], rowCount: 0 })],
    [DELETE_MEMBERSHIPS_RE, () => ({ rows: [], rowCount: 2 })],
    [MRU_RE, () => ({ rows: [{ organization_id: 20, role: 'tenant_analyst' }] })],
  ]);

  const result = await repairPointersForDeletedOrganization(queryable, 11, FLAG_ON);

  assert.deepEqual(result.repointedUsers, [{ userId: '7', repointedToOrganizationId: '20' }]);
  assert.equal(result.membershipsRemoved, 2);

  // The deleted org's memberships + audit rows are removed BEFORE the MRU lookup
  // so the next-workspace query can never re-select the org going away.
  const deleteMemberships = calls.findIndex((c) => DELETE_MEMBERSHIPS_RE.test(c.sql.toLowerCase()));
  const mruLookup = calls.findIndex((c) => MRU_RE.test(c.sql.toLowerCase()));
  assert.ok(deleteMemberships >= 0 && mruLookup > deleteMemberships, 'delete precedes MRU lookup');

  // Pointer + legacy role mirror move in ONE statement (no skew window).
  const repoint = calls.find((c) => REPOINT_ROLE_RE.test(c.sql.toLowerCase()));
  assert.ok(repoint, 'repoints via a single pointer+role update');
  assert.deepEqual(repoint!.params, [20, 'tenant_analyst', 7]);
});

test('flag ON: a stranded user with NO other active membership is nulled (chooser on next login)', async () => {
  const { queryable, calls } = makeFakeDb([
    [STRANDED_SELECT_RE, () => ({ rows: [{ id: 9 }] })],
    [DELETE_MEMBERSHIPS_RE, () => ({ rows: [], rowCount: 1 })],
    [MRU_RE, () => ({ rows: [] })],
  ]);

  const result = await repairPointersForDeletedOrganization(queryable, 11, FLAG_ON);

  assert.deepEqual(result.repointedUsers, [{ userId: '9', repointedToOrganizationId: null }]);
  const nulled = calls.find((c) => REPOINT_NULL_RE.test(c.sql.toLowerCase()));
  assert.ok(nulled, 'clears the pointer to NULL');
  assert.deepEqual(nulled!.params, [9]);
});

test('flag OFF: clears strayed pointers to NULL only — no membership-derived repoint (byte-identical cascade)', async () => {
  const { queryable, calls } = makeFakeDb([
    [STRANDED_SELECT_RE, () => ({ rows: [{ id: 5 }] })],
    [DELETE_MEMBERSHIPS_RE, () => ({ rows: [], rowCount: 1 })],
  ]);

  const result = await repairPointersForDeletedOrganization(queryable, 11, FLAG_OFF);

  assert.deepEqual(result.repointedUsers, [{ userId: '5', repointedToOrganizationId: null }]);
  // Never consults organization_memberships for a next workspace flag OFF.
  assert.ok(!calls.some((c) => MRU_RE.test(c.sql.toLowerCase())), 'no MRU lookup flag OFF');
  const nulled = calls.find((c) => REPOINT_NULL_RE.test(c.sql.toLowerCase()));
  assert.ok(nulled, 'clears the pointer to NULL');
});

test('an org with no stranded pointers still removes its memberships and returns an empty repoint list', async () => {
  const { queryable } = makeFakeDb([
    [STRANDED_SELECT_RE, () => ({ rows: [] })],
    [DELETE_MEMBERSHIPS_RE, () => ({ rows: [], rowCount: 3 })],
  ]);

  const result = await repairPointersForDeletedOrganization(queryable, 11, FLAG_ON);
  assert.deepEqual(result.repointedUsers, []);
  assert.equal(result.membershipsRemoved, 3);
});

test('a non-positive/invalid org id is a no-op', async () => {
  const { queryable, calls } = makeFakeDb([]);
  const result = await repairPointersForDeletedOrganization(queryable, 0, FLAG_ON);
  assert.deepEqual(result, { repointedUsers: [], membershipsRemoved: 0 });
  assert.equal(calls.length, 0, 'no queries issued for an invalid org id');
});
