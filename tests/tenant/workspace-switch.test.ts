import { test } from 'node:test';
import assert from 'node:assert/strict';

import { switchActiveWorkspace } from '../../backend/tenant/workspace-switch';

// Focused contract coverage for the Phase 3 switch domain function. Self-
// contained (no DB): a fake queryable dispatches by SQL substring and records
// the writes so we can assert the pointer + legacy role mirror move together in
// ONE transaction (CEO hardening 3) and last_active_at is stamped.

const FLAG_ON = { ARIES_MULTI_WORKSPACE_ENABLED: '1', NODE_ENV: 'production' } as NodeJS.ProcessEnv;
const FLAG_OFF = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;

type Call = { sql: string; params: unknown[] };

function fakeClient(targetRows: Record<string, unknown>[]) {
  const calls: Call[] = [];
  const client = {
    async query(sql: string, params: unknown[]) {
      calls.push({ sql, params });
      if (/FROM organization_memberships m/.test(sql) && /JOIN organizations o/.test(sql)) {
        return { rows: targetRows, rowCount: targetRows.length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { client, calls };
}

test('switch: flag OFF is a no-op invalid result (never repoints)', async () => {
  const { client, calls } = fakeClient([]);
  const result = await switchActiveWorkspace(client, { userId: 5, targetOrganizationId: 9 }, FLAG_OFF);
  assert.equal(result.status, 'invalid');
  assert.equal(calls.length, 0, 'flag OFF must not touch the DB');
});

test('switch: non-member target → not_member, transaction rolled back', async () => {
  const { client, calls } = fakeClient([]); // no membership row
  const result = await switchActiveWorkspace(client, { userId: 5, targetOrganizationId: 9 }, FLAG_ON);
  assert.equal(result.status, 'not_member');
  assert.ok(calls.some((c) => c.sql === 'ROLLBACK'));
  assert.ok(!calls.some((c) => /UPDATE users SET organization_id/.test(c.sql)), 'must not repoint');
});

test('switch: invited (unaccepted) membership → invited, no repoint', async () => {
  const { client, calls } = fakeClient([
    { membership_role: 'tenant_analyst', membership_status: 'invited', org_id: 9, org_name: 'Acme', org_slug: 'acme' },
  ]);
  const result = await switchActiveWorkspace(client, { userId: 5, targetOrganizationId: 9 }, FLAG_ON);
  assert.equal(result.status, 'invited');
  assert.ok(!calls.some((c) => /UPDATE users SET organization_id/.test(c.sql)), 'must not repoint an invited membership');
});

test('switch: active membership → pointer + role mirror move together, last_active stamped, committed', async () => {
  const { client, calls } = fakeClient([
    { membership_role: 'tenant_admin', membership_status: 'active', org_id: 9, org_name: 'Acme', org_slug: 'acme-co' },
  ]);
  const result = await switchActiveWorkspace(client, { userId: 5, targetOrganizationId: 9 }, FLAG_ON);
  assert.deepEqual(result, {
    status: 'ok',
    tenantId: '9',
    tenantSlug: 'acme-co',
    role: 'tenant_admin',
    workspaceName: 'Acme',
  });

  const pointerUpdate = calls.find((c) => /UPDATE users SET organization_id = \$1, role = \$2/.test(c.sql));
  assert.ok(pointerUpdate, 'pointer + role mirror must move in ONE statement');
  assert.deepEqual(pointerUpdate!.params, [9, 'tenant_admin', 5]);

  const lastActive = calls.find((c) => /UPDATE organization_memberships/.test(c.sql) && /last_active_at = now\(\)/.test(c.sql));
  assert.ok(lastActive, 'last_active_at must be stamped on the target membership');
  assert.deepEqual(lastActive!.params, [5, 9]);

  assert.ok(calls.some((c) => c.sql === 'BEGIN'));
  assert.ok(calls.some((c) => c.sql === 'COMMIT'));
});

test('switch: corrupt membership role → invalid, rolled back', async () => {
  const { client } = fakeClient([
    { membership_role: 'root', membership_status: 'active', org_id: 9, org_name: 'Acme', org_slug: 'acme' },
  ]);
  const result = await switchActiveWorkspace(client, { userId: 5, targetOrganizationId: 9 }, FLAG_ON);
  assert.equal(result.status, 'invalid');
});

test('switch: non-integer target id → invalid before any DB work', async () => {
  const { client, calls } = fakeClient([]);
  const result = await switchActiveWorkspace(
    client,
    { userId: 5, targetOrganizationId: 'not-a-number' },
    FLAG_ON,
  );
  assert.equal(result.status, 'invalid');
  assert.equal(calls.length, 0);
});
