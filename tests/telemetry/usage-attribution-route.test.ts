/**
 * AA-165 — GET /api/internal/usage-attribution.
 *
 * This is the only route in the app that deliberately reads ACROSS tenants, so
 * these are primarily security tests:
 *   - a customer's tenant_admin is NOT internal staff and gets 403 with no data;
 *   - the staff allow-list is the whole model, and an EMPTY list denies everyone
 *     (the failure mode of "empty means open" is disclosing every company's
 *     usage to every logged-in customer);
 *   - flag OFF is a real 404 checked before any session or DB work, so the
 *     surface does not exist rather than merely refusing;
 *   - a session-store failure fails CLOSED (the inverse of the usage guards,
 *     which fail open so metering outages don't look like a paywall);
 *   - a malformed filter is a 400, and a load failure a 503 — never an empty
 *     finance report.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { handleGetUsageAttribution } from '@/app/api/internal/usage-attribution/handler';
import type { Queryable } from '@/backend/telemetry/usage-attribution';
import type { SessionLoader } from '@/lib/internal-ops-access';

const STAFF = 'ops@aries.internal';
const ENABLED = {
  ARIES_INTERNAL_USAGE_DASHBOARD_ENABLED: '1',
  ARIES_INTERNAL_OPS_EMAILS: `${STAFF}, finance@aries.internal`,
} as Record<string, string>;

function session(email: string | null): SessionLoader {
  return async () => (email === null ? null : { user: { email } });
}

function fakeDb(calls: { sql: string; params: unknown[] }[], metered = true): Queryable {
  return {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('usage_rollup_state')) {
        return { rows: metered ? [{ rolled_through: '2026-07-31T09:00:00Z' }] : [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function request(query = ''): Request {
  return new Request(`https://aries.example.com/api/internal/usage-attribution${query}`);
}

test('flag OFF is a real 404 — no session lookup, no database', async () => {
  const calls: { sql: string; params: unknown[] }[] = [];
  let sessionAsked = false;
  const res = await handleGetUsageAttribution(request(), {
    sessionLoader: async () => {
      sessionAsked = true;
      return { user: { email: STAFF } };
    },
    db: fakeDb(calls),
    env: { ARIES_INTERNAL_OPS_EMAILS: STAFF },
  });

  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'internal_usage_dashboard_disabled' });
  assert.equal(sessionAsked, false);
  assert.equal(calls.length, 0);
});

test("a customer's tenant_admin is not internal staff and gets no data", async () => {
  const calls: { sql: string; params: unknown[] }[] = [];
  // The critical case: this account is a full admin of its OWN workspace. That
  // must not grant a cross-company view.
  const res = await handleGetUsageAttribution(request(), {
    sessionLoader: session('admin@customer-company.com'),
    db: fakeDb(calls),
    env: ENABLED,
  });

  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'forbidden' });
  assert.equal(calls.length, 0, 'refused before any read');
});

test('an empty or unset allow-list denies everyone, including a plausible staff email', async () => {
  for (const env of [
    { ARIES_INTERNAL_USAGE_DASHBOARD_ENABLED: '1' },
    { ARIES_INTERNAL_USAGE_DASHBOARD_ENABLED: '1', ARIES_INTERNAL_OPS_EMAILS: '' },
    { ARIES_INTERNAL_USAGE_DASHBOARD_ENABLED: '1', ARIES_INTERNAL_OPS_EMAILS: '   ,  ; ' },
  ]) {
    const res = await handleGetUsageAttribution(request(), {
      sessionLoader: session(STAFF),
      db: fakeDb([]),
      env,
    });
    assert.equal(res.status, 403, JSON.stringify(env));
  }
});

test('an allow-listed staff session gets the cross-company payload', async () => {
  const calls: { sql: string; params: unknown[] }[] = [];
  const res = await handleGetUsageAttribution(request(), {
    sessionLoader: session(STAFF),
    db: fakeDb(calls),
    env: ENABLED,
    now: () => new Date('2026-07-31T12:00:00Z'),
  });

  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    attribution: { metered: boolean; filters: { companyId: number | null; from: string } };
  };
  assert.equal(body.attribution.metered, true);
  // No company filter = every company, which is the point of this surface.
  assert.equal(body.attribution.filters.companyId, null);
  assert.equal(body.attribution.filters.from, '2026-07-02');
});

test('the allow-list is case-insensitive but never matches a partial address', async () => {
  const allowed = await handleGetUsageAttribution(request(), {
    sessionLoader: session('OPS@Aries.Internal'),
    db: fakeDb([]),
    env: ENABLED,
  });
  assert.equal(allowed.status, 200);

  // A substring or lookalike must not pass.
  for (const email of ['ops@aries.internal.evil.com', 'xops@aries.internal', 'ops@aries.intern']) {
    const res = await handleGetUsageAttribution(request(), {
      sessionLoader: session(email),
      db: fakeDb([]),
      env: ENABLED,
    });
    assert.equal(res.status, 403, email);
  }
});

test('no session at all is 401, not a silent empty dashboard', async () => {
  const res = await handleGetUsageAttribution(request(), {
    sessionLoader: session(null),
    db: fakeDb([]),
    env: ENABLED,
  });

  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'sign_in_required' });
});

test('a session-store failure fails CLOSED', async () => {
  const calls: { sql: string; params: unknown[] }[] = [];
  const res = await handleGetUsageAttribution(request(), {
    sessionLoader: async () => {
      throw new Error('session store unreachable');
    },
    db: fakeDb(calls),
    env: ENABLED,
  });

  // The usage guards fail OPEN so a metering outage never looks like a paywall.
  // This is the inverse: an auth outage must never look like a staff badge.
  assert.equal(res.status, 403);
  assert.equal(calls.length, 0);
});

test('filters reach the query, and a malformed one is a 400', async () => {
  const calls: { sql: string; params: unknown[] }[] = [];
  const ok = await handleGetUsageAttribution(
    request('?companyId=12&engine=AI_LLM&from=2026-06-01&to=2026-06-30'),
    { sessionLoader: session(STAFF), db: fakeDb(calls), env: ENABLED },
  );
  assert.equal(ok.status, 200);
  const aggregates = calls.filter((call) => !call.sql.includes('usage_rollup_state'));
  assert.ok(aggregates.length > 0);
  for (const call of aggregates) {
    assert.equal(call.params[2], 12);
    assert.equal(call.params[3], 'AI_LLM');
  }

  const bad = await handleGetUsageAttribution(request('?engine=NOT_AN_ENGINE'), {
    sessionLoader: session(STAFF),
    db: fakeDb([]),
    env: ENABLED,
  });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: 'invalid_engine' });
});

test('an unmetered deployment says so instead of reporting zeros', async () => {
  const res = await handleGetUsageAttribution(request(), {
    sessionLoader: session(STAFF),
    db: fakeDb([], false),
    env: ENABLED,
  });

  const body = (await res.json()) as {
    attribution: { metered: boolean; totalCostCents: number | null; companies: unknown[] };
  };
  assert.equal(res.status, 200);
  assert.equal(body.attribution.metered, false);
  assert.equal(body.attribution.totalCostCents, null);
  assert.deepEqual(body.attribution.companies, []);
});

test('a load failure is a 503 and never leaks the internal error', async () => {
  const db: Queryable = {
    query: async () => {
      throw new Error('connection terminated unexpectedly');
    },
  };

  const res = await handleGetUsageAttribution(request(), {
    sessionLoader: session(STAFF),
    db,
    env: ENABLED,
  });

  assert.equal(res.status, 503);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, 'usage_attribution_unavailable');
  assert.equal(JSON.stringify(body).includes('connection terminated'), false);
});
