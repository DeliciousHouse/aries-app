import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveTenantContextFromSession } from '../../lib/tenant-context';

test('resolveTenantContextFromSession returns tenant context when session includes tenant claims', () => {
  const context = resolveTenantContextFromSession({
    user: {
      id: '42',
      tenantId: 'tenant_abc',
      tenantSlug: 'acme',
      role: 'tenant_admin',
    },
    expires: '2099-01-01T00:00:00.000Z',
  });

  assert.deepEqual(context, {
    userId: '42',
    tenantId: 'tenant_abc',
    tenantSlug: 'acme',
    role: 'tenant_admin',
  });
});

test('resolveTenantContextFromSession returns null when tenant claims are missing', () => {
  const context = resolveTenantContextFromSession({
    user: {
      id: '42',
    },
    expires: '2099-01-01T00:00:00.000Z',
  });

  assert.equal(context, null);
});

test('resolveTenantContextFromSession returns null when role is not tenant-scoped', () => {
  const context = resolveTenantContextFromSession({
    user: {
      id: '42',
      tenantId: 'tenant_abc',
      tenantSlug: 'acme',
      role: 'platform_owner',
    },
    expires: '2099-01-01T00:00:00.000Z',
  } as any);

  assert.equal(context, null);
});
