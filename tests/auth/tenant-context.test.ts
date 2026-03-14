import assert from 'node:assert/strict';
import test from 'node:test';

import { loadTenantContextForUser } from '../../lib/tenant-context';

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
