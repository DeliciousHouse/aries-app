import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadTenantContextForUser,
  TenantContextError,
  resolveTenantContextForSession,
} from '../../lib/tenant-context';

test('loadTenantContextForUser returns tenant context from Postgres membership row', async () => {
  const queryable = {
    async query(sql: string, params: unknown[]) {
      assert.match(sql, /from users/i);
      assert.deepEqual(params, [42]);
      return {
        rowCount: 1,
        rows: [
          {
            user_id: '42',
            organization_id: '7',
            tenant_id: '7',
            tenant_slug: 'acme-co',
            role: 'tenant_admin' as const,
          },
        ],
      };
    },
  };

  const context = await loadTenantContextForUser(queryable, '42');

  assert.deepEqual(context, {
    userId: '42',
    tenantId: '7',
    tenantSlug: 'acme-co',
    role: 'tenant_admin',
  });
});

test('loadTenantContextForUser throws when no tenant membership exists', async () => {
  const queryable = {
    async query() {
      return { rowCount: 0, rows: [] };
    },
  };

  await assert.rejects(
    () => loadTenantContextForUser(queryable, '42'),
    /tenant membership/i
  );
});

test('loadTenantContextForUser throws a clear error when tenant claims are incomplete', async () => {
  const queryable = {
    async query() {
      return {
        rowCount: 1,
        rows: [
          {
            user_id: '42',
            organization_id: null,
            tenant_id: null,
            tenant_slug: null,
            role: null,
          },
        ],
      };
    },
  };

  await assert.rejects(
    () => loadTenantContextForUser(queryable, '42'),
    /organization_id, tenant_id, tenant_slug, role/i
  );
});

test('resolveTenantContextForSession prefers the live membership row over stale session tenant claims', async () => {
  const queryable = {
    async query(_sql: string, params: unknown[]) {
      assert.deepEqual(params, [42]);
      return {
        rowCount: 1,
        rows: [
          {
            user_id: '42',
            organization_id: '8',
            tenant_id: '8',
            tenant_slug: 'framex-studio',
            role: 'tenant_admin' as const,
          },
        ],
      };
    },
  };

  const context = await resolveTenantContextForSession(queryable, {
    user: {
      id: '42',
      tenantId: '7',
      tenantSlug: 'old-workspace',
      role: 'tenant_admin',
    },
    expires: '2099-01-01T00:00:00.000Z',
  });

  assert.deepEqual(context, {
    userId: '42',
    tenantId: '8',
    tenantSlug: 'framex-studio',
    role: 'tenant_admin',
  });
});

test('resolveTenantContextForSession rethrows tenant membership errors instead of falling back to stale session claims', async () => {
  const queryable = {
    async query() {
      return {
        rowCount: 1,
        rows: [
          {
            user_id: '42',
            organization_id: null,
            tenant_id: null,
            tenant_slug: null,
            role: null,
          },
        ],
      };
    },
  };

  await assert.rejects(
    () =>
      resolveTenantContextForSession(queryable, {
        user: {
          id: '42',
          tenantId: '7',
          tenantSlug: 'stale-tenant',
          role: 'tenant_admin',
        },
        expires: '2099-01-01T00:00:00.000Z',
      }),
    TenantContextError,
  );
});

test('resolveTenantContextForSession falls back to session claims on transient query errors', async () => {
  const queryable = {
    async query() {
      throw new Error('database temporarily unavailable');
    },
  };

  const context = await resolveTenantContextForSession(queryable, {
    user: {
      id: '42',
      tenantId: '7',
      tenantSlug: 'stale-tenant',
      role: 'tenant_admin',
    },
    expires: '2099-01-01T00:00:00.000Z',
  });

  assert.deepEqual(context, {
    userId: '42',
    tenantId: '7',
    tenantSlug: 'stale-tenant',
    role: 'tenant_admin',
  });
});
