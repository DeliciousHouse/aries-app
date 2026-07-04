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
      if (/from organizations/i.test(sql) && /where slug/i.test(sql)) {
        return { rowCount: 0, rows: [] };
      }
      if (/insert into organizations/i.test(sql)) {
        return { rowCount: 1, rows: [{ id: 6, slug: params[1] }] };
      }
      // Membership dual-write role resolution (multi-workspace Phase 0):
      // assignUserToOrganization reads users.role to stamp the membership when no
      // role is passed. The freshly-provisioned user carries the tenant_admin
      // default.
      if (/select role from users/i.test(sql)) {
        return { rowCount: 1, rows: [{ role: 'tenant_admin' }] };
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

  assert.match(calls[0].sql, /from organizations/i);
  assert.deepEqual(calls[0].params, ['rohan-choudhary']);
  assert.match(calls[1].sql, /insert into organizations/i);
  assert.deepEqual(calls[1].params, ['Rohan Choudhary', 'rohan-choudhary']);
  assert.match(calls[2].sql, /update users set organization_id/i);
  assert.deepEqual(calls[2].params, [6, 6]);
  // Membership dual-write: resolve the active role, then upsert an 'active'
  // membership row for the newly-provisioned org.
  assert.match(calls[3].sql, /select role from users/i);
  assert.deepEqual(calls[3].params, [6]);
  assert.match(calls[4].sql, /insert into organization_memberships/i);
  assert.deepEqual(calls[4].params.slice(0, 4), [6, 6, 'tenant_admin', 'active']);
  // Dev-only role backfill still runs after provisioning.
  assert.match(calls[5].sql, /update users set role/i);
  assert.deepEqual(calls[5].params, ['tenant_admin', 6]);
  assert.equal(calls.length, 6);
});

test('ensureTenantAccessForUser does not auto-assign a role outside local dev', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const queryable = {
    async query(sql: string, params: unknown[]) {
      calls.push({ sql, params });
      if (/from organizations/i.test(sql) && /where slug/i.test(sql)) {
        return { rowCount: 0, rows: [] };
      }
      if (/insert into organizations/i.test(sql)) {
        return { rowCount: 1, rows: [{ id: 12, slug: params[1] }] };
      }
      if (/select role from users/i.test(sql)) {
        return { rowCount: 1, rows: [{ role: 'tenant_admin' }] };
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

  assert.match(calls[0].sql, /from organizations/i);
  assert.match(calls[1].sql, /insert into organizations/i);
  assert.match(calls[2].sql, /update users set organization_id/i);
  // Membership dual-write fires in prod too (it is unflagged from Phase 0 on);
  // only the dev-only users.role backfill is gated out here.
  assert.match(calls[3].sql, /select role from users/i);
  assert.match(calls[4].sql, /insert into organization_memberships/i);
  assert.equal(calls.length, 5);
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
