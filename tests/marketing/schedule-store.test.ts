/**
 * backend/marketing/schedule-store.ts — self-contained unit tests (no live
 * DB). Recording-fake queryable idiom mirrors
 * tests/auth/tenant-resolution-flag-off-golden.test.ts /
 * tests/tenant/business-profile.test.ts.
 *
 * Covers:
 *   - provisionDefaultMarketingSchedule: exact ON CONFLICT DO NOTHING SQL +
 *     params, created:true on rowCount 1, created:false on rowCount 0 with
 *     no second (update) statement ever issued;
 *   - upsertMarketingSchedule: byte-identical to the CLI's original
 *     COALESCE-preserve SQL, omitted-arg preservation, and the
 *     timezoneProvided clear-vs-omit distinction;
 *   - the four validators reject invalid input (return null) and accept the
 *     documented formats.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com ./node_modules/.bin/tsx --test tests/marketing/schedule-store.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getMarketingScheduleForTenant,
  isValidScheduleTimezone,
  listMarketingSchedules,
  parseScheduleDay,
  parseScheduleEnabled,
  parseScheduleHour,
  provisionDefaultMarketingSchedule,
  upsertMarketingSchedule,
  type ScheduleQueryable,
} from '../../backend/marketing/schedule-store';

// ---------------------------------------------------------------------------
// Recording fixture
// ---------------------------------------------------------------------------

type Call = { sql: string; params: unknown[] };

function recordingQueryable(
  respond: (sql: string, params: unknown[]) => { rowCount: number | null; rows: Array<Record<string, unknown>> },
): { calls: Call[]; queryable: ScheduleQueryable } {
  const calls: Call[] = [];
  return {
    calls,
    queryable: {
      async query(sql: string, params: unknown[] = []) {
        calls.push({ sql, params });
        return respond(sql, params);
      },
    },
  };
}

// ---------------------------------------------------------------------------
// provisionDefaultMarketingSchedule
// ---------------------------------------------------------------------------

test('provisionDefaultMarketingSchedule: emits ON CONFLICT DO NOTHING with the default day/hour/enabled params', async () => {
  const { calls, queryable } = recordingQueryable(() => ({ rowCount: 1, rows: [] }));

  const result = await provisionDefaultMarketingSchedule(queryable, {
    tenantId: 42,
    timezone: 'America/New_York',
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO marketing_schedule/);
  assert.match(calls[0].sql, /ON CONFLICT \(tenant_id\) DO NOTHING/);
  assert.doesNotMatch(calls[0].sql, /DO UPDATE/);
  assert.deepEqual(calls[0].params, [42, 'weekly', 1, 9, 'America/New_York', true]);
  assert.deepEqual(result, { created: true });
});

test('provisionDefaultMarketingSchedule: created:false on rowCount 0 (conflict), and issues NO update statement', async () => {
  const { calls, queryable } = recordingQueryable(() => ({ rowCount: 0, rows: [] }));

  const result = await provisionDefaultMarketingSchedule(queryable, {
    tenantId: 42,
    timezone: null,
  });

  assert.equal(calls.length, 1, 'DO NOTHING must never be followed by a second (update) query');
  assert.deepEqual(result, { created: false });
});

test('provisionDefaultMarketingSchedule: null rowCount (driver quirk) is treated as created:false, not thrown', async () => {
  const { queryable } = recordingQueryable(() => ({ rowCount: null, rows: [] }));
  const result = await provisionDefaultMarketingSchedule(queryable, { tenantId: 1, timezone: null });
  assert.deepEqual(result, { created: false });
});

test('provisionDefaultMarketingSchedule: overrides for dayOfWeek/hour/enabled are honored', async () => {
  const { calls, queryable } = recordingQueryable(() => ({ rowCount: 1, rows: [] }));

  await provisionDefaultMarketingSchedule(queryable, {
    tenantId: 7,
    timezone: 'UTC',
    dayOfWeek: 3,
    hour: 14,
    enabled: false,
  });

  assert.deepEqual(calls[0].params, [7, 'weekly', 3, 14, 'UTC', false]);
});

// ---------------------------------------------------------------------------
// upsertMarketingSchedule — CLI-parity COALESCE-preserve SQL
// ---------------------------------------------------------------------------

const CLI_UPSERT_SQL =
  `INSERT INTO marketing_schedule (tenant_id, cadence, day_of_week, hour, timezone, enabled)\n     VALUES ($1, 'weekly', COALESCE($2, 1), COALESCE($3, 9), $4, COALESCE($5, false))\n     ON CONFLICT (tenant_id) DO UPDATE\n       SET day_of_week = COALESCE($2, marketing_schedule.day_of_week),\n           hour        = COALESCE($3, marketing_schedule.hour),\n           timezone    = CASE WHEN $6 THEN $4 ELSE marketing_schedule.timezone END,\n           enabled     = COALESCE($5, marketing_schedule.enabled),\n           updated_at  = now()\n     RETURNING tenant_id, day_of_week, hour, timezone, enabled`;

test('upsertMarketingSchedule: emits the exact CLI COALESCE-preserve SQL text', async () => {
  const { calls, queryable } = recordingQueryable(() => ({
    rowCount: 1,
    rows: [{ tenant_id: 15, day_of_week: 1, hour: 9, timezone: 'America/New_York', enabled: true }],
  }));

  await upsertMarketingSchedule(queryable, {
    tenantId: 15,
    dayOfWeek: 1,
    hour: 9,
    timezone: 'America/New_York',
    timezoneProvided: true,
    enabled: true,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].sql, CLI_UPSERT_SQL);
});

test('upsertMarketingSchedule: full explicit write sends every param verbatim', async () => {
  const { calls, queryable } = recordingQueryable(() => ({ rowCount: 1, rows: [{}] }));

  await upsertMarketingSchedule(queryable, {
    tenantId: 15,
    dayOfWeek: 5,
    hour: 18,
    timezone: 'America/Los_Angeles',
    timezoneProvided: true,
    enabled: false,
  });

  assert.deepEqual(calls[0].params, [15, 5, 18, 'America/Los_Angeles', false, true]);
});

test('upsertMarketingSchedule: omitted day/hour/timezone/enabled map to NULL params (COALESCE preserves on update)', async () => {
  const { calls, queryable } = recordingQueryable(() => ({ rowCount: 1, rows: [{}] }));

  await upsertMarketingSchedule(queryable, {
    tenantId: 15,
    dayOfWeek: null,
    hour: null,
    timezone: null,
    timezoneProvided: false,
    enabled: null,
  });

  assert.deepEqual(calls[0].params, [15, null, null, null, null, false]);
});

test('upsertMarketingSchedule: timezoneProvided:true + timezone:null explicitly CLEARS the stored timezone (not preserved)', async () => {
  const { calls, queryable } = recordingQueryable(() => ({ rowCount: 1, rows: [{}] }));

  await upsertMarketingSchedule(queryable, {
    tenantId: 15,
    dayOfWeek: null,
    hour: null,
    timezone: null,
    timezoneProvided: true,
    enabled: null,
  });

  // $4 (timezone) is null AND $6 (timezoneProvided) is true → the CASE WHEN
  // branch writes $4 (null) instead of preserving marketing_schedule.timezone.
  assert.deepEqual(calls[0].params, [15, null, null, null, null, true]);
});

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

test('getMarketingScheduleForTenant: scoped SELECT by tenant_id, returns null on zero rows', async () => {
  const { calls, queryable } = recordingQueryable(() => ({ rowCount: 0, rows: [] }));
  const row = await getMarketingScheduleForTenant(queryable, 99);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /WHERE tenant_id = \$1/);
  assert.deepEqual(calls[0].params, [99]);
  assert.equal(row, null);
});

test('getMarketingScheduleForTenant: returns the row when present', async () => {
  const fixture = { tenant_id: 99, cadence: 'weekly', day_of_week: 2, hour: 10, timezone: 'UTC', enabled: true };
  const { queryable } = recordingQueryable(() => ({ rowCount: 1, rows: [fixture] }));
  const row = await getMarketingScheduleForTenant(queryable, 99);
  assert.deepEqual(row, fixture);
});

test('listMarketingSchedules: returns all rows ordered by tenant_id (no WHERE clause)', async () => {
  const fixtures = [
    { tenant_id: 1, day_of_week: 1, hour: 9, timezone: null, enabled: true },
    { tenant_id: 2, day_of_week: 3, hour: 14, timezone: 'UTC', enabled: false },
  ];
  const { calls, queryable } = recordingQueryable(() => ({ rowCount: 2, rows: fixtures }));
  const rows = await listMarketingSchedules(queryable);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /ORDER BY tenant_id/);
  assert.doesNotMatch(calls[0].sql, /WHERE/);
  assert.deepEqual(rows, fixtures);
});

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

test('parseScheduleDay: accepts 0-6 and day names/abbreviations, rejects everything else', () => {
  assert.equal(parseScheduleDay('0'), 0);
  assert.equal(parseScheduleDay('6'), 6);
  assert.equal(parseScheduleDay('mon'), 1);
  assert.equal(parseScheduleDay('Monday'), 1);
  assert.equal(parseScheduleDay('  fri '), 5);
  assert.equal(parseScheduleDay('7'), null);
  assert.equal(parseScheduleDay('funday'), null);
  assert.equal(parseScheduleDay(undefined), null);
  assert.equal(parseScheduleDay(true), null);
});

test('parseScheduleHour: accepts 0-23, rejects out-of-range and non-numeric', () => {
  assert.equal(parseScheduleHour('0'), 0);
  assert.equal(parseScheduleHour('23'), 23);
  assert.equal(parseScheduleHour('9'), 9);
  assert.equal(parseScheduleHour('24'), null);
  assert.equal(parseScheduleHour('-1'), null);
  assert.equal(parseScheduleHour('nine'), null);
  assert.equal(parseScheduleHour(undefined), null);
});

test('isValidScheduleTimezone: accepts IANA names, rejects garbage', () => {
  assert.equal(isValidScheduleTimezone('America/New_York'), true);
  assert.equal(isValidScheduleTimezone('UTC'), true);
  assert.equal(isValidScheduleTimezone('Not/AZone'), false);
});

test('parseScheduleEnabled: accepts common truthy/falsy strings and booleans; rejects garbage', () => {
  assert.equal(parseScheduleEnabled('true'), true);
  assert.equal(parseScheduleEnabled('YES'), true);
  assert.equal(parseScheduleEnabled('1'), true);
  assert.equal(parseScheduleEnabled('on'), true);
  assert.equal(parseScheduleEnabled('false'), false);
  assert.equal(parseScheduleEnabled('no'), false);
  assert.equal(parseScheduleEnabled('0'), false);
  assert.equal(parseScheduleEnabled('off'), false);
  assert.equal(parseScheduleEnabled(true), true);
  assert.equal(parseScheduleEnabled(false), false);
  assert.equal(parseScheduleEnabled(undefined), null);
  assert.equal(parseScheduleEnabled('maybe'), null);
});
