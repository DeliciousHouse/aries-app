import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTenantUserProfile,
  deleteTenantUserProfile,
  getTenantUserProfileById,
  listTenantUserProfiles,
  updateTenantUserProfile,
} from '../../backend/tenant/user-profiles';

test('listTenantUserProfiles scopes query to organization_id', async () => {
  const queryable = {
    async query(sql: string, params: unknown[]) {
      assert.match(sql, /where u\.organization_id = \$1/i);
      assert.deepEqual(params, [11]);
      return {
        rows: [
          {
            id: 7,
            organization_id: 11,
            email: 'alex@acme.com',
            full_name: 'Alex',
            role: 'tenant_admin' as const,
            created_at: '2026-03-15T00:00:00.000Z',
          },
        ],
      };
    },
  };

  const profiles = await listTenantUserProfiles(queryable, '11');
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0]?.tenantId, '11');
  assert.equal(profiles[0]?.userId, '7');
});

test('getTenantUserProfileById denies cross-tenant reads', async () => {
  const queryable = {
    async query(sql: string, params: unknown[]) {
      assert.match(sql, /where u\.id = \$1/i);
      assert.deepEqual(params, [42]);
      return {
        rows: [
          {
            id: 42,
            organization_id: 99,
            email: 'sam@other-tenant.com',
            full_name: 'Sam',
            role: 'tenant_viewer' as const,
            created_at: '2026-03-15T00:00:00.000Z',
          },
        ],
      };
    },
  };

  const result = await getTenantUserProfileById(queryable, { tenantId: '11', userId: '42' });
  assert.deepEqual(result, { status: 'tenant_mismatch' });
});

test('updateTenantUserProfile denies cross-tenant writes', async () => {
  let queryCount = 0;
  const queryable = {
    async query(sql: string, params: unknown[]) {
      queryCount += 1;
      assert.match(sql, /where u\.id = \$1/i);
      assert.deepEqual(params, [42]);
      return {
        rows: [
          {
            id: 42,
            organization_id: 99,
            email: 'sam@other-tenant.com',
            full_name: 'Sam',
            role: 'tenant_viewer' as const,
            created_at: '2026-03-15T00:00:00.000Z',
          },
        ],
      };
    },
  };

  const result = await updateTenantUserProfile(queryable, {
    tenantId: '11',
    userId: '42',
    fullName: 'Updated Name',
  });

  assert.deepEqual(result, { status: 'tenant_mismatch' });
  assert.equal(queryCount, 1);
});

test('deleteTenantUserProfile denies cross-tenant deletes', async () => {
  let queryCount = 0;
  const queryable = {
    async query(sql: string, params: unknown[]) {
      queryCount += 1;
      assert.match(sql, /where u\.id = \$1/i);
      assert.deepEqual(params, [42]);
      return {
        rows: [
          {
            id: 42,
            organization_id: 99,
            email: 'sam@other-tenant.com',
            full_name: 'Sam',
            role: 'tenant_viewer' as const,
            created_at: '2026-03-15T00:00:00.000Z',
          },
        ],
      };
    },
  };

  const result = await deleteTenantUserProfile(queryable, { tenantId: '11', userId: '42' });
  assert.deepEqual(result, { status: 'tenant_mismatch' });
  assert.equal(queryCount, 1);
});

test('createTenantUserProfile creates user in the current tenant', async () => {
  const queryable = {
    async query(sql: string, params: unknown[]) {
      assert.match(sql, /insert into users/i);
      assert.deepEqual(params, ['new@acme.com', 'invited_pending', 'New User', 11, 'tenant_analyst']);
      return {
        rows: [
          {
            id: 88,
            organization_id: 11,
            email: 'new@acme.com',
            full_name: 'New User',
            role: 'tenant_analyst' as const,
            created_at: '2026-03-15T00:00:00.000Z',
          },
        ],
      };
    },
  };

  const profile = await createTenantUserProfile(queryable, {
    tenantId: '11',
    email: 'new@acme.com',
    fullName: 'New User',
    role: 'tenant_analyst',
  });

  assert.equal(profile.tenantId, '11');
  assert.equal(profile.userId, '88');
});
