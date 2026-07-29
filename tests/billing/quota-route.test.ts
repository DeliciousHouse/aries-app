/**
 * AA-164 — GET /api/billing/quota.
 *
 * Pins the route-boundary contracts:
 *   - the company is resolved ONLY from tenant context, never from the request;
 *   - any authenticated role can READ their usage, but only an admin gets the
 *     buy affordance (the AC's "B2B Customer Admin");
 *   - `purchaseEnabled` is server-derived, so the checkout PR flips one
 *     condition rather than editing the UI;
 *   - a summary failure is a 503, never a zeroed body — a confidently wrong
 *     balance is worse than an error the customer can retry.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { handleGetBillingQuota, isSelfServePurchaseEnabled } from '@/app/api/billing/quota/handler';
import type { TenantContext } from '@/lib/tenant-context';
import type { TenantContextLoader } from '@/lib/tenant-context-http';

function tenantLoader(tenantId: string, role = 'tenant_admin'): TenantContextLoader {
  return async () =>
    ({ tenantId, tenantSlug: 'acme', role, userId: '3' }) as unknown as TenantContext;
}

function fakeDb(overrides: { tasksUsed?: string; metered?: boolean } = {}) {
  return {
    query: async (sql: string) => {
      if (sql.includes('FROM company_subscriptions')) {
        return {
          rows: [
            {
              tier_key: 'starter',
              monthly_task_allowance_override: null,
              monthly_token_allowance_override: null,
              monthly_task_allowance: 1000,
              monthly_token_allowance: 2000000,
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes('FROM company_credit_ledger')) {
        return { rows: [{ balance: '0' }], rowCount: 1 };
      }
      return {
        rows: [
          {
            rolled_through: overrides.metered === false ? null : '2026-07-28T10:00:00Z',
            tasks_used: overrides.tasksUsed ?? '400',
            tokens_used: null,
          },
        ],
        rowCount: 1,
      };
    },
  };
}

test('returns the quota summary for the session tenant', async () => {
  const res = await handleGetBillingQuota(new Request('https://x/api/billing/quota'), {
    tenantContextLoader: tenantLoader('7'),
    db: fakeDb(),
    env: {},
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.quota.used, 400);
  assert.equal(body.quota.percentUsed, 40);
  assert.equal(body.quota.metered, true);
});

test('the company id comes from tenant context, never the request', async () => {
  const seen: unknown[] = [];
  const db = {
    query: async (sql: string, params?: unknown[]) => {
      seen.push(params?.[0]);
      return fakeDb().query(sql);
    },
  };

  await handleGetBillingQuota(new Request('https://x/api/billing/quota?companyId=999'), {
    tenantContextLoader: tenantLoader('7'),
    db,
    env: {},
  });

  // A query param must never be able to read another company's usage.
  assert.ok(seen.every((id) => id === 7));
});

test('only an admin gets the buy affordance; everyone can read their usage', async () => {
  for (const [role, expected] of [
    ['tenant_admin', true],
    ['tenant_analyst', false],
    ['tenant_viewer', false],
  ] as const) {
    const res = await handleGetBillingQuota(new Request('https://x/api/billing/quota'), {
      tenantContextLoader: tenantLoader('7', role),
      db: fakeDb(),
      env: {},
    });
    const body = await res.json();
    assert.equal(res.status, 200, `${role} can read usage`);
    assert.equal(body.canPurchase, expected, `${role} canPurchase`);
  }
});

test('purchaseEnabled is false until a gateway is configured', async () => {
  assert.equal(isSelfServePurchaseEnabled({}), false);
  assert.equal(isSelfServePurchaseEnabled({ BILLING_CHECKOUT_PROVIDER: '  ' }), false);
  assert.equal(isSelfServePurchaseEnabled({ BILLING_CHECKOUT_PROVIDER: 'stripe' }), true);

  const res = await handleGetBillingQuota(new Request('https://x/api/billing/quota'), {
    tenantContextLoader: tenantLoader('7'),
    db: fakeDb(),
    env: {},
  });
  const body = await res.json();
  assert.equal(body.purchaseEnabled, false);
});

test('an unmetered workspace is reported as such, not as zero usage', async () => {
  const res = await handleGetBillingQuota(new Request('https://x/api/billing/quota'), {
    tenantContextLoader: tenantLoader('7'),
    db: fakeDb({ metered: false }),
    env: {},
  });

  const body = await res.json();
  assert.equal(body.quota.metered, false);
  assert.equal(body.quota.percentUsed, null);
  assert.equal(body.quota.used, null);
});

test('a summary failure is a 503, never a zeroed balance', async () => {
  const res = await handleGetBillingQuota(new Request('https://x/api/billing/quota'), {
    tenantContextLoader: tenantLoader('7'),
    db: {
      query: async () => {
        throw new Error('connection terminated');
      },
    },
    env: {},
  });

  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.error, 'quota_unavailable');
  assert.equal(body.quota, undefined);
});
