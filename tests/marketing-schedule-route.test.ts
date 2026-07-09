/**
 * GET/PATCH /api/marketing/schedule — multi-brand workspaces Phase 1b (#803).
 *
 * Mirrors tests/insights-comment-reply-route.test.ts idioms: an injected
 * tenant-context loader factory, a fake pool routed by SQL shape (so the
 * shared upsertMarketingSchedule/getMarketingScheduleForTenant helpers from
 * backend/marketing/schedule-store.ts run for real against an in-memory
 * table), and small Request builders.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';

import {
  handleGetMarketingSchedule,
  handlePatchMarketingSchedule,
} from '../app/api/marketing/schedule/handler';
import { WorkspaceMismatchError } from '../lib/tenant-context';
import type { TenantContext } from '../lib/tenant-context';
import type { TenantContextLoader } from '../lib/tenant-context-http';

// ── Fixtures ────────────────────────────────────────────────────────────────

function tenantLoader(
  tenantId: number,
  role: TenantContext['role'] = 'tenant_admin',
): TenantContextLoader {
  return async () =>
    ({ userId: 'u1', tenantId: String(tenantId), tenantSlug: 'test', role } as TenantContext);
}

function getRequest(): Request {
  return new Request('http://localhost/api/marketing/schedule', { method: 'GET' });
}

function patchRequest(body: unknown): Request {
  return new Request('http://localhost/api/marketing/schedule', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

type ScheduleRow = {
  tenant_id: number;
  cadence: string;
  day_of_week: number;
  hour: number;
  timezone: string | null;
  enabled: boolean;
};

// In-memory marketing_schedule table backing a fake injected Pool. Routes each
// call by SQL shape: the SELECT (getMarketingScheduleForTenant) and the
// INSERT ... ON CONFLICT (upsertMarketingSchedule) are independent pool.query
// calls, exactly mirroring how the real handler drives them.
function makeFakeScheduleDb(seed: Map<number, ScheduleRow> = new Map()) {
  const rows = new Map(seed);
  const calls: Array<{ sql: string; params: unknown[] }> = [];

  const query = async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    const norm = sql.replace(/\s+/g, ' ').trim();

    if (norm.startsWith('SELECT')) {
      const [tenantId] = params as [number];
      const row = rows.get(tenantId);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (norm.startsWith('INSERT INTO marketing_schedule')) {
      const [tenantId, dayOfWeek, hour, timezone, enabled, timezoneProvided] = params as [
        number,
        number | null,
        number | null,
        string | null,
        boolean | null,
        boolean,
      ];
      const existing = rows.get(tenantId);
      const row: ScheduleRow = {
        tenant_id: tenantId,
        cadence: 'weekly',
        day_of_week: dayOfWeek ?? existing?.day_of_week ?? 1,
        hour: hour ?? existing?.hour ?? 9,
        timezone: timezoneProvided ? timezone : existing?.timezone ?? null,
        enabled: enabled ?? existing?.enabled ?? false,
      };
      rows.set(tenantId, row);
      return { rows: [row], rowCount: 1 };
    }

    throw new Error(`unexpected sql: ${norm}`);
  };

  return { db: { query } as unknown as Pool, calls, rows };
}

function insertCallParams(calls: Array<{ sql: string; params: unknown[] }>): unknown[] {
  const call = calls.find((c) => c.sql.trim().startsWith('INSERT INTO marketing_schedule'));
  assert.ok(call, 'expected an upsert (INSERT ... ON CONFLICT) call');
  return call!.params;
}

// ── 1. Role gate ────────────────────────────────────────────────────────────

test('PATCH as tenant_analyst returns 403 forbidden with no DB write', async () => {
  const { db, calls } = makeFakeScheduleDb();
  const res = await handlePatchMarketingSchedule(patchRequest({ day: 'mon' }), {
    db,
    tenantContextLoader: tenantLoader(12, 'tenant_analyst'),
  });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'forbidden');
  assert.equal(calls.length, 0, 'a forbidden PATCH must never touch the DB');
});

test('PATCH as tenant_viewer returns 403 forbidden with no DB write', async () => {
  const { db, calls } = makeFakeScheduleDb();
  const res = await handlePatchMarketingSchedule(patchRequest({ day: 'mon' }), {
    db,
    tenantContextLoader: tenantLoader(12, 'tenant_viewer'),
  });
  assert.equal(res.status, 403);
  assert.equal(calls.length, 0);
});

test('PATCH as tenant_admin returns 200 with the upserted schedule', async () => {
  const { db } = makeFakeScheduleDb();
  const res = await handlePatchMarketingSchedule(
    patchRequest({ day: 'mon', hour: 9, timezone: 'America/New_York', enabled: true }),
    { db, tenantContextLoader: tenantLoader(12, 'tenant_admin') },
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.schedule.tenant_id, 12);
  assert.equal(body.schedule.day_of_week, 1);
  assert.equal(body.schedule.hour, 9);
  assert.equal(body.schedule.timezone, 'America/New_York');
  assert.equal(body.schedule.enabled, true);
});

// ── 2. Tenant isolation ─────────────────────────────────────────────────────

test('tenant id comes ONLY from tenantContext — a body-supplied tenant_id is ignored', async () => {
  const { db, calls } = makeFakeScheduleDb();
  await handlePatchMarketingSchedule(patchRequest({ tenant_id: 999, day: 'mon' }), {
    db,
    tenantContextLoader: tenantLoader(12, 'tenant_admin'),
  });
  const params = insertCallParams(calls);
  assert.equal(params[0], 12, 'the upsert tenantId param must be the loader tenant, never the body value');
});

// ── 3. Partial PATCH preserves omitted fields ───────────────────────────────

test('partial PATCH {enabled:false} leaves day/hour null (preserve) and timezoneProvided false', async () => {
  const { db, calls } = makeFakeScheduleDb();
  const res = await handlePatchMarketingSchedule(patchRequest({ enabled: false }), {
    db,
    tenantContextLoader: tenantLoader(12, 'tenant_admin'),
  });
  assert.equal(res.status, 200);
  const [, dayOfWeek, hour, , enabled, timezoneProvided] = insertCallParams(calls);
  assert.equal(dayOfWeek, null);
  assert.equal(hour, null);
  assert.equal(timezoneProvided, false);
  assert.equal(enabled, false);
});

test('partial PATCH {day:"fri"} leaves the enabled param null (preserve)', async () => {
  const { db, calls } = makeFakeScheduleDb();
  const res = await handlePatchMarketingSchedule(patchRequest({ day: 'fri' }), {
    db,
    tenantContextLoader: tenantLoader(12, 'tenant_admin'),
  });
  assert.equal(res.status, 200);
  const [, dayOfWeek, hour, , enabled] = insertCallParams(calls);
  assert.equal(dayOfWeek, 5);
  assert.equal(hour, null);
  assert.equal(enabled, null);
});

test('PATCH {timezone: null} is an explicit clear (timezoneProvided true, value null)', async () => {
  const seed = new Map<number, ScheduleRow>([
    [12, { tenant_id: 12, cadence: 'weekly', day_of_week: 1, hour: 9, timezone: 'America/New_York', enabled: true }],
  ]);
  const { db, calls } = makeFakeScheduleDb(seed);
  const res = await handlePatchMarketingSchedule(patchRequest({ timezone: null }), {
    db,
    tenantContextLoader: tenantLoader(12, 'tenant_admin'),
  });
  assert.equal(res.status, 200);
  const [, , , timezone, , timezoneProvided] = insertCallParams(calls);
  assert.equal(timezone, null);
  assert.equal(timezoneProvided, true);
});

test('day/hour accept numeric JSON forms in addition to strings (CLI parity)', async () => {
  const { db, calls } = makeFakeScheduleDb();
  const res = await handlePatchMarketingSchedule(patchRequest({ day: 3, hour: '14' }), {
    db,
    tenantContextLoader: tenantLoader(12, 'tenant_admin'),
  });
  assert.equal(res.status, 200);
  const [, dayOfWeek, hour] = insertCallParams(calls);
  assert.equal(dayOfWeek, 3);
  assert.equal(hour, 14);
});

// ── 4. Workspace-mismatch interlock ─────────────────────────────────────────

test('loader throwing WorkspaceMismatchError maps PATCH to 409, no DB write', async () => {
  const { db, calls } = makeFakeScheduleDb();
  const loader: TenantContextLoader = async () => {
    throw new WorkspaceMismatchError('workspace_mismatch', '9', '7');
  };
  const res = await handlePatchMarketingSchedule(patchRequest({ day: 'mon' }), {
    db,
    tenantContextLoader: loader,
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.reason, 'workspace_mismatch');
  assert.equal(calls.length, 0);
});

test('loader throwing WorkspaceMismatchError maps GET to 409, no DB read', async () => {
  const { db, calls } = makeFakeScheduleDb();
  const loader: TenantContextLoader = async () => {
    throw new WorkspaceMismatchError('workspace_mismatch', '9', '7');
  };
  const res = await handleGetMarketingSchedule(getRequest(), { db, tenantContextLoader: loader });
  assert.equal(res.status, 409);
  assert.equal(calls.length, 0);
});

// ── 5. Field validation ──────────────────────────────────────────────────────

test('PATCH {hour: 99} returns 400 invalid_hour, no DB write', async () => {
  const { db, calls } = makeFakeScheduleDb();
  const res = await handlePatchMarketingSchedule(patchRequest({ hour: 99 }), {
    db,
    tenantContextLoader: tenantLoader(12, 'tenant_admin'),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'invalid_hour');
  assert.equal(calls.length, 0);
});

test('PATCH {timezone: "Not/AZone"} returns 400 invalid_timezone, no DB write', async () => {
  const { db, calls } = makeFakeScheduleDb();
  const res = await handlePatchMarketingSchedule(patchRequest({ timezone: 'Not/AZone' }), {
    db,
    tenantContextLoader: tenantLoader(12, 'tenant_admin'),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'invalid_timezone');
  assert.equal(calls.length, 0);
});

test('PATCH {day: "nope"} returns 400 invalid_day, no DB write', async () => {
  const { db, calls } = makeFakeScheduleDb();
  const res = await handlePatchMarketingSchedule(patchRequest({ day: 'nope' }), {
    db,
    tenantContextLoader: tenantLoader(12, 'tenant_admin'),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'invalid_day');
  assert.equal(calls.length, 0);
});

test('PATCH {enabled: "nope"} returns 400 invalid_enabled, no DB write', async () => {
  const { db, calls } = makeFakeScheduleDb();
  const res = await handlePatchMarketingSchedule(patchRequest({ enabled: 'nope' }), {
    db,
    tenantContextLoader: tenantLoader(12, 'tenant_admin'),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'invalid_enabled');
  assert.equal(calls.length, 0);
});

test('PATCH {enabled: null} returns 400 invalid_enabled (only timezone supports an explicit clear)', async () => {
  const { db, calls } = makeFakeScheduleDb();
  const res = await handlePatchMarketingSchedule(patchRequest({ enabled: null }), {
    db,
    tenantContextLoader: tenantLoader(12, 'tenant_admin'),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'invalid_enabled');
  assert.equal(calls.length, 0);
});

// ── 6. GET ───────────────────────────────────────────────────────────────────

test('GET returns { schedule: null } for a tenant with no row (legacy tenant)', async () => {
  const { db } = makeFakeScheduleDb();
  const res = await handleGetMarketingSchedule(getRequest(), {
    db,
    tenantContextLoader: tenantLoader(12, 'tenant_viewer'),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.schedule, null);
});

test('GET returns the row when present, for any authenticated tenant role (read-only for non-admins)', async () => {
  const row: ScheduleRow = {
    tenant_id: 12,
    cadence: 'weekly',
    day_of_week: 1,
    hour: 9,
    timezone: 'America/New_York',
    enabled: true,
  };
  const seed = new Map<number, ScheduleRow>([[12, row]]);
  const { db } = makeFakeScheduleDb(seed);
  const res = await handleGetMarketingSchedule(getRequest(), {
    db,
    tenantContextLoader: tenantLoader(12, 'tenant_analyst'),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.schedule, row);
});
