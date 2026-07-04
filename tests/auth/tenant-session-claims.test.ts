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

test('session claims may carry workspaceCount (multi-workspace augment) without affecting context resolution', () => {
  // types/next-auth.d.ts augments Session.user with workspaceCount (Phase 1).
  // It is informational for the shell (switcher gating) — tenant context
  // resolution neither requires nor surfaces it.
  const context = resolveTenantContextFromSession({
    user: {
      id: '42',
      tenantId: 'tenant_abc',
      tenantSlug: 'acme',
      role: 'tenant_admin',
      workspaceCount: 3,
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
