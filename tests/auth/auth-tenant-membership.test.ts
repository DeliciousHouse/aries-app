import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ensureTenantAccessForUser,
  missingTenantClaims,
  tenantClaimsErrorRedirect,
} from '../../lib/auth-tenant-membership';

test('ensureTenantAccessForUser provisions organization and role for local-dev users missing tenant access', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const queryable = {
    async query(sql: string, params: unknown[]) {
      calls.push({ sql, params });
      if (/insert into organizations/i.test(sql)) {
        return { rowCount: 1, rows: [{ id: 6 }] };
      }
      return { rowCount: 1, rows: [] };
    },
  };

  await ensureTenantAccessForUser(
    queryable as any,
    {
      userId: 6,
      organizationId: null,
      role: null,
      name: 'Rohan Choudhary',
      email: 'rohanchoudhary2106@gmail.com',
    },
    { NODE_ENV: 'development' } as NodeJS.ProcessEnv,
  );

  assert.equal(calls.length, 3);
  assert.match(calls[0].sql, /insert into organizations/i);
  assert.deepEqual(calls[0].params, ['Rohan Choudhary', 'rohan-choudhary']);
  assert.match(calls[1].sql, /update users set organization_id/i);
  assert.deepEqual(calls[1].params, [6, 6]);
  assert.match(calls[2].sql, /update users set role/i);
  assert.deepEqual(calls[2].params, ['tenant_admin', 6]);
});

test('ensureTenantAccessForUser does not auto-assign a role outside local dev', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const queryable = {
    async query(sql: string, params: unknown[]) {
      calls.push({ sql, params });
      if (/insert into organizations/i.test(sql)) {
        return { rowCount: 1, rows: [{ id: 12 }] };
      }
      return { rowCount: 1, rows: [] };
    },
  };

  await ensureTenantAccessForUser(
    queryable as any,
    {
      userId: 12,
      organizationId: null,
      role: null,
      name: 'Prod User',
      email: 'prod@example.com',
    },
    { NODE_ENV: 'production' } as NodeJS.ProcessEnv,
  );

  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /insert into organizations/i);
  assert.match(calls[1].sql, /update users set organization_id/i);
});

test('missingTenantClaims and redirect encoding expose the exact missing fields', () => {
  const missingClaims = missingTenantClaims({
    user_id: 6,
    organization_id: null,
    tenant_id: null,
    tenant_slug: null,
    role: null,
  });

  assert.deepEqual(missingClaims, ['organization_id', 'tenant_id', 'tenant_slug', 'role']);
  assert.equal(
    tenantClaimsErrorRedirect(missingClaims),
    '/login?error=TenantClaimsIncomplete&missing=organization_id%2Ctenant_id%2Ctenant_slug%2Crole',
  );
});
