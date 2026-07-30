/**
 * AA-166 — GET /api/telemetry/usage-analytics.
 *
 * Pins the route-boundary contracts:
 *   - flag OFF is a real 404 that touches no DB (an invisible endpoint, the
 *     ARIES_IMAGE_EDIT_ENABLED precedent) — checked BEFORE the role gate, so a
 *     403 can never reveal the surface exists;
 *   - admin-only, unlike /api/billing/quota: this attributes consumption to
 *     named colleagues;
 *   - the company is resolved ONLY from tenant context, never from the request;
 *   - an unrecognized grain is a 400, not a silently-different chart;
 *   - a load failure is a 503, never an empty breakdown that reads as
 *     "nobody used anything".
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { handleGetUsageAnalytics } from '@/app/api/telemetry/usage-analytics/handler';
import type { Queryable } from '@/backend/telemetry/usage-analytics';
import type { TenantContext } from '@/lib/tenant-context';
import type { TenantContextLoader } from '@/lib/tenant-context-http';

const ENABLED = { ARIES_USAGE_ANALYTICS_ENABLED: '1' } as Record<string, string>;

function tenantLoader(tenantId: string, role = 'tenant_admin'): TenantContextLoader {
  return async () =>
    ({ tenantId, tenantSlug: 'acme', role, userId: '3' }) as unknown as TenantContext;
}

function fakeDb(calls: { sql: string; params: unknown[] }[], metered = true): Queryable {
  return {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('usage_rollup_state')) {
        return {
          rows: metered ? [{ rolled_through: '2026-07-30T09:00:00Z' }] : [],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function request(query = ''): Request {
  return new Request(`https://aries.example.com/api/telemetry/usage-analytics${query}`);
}

test('flag OFF returns a real 404 and touches no database', async () => {
  const calls: { sql: string; params: unknown[] }[] = [];
  const res = await handleGetUsageAnalytics(request(), {
    tenantContextLoader: tenantLoader('7'),
    db: fakeDb(calls),
    env: {},
  });

  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'usage_analytics_disabled' });
  assert.equal(calls.length, 0);
});

test('flag OFF hides the endpoint from a non-admin too, as a 404 not a 403', async () => {
  // A 403 here would tell an analyst the surface exists.
  const res = await handleGetUsageAnalytics(request(), {
    tenantContextLoader: tenantLoader('7', 'tenant_viewer'),
    db: fakeDb([]),
    env: {},
  });

  assert.equal(res.status, 404);
});

test('a non-admin role is refused', async () => {
  for (const role of ['tenant_analyst', 'tenant_viewer']) {
    const calls: { sql: string; params: unknown[] }[] = [];
    const res = await handleGetUsageAnalytics(request(), {
      tenantContextLoader: tenantLoader('7', role),
      db: fakeDb(calls),
      env: ENABLED,
    });

    assert.equal(res.status, 403, role);
    assert.deepEqual(await res.json(), { error: 'forbidden' });
    assert.equal(calls.length, 0, 'refused before any read');
  }
});

test('returns the breakdown for the session tenant', async () => {
  const calls: { sql: string; params: unknown[] }[] = [];
  const res = await handleGetUsageAnalytics(request('?granularity=weekly'), {
    tenantContextLoader: tenantLoader('7'),
    db: fakeDb(calls),
    env: ENABLED,
    now: () => new Date('2026-07-30T14:00:00Z'),
  });

  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    analytics: { granularity: string; metered: boolean };
    enforcementMetric: string;
  };
  assert.equal(body.analytics.granularity, 'weekly');
  assert.equal(body.analytics.metered, true);
  // Echoed so the page defaults to the measure the plan gate enforces on.
  assert.equal(body.enforcementMetric, 'tasks');
});

test('the company id comes only from tenant context, never the query string', async () => {
  const calls: { sql: string; params: unknown[] }[] = [];
  await handleGetUsageAnalytics(request('?companyId=999&tenantId=999'), {
    tenantContextLoader: tenantLoader('7'),
    db: fakeDb(calls),
    env: ENABLED,
  });

  const aggregates = calls.filter((call) => !call.sql.includes('usage_rollup_state'));
  assert.ok(aggregates.length > 0);
  for (const call of aggregates) {
    assert.equal(call.params[0], 7);
  }
});

test('an unrecognized granularity is rejected rather than silently defaulted', async () => {
  const calls: { sql: string; params: unknown[] }[] = [];
  const res = await handleGetUsageAnalytics(request('?granularity=hourly'), {
    tenantContextLoader: tenantLoader('7'),
    db: fakeDb(calls),
    env: ENABLED,
  });

  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'invalid_granularity' });
  assert.equal(calls.length, 0);
});

test('an omitted granularity defaults to daily', async () => {
  const res = await handleGetUsageAnalytics(request(), {
    tenantContextLoader: tenantLoader('7'),
    db: fakeDb([]),
    env: ENABLED,
  });

  const body = (await res.json()) as { analytics: { granularity: string } };
  assert.equal(res.status, 200);
  assert.equal(body.analytics.granularity, 'daily');
});

test('an unmetered workspace gets metered:false, not a zeroed body', async () => {
  const res = await handleGetUsageAnalytics(request(), {
    tenantContextLoader: tenantLoader('7'),
    db: fakeDb([], false),
    env: ENABLED,
  });

  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    analytics: { metered: boolean; totalTokens: number | null; series: unknown[] };
  };
  assert.equal(body.analytics.metered, false);
  assert.equal(body.analytics.totalTokens, null);
  assert.deepEqual(body.analytics.series, []);
});

test('an unresolvable tenant id is a 400 before any read', async () => {
  const calls: { sql: string; params: unknown[] }[] = [];
  const res = await handleGetUsageAnalytics(request(), {
    tenantContextLoader: tenantLoader('not-a-number'),
    db: fakeDb(calls),
    env: ENABLED,
  });

  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'tenant_unresolved' });
  assert.equal(calls.length, 0);
});

test('a load failure is a 503, never an empty breakdown', async () => {
  const db: Queryable = {
    query: async () => {
      throw new Error('connection terminated unexpectedly');
    },
  };

  const res = await handleGetUsageAnalytics(request(), {
    tenantContextLoader: tenantLoader('7'),
    db,
    env: ENABLED,
  });

  assert.equal(res.status, 503);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, 'usage_analytics_unavailable');
  // The internal error text never reaches the browser.
  assert.equal(JSON.stringify(body).includes('connection terminated'), false);
});

test('an unauthenticated caller gets the shared tenant-context response', async () => {
  const res = await handleGetUsageAnalytics(request(), {
    tenantContextLoader: async () => {
      throw new Error('Authentication required.');
    },
    db: fakeDb([]),
    env: ENABLED,
  });

  assert.equal(res.status, 403);
});
