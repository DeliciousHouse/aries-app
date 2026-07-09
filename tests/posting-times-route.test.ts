/**
 * GET /api/marketing/posting-times + POST /api/marketing/posting-times/derive.
 *
 * Mirrors tests/marketing-schedule-route.test.ts idioms: injected tenant
 * context loader, fake db, small Request builders. The derive handler takes an
 * injected `derive` so the test never touches Hermes or the pool.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  handleGetPostingTimes,
  handleDerivePostingTimes,
} from '../app/api/marketing/posting-times/handler';
import type { TenantContext } from '../lib/tenant-context';
import type { TenantContextLoader } from '../lib/tenant-context-http';
import type {
  DerivePostingTimesInput,
  DerivePostingTimesResult,
  PostingTimeQueryable,
} from '../backend/marketing/posting-time-advisor';

const FLAG_ON = { ARIES_AI_POSTING_TIMES_ENABLED: '1' };

function tenantLoader(
  tenantId: number,
  role: TenantContext['role'] = 'tenant_admin',
): TenantContextLoader {
  return async () =>
    ({ userId: 'u1', tenantId: String(tenantId), tenantSlug: 'test', role } as TenantContext);
}

function getRequest(): Request {
  return new Request('http://localhost/api/marketing/posting-times', { method: 'GET' });
}

function deriveRequest(): Request {
  return new Request('http://localhost/api/marketing/posting-times/derive', { method: 'POST' });
}

function makeDb(rows: unknown[] = []): { db: PostingTimeQueryable; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    db: {
      query: async (sql: string) => {
        calls.push(sql);
        return { rows, rowCount: rows.length };
      },
    },
  };
}

test('GET returns the derived rows with the flag state', async () => {
  const { db } = makeDb([
    {
      platform: 'instagram',
      hour: 19,
      minute: 0,
      days: [2, 4],
      source: 'competitor',
      sample_size: null,
      rationale: 'Competitor posts Tue/Thu evenings',
      derived_at: new Date('2026-07-09T12:00:00Z'),
    },
  ]);
  const res = await handleGetPostingTimes(getRequest(), {
    tenantContextLoader: tenantLoader(15, 'tenant_viewer'),
    db,
    env: FLAG_ON,
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { enabled: boolean; postingTimes: Array<Record<string, unknown>> };
  assert.equal(body.enabled, true);
  assert.equal(body.postingTimes.length, 1);
  assert.equal(body.postingTimes[0].platform, 'instagram');
  assert.equal(body.postingTimes[0].source, 'competitor');
  assert.equal(body.postingTimes[0].derivedAt, '2026-07-09T12:00:00.000Z');
});

test('GET with the flag off reports enabled:false and never queries', async () => {
  const { db, calls } = makeDb();
  const res = await handleGetPostingTimes(getRequest(), {
    tenantContextLoader: tenantLoader(15),
    db,
    env: {},
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { enabled: boolean; postingTimes: unknown[] };
  assert.equal(body.enabled, false);
  assert.deepEqual(body.postingTimes, []);
  assert.equal(calls.length, 0);
});

test('POST derive requires tenant_admin', async () => {
  const res = await handleDerivePostingTimes(deriveRequest(), {
    tenantContextLoader: tenantLoader(15, 'tenant_analyst'),
    env: FLAG_ON,
    derive: async () => ({ status: 'done', platforms: {} }),
  });
  assert.equal(res.status, 403);
});

test('POST derive with the flag off returns 409 posting_times_disabled', async () => {
  let called = false;
  const res = await handleDerivePostingTimes(deriveRequest(), {
    tenantContextLoader: tenantLoader(15),
    env: {},
    derive: async () => {
      called = true;
      return { status: 'done', platforms: {} };
    },
  });
  assert.equal(res.status, 409);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, 'posting_times_disabled');
  assert.equal(called, false);
});

test('POST derive fires a forced derivation for the session tenant and returns 202', async () => {
  const inputs: DerivePostingTimesInput[] = [];
  let resolveDerive: ((r: DerivePostingTimesResult) => void) | null = null;
  const derive = (input: DerivePostingTimesInput): Promise<DerivePostingTimesResult> => {
    inputs.push(input);
    return new Promise((resolve) => {
      resolveDerive = resolve;
    });
  };
  const res = await handleDerivePostingTimes(deriveRequest(), {
    tenantContextLoader: tenantLoader(15),
    env: FLAG_ON,
    derive,
  });
  assert.equal(res.status, 202, 'the route must not wait for the (potentially minute-long) research run');
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].tenantId, 15, 'tenant id comes ONLY from the session context');
  assert.equal(inputs[0].force, true, 'the button always re-derives past the TTL guard');
  resolveDerive!({ status: 'done', platforms: {} });
});
