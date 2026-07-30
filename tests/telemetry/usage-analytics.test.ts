/**
 * AA-166 — the customer-facing usage reporting queries.
 *
 * What these pin, in order of what would hurt most if it broke:
 *   - with no rollup watermark the payload is UNMETERED with empty series, not
 *     a zeroed dashboard (the same honesty contract as the AA-164 quota card);
 *   - unreported tokens stay NULL and `tokensReported` keys off the
 *     ai_events_with_usage denominator, never off "tokens > 0" — otherwise a
 *     reported spend of 0 and an unreported spend look identical;
 *   - the window arithmetic: whole UTC buckets, Monday-anchored weeks (matching
 *     Postgres date_trunc), month boundaries across a year edge;
 *   - every query is tenant-scoped, so the `0` "not scoped" sentinel can never
 *     reach a customer-facing payload;
 *   - the reads are sequential (guardrail #1), not a Promise.all fan-out.
 *
 * Fully in-memory (injected db) — no live Postgres.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_TABLE_LIMIT,
  SELECT_USAGE_ENGINE_SPLIT_SQL,
  SELECT_USAGE_SERIES_SQL,
  SELECT_USAGE_SLOWEST_TASKS_SQL,
  SELECT_USAGE_TOP_USERS_SQL,
  isUsageGranularity,
  loadUsageAnalytics,
  resolveUsageWindow,
  type Queryable,
} from '@/backend/telemetry/usage-analytics';

type Call = { sql: string; params: unknown[] };

function recordingDb(
  rowsFor: (sql: string) => unknown[],
  calls: Call[],
  options: { metered?: boolean } = {},
): Queryable {
  return {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('usage_rollup_state')) {
        return {
          rows: options.metered === false ? [] : [{ rolled_through: '2026-07-30T09:00:00Z' }],
          rowCount: 1,
        };
      }
      const rows = rowsFor(sql);
      return { rows, rowCount: rows.length };
    },
  };
}

const NOW = () => new Date('2026-07-30T14:23:00Z'); // a Thursday

// ---------------------------------------------------------------------------
// Window arithmetic
// ---------------------------------------------------------------------------

test('daily window is 30 whole UTC days ending after today', () => {
  const { rangeStart, rangeEnd } = resolveUsageWindow('daily', NOW());
  assert.equal(rangeEnd.toISOString(), '2026-07-31T00:00:00.000Z');
  assert.equal(rangeStart.toISOString(), '2026-07-01T00:00:00.000Z');
});

test('weekly window is Monday-anchored, matching date_trunc(week)', () => {
  const { rangeStart, rangeEnd } = resolveUsageWindow('weekly', NOW());
  // 2026-07-30 is a Thursday, so the current week opened Monday 2026-07-27 and
  // the exclusive end is the following Monday.
  assert.equal(rangeEnd.getUTCDay(), 1);
  assert.equal(rangeStart.getUTCDay(), 1);
  assert.equal(rangeEnd.toISOString(), '2026-08-03T00:00:00.000Z');
  assert.equal((rangeEnd.getTime() - rangeStart.getTime()) / 86_400_000, 84); // 12 weeks
});

test('weekly window anchors correctly when today IS Monday or Sunday', () => {
  const monday = resolveUsageWindow('weekly', new Date('2026-07-27T00:30:00Z'));
  assert.equal(monday.rangeEnd.toISOString(), '2026-08-03T00:00:00.000Z');

  const sunday = resolveUsageWindow('weekly', new Date('2026-07-26T23:30:00Z'));
  // Sunday still belongs to the week that opened Monday 2026-07-20.
  assert.equal(sunday.rangeEnd.toISOString(), '2026-07-27T00:00:00.000Z');
});

test('monthly window covers 12 whole months across a year boundary', () => {
  const { rangeStart, rangeEnd } = resolveUsageWindow('monthly', new Date('2026-01-15T12:00:00Z'));
  assert.equal(rangeEnd.toISOString(), '2026-02-01T00:00:00.000Z');
  assert.equal(rangeStart.toISOString(), '2025-02-01T00:00:00.000Z');
});

test('isUsageGranularity rejects anything not in the vocabulary', () => {
  assert.equal(isUsageGranularity('daily'), true);
  assert.equal(isUsageGranularity('weekly'), true);
  assert.equal(isUsageGranularity('monthly'), true);
  assert.equal(isUsageGranularity('hourly'), false);
  assert.equal(isUsageGranularity(''), false);
  assert.equal(isUsageGranularity(undefined), false);
});

// ---------------------------------------------------------------------------
// Metering honesty
// ---------------------------------------------------------------------------

test('no rollup watermark reports unmetered with empty series, never zeros', async () => {
  const calls: Call[] = [];
  const db = recordingDb(() => [], calls, { metered: false });

  const result = await loadUsageAnalytics(7, { db, now: NOW });

  assert.equal(result.metered, false);
  assert.deepEqual(result.series, []);
  assert.deepEqual(result.topUsers, []);
  assert.deepEqual(result.slowestTasks, []);
  assert.deepEqual(result.engineSplit, []);
  assert.equal(result.totalTokens, null);
  assert.equal(result.tokensReported, false);
  // The window is still reported so the UI can say what it looked at.
  assert.equal(result.rangeStart, '2026-07-01');
  assert.equal(result.rangeEnd, '2026-07-31');
  // And crucially: it stopped after the watermark — no aggregate reads at all.
  assert.equal(calls.length, 1);
});

test('unreported tokens stay NULL and tokensReported keys off the denominator', async () => {
  const calls: Call[] = [];
  const db = recordingDb(
    (sql) =>
      sql === SELECT_USAGE_SERIES_SQL
        ? [
            {
              bucket_start: '2026-07-29',
              tasks: '12',
              ai_tasks: '4',
              ai_tasks_with_usage: '0',
              total_tokens: null,
              total_duration_ms: '5000',
            },
          ]
        : [],
    calls,
  );

  const result = await loadUsageAnalytics(7, { db, now: NOW });

  assert.equal(result.metered, true);
  assert.equal(result.totalTasks, 12);
  assert.equal(result.totalAiTasks, 4);
  // NULL means "not reported", never "free" — no 0 is synthesized anywhere.
  assert.equal(result.series[0].totalTokens, null);
  assert.equal(result.totalTokens, null);
  assert.equal(result.tokensReported, false);
});

test('a genuinely reported spend of zero still counts as reported', async () => {
  const calls: Call[] = [];
  const db = recordingDb(
    (sql) =>
      sql === SELECT_USAGE_SERIES_SQL
        ? [
            {
              bucket_start: '2026-07-29',
              tasks: '3',
              ai_tasks: '3',
              ai_tasks_with_usage: '3',
              total_tokens: '0',
              total_duration_ms: '10',
            },
          ]
        : [],
    calls,
  );

  const result = await loadUsageAnalytics(7, { db, now: NOW });

  // tokensReported must NOT be `totalTokens > 0` — that would report a real,
  // measured zero as "we have no idea", which is the opposite claim.
  assert.equal(result.totalTokens, 0);
  assert.equal(result.tokensReported, true);
});

// ---------------------------------------------------------------------------
// Row shaping
// ---------------------------------------------------------------------------

test('the userless sentinel row is flagged as system, never named', async () => {
  const calls: Call[] = [];
  const db = recordingDb(
    (sql) =>
      sql === SELECT_USAGE_TOP_USERS_SQL
        ? [
            {
              user_id: 0,
              full_name: null,
              email: null,
              tasks: '80',
              ai_tasks: '40',
              ai_tasks_with_usage: '0',
              total_tokens: null,
              total_duration_ms: '900',
            },
            {
              user_id: 3,
              full_name: '  Dana Ops  ',
              email: 'dana@example.com',
              tasks: '12',
              ai_tasks: '9',
              ai_tasks_with_usage: '0',
              total_tokens: null,
              total_duration_ms: '400',
            },
            {
              // Join found no membership — the name must not be invented.
              user_id: 99,
              full_name: null,
              email: null,
              tasks: '2',
              ai_tasks: '0',
              ai_tasks_with_usage: '0',
              total_tokens: null,
              total_duration_ms: '5',
            },
          ]
        : [],
    calls,
  );

  const { topUsers } = await loadUsageAnalytics(7, { db, now: NOW });

  assert.equal(topUsers[0].userId, 0);
  assert.equal(topUsers[0].isSystem, true);
  assert.equal(topUsers[0].name, null);
  assert.equal(topUsers[1].isSystem, false);
  assert.equal(topUsers[1].name, 'Dana Ops');
  assert.equal(topUsers[2].name, null);
});

test('slowest tasks report the mean per execution and never divide by zero', async () => {
  const calls: Call[] = [];
  const db = recordingDb(
    (sql) =>
      sql === SELECT_USAGE_SLOWEST_TASKS_SQL
        ? [
            { task_key: 'marketing.stage.production', executions: '4', total_duration_ms: '48000' },
            { task_key: 'creative.apply_brand_frame', executions: '0', total_duration_ms: '0' },
          ]
        : [],
    calls,
  );

  const { slowestTasks } = await loadUsageAnalytics(7, { db, now: NOW });

  assert.equal(slowestTasks[0].avgDurationMs, 12_000);
  assert.equal(slowestTasks[0].totalDurationMs, 48_000);
  // Guarded even though HAVING excludes it — Infinity/NaN must never reach a
  // customer's dashboard.
  assert.equal(slowestTasks[1].avgDurationMs, 0);
});

test('the engine split passes through the raw engine vocabulary', async () => {
  const calls: Call[] = [];
  const db = recordingDb(
    (sql) =>
      sql === SELECT_USAGE_ENGINE_SPLIT_SQL
        ? [
            { execution_engine: 'AI_LLM', tasks: '30', total_tokens: null, total_duration_ms: '600' },
            {
              execution_engine: 'DETERMINISTIC_RULE',
              tasks: '12',
              total_tokens: '0',
              total_duration_ms: '90',
            },
          ]
        : [],
    calls,
  );

  const { engineSplit } = await loadUsageAnalytics(7, { db, now: NOW });

  assert.deepEqual(
    engineSplit.map((row) => row.engine),
    ['AI_LLM', 'DETERMINISTIC_RULE'],
  );
  assert.equal(engineSplit[0].totalTokens, null);
  assert.equal(engineSplit[1].totalTokens, 0);
});

// ---------------------------------------------------------------------------
// Scoping + access shape
// ---------------------------------------------------------------------------

test('every aggregate query is scoped to the company and the window', async () => {
  const calls: Call[] = [];
  const db = recordingDb(() => [], calls);

  await loadUsageAnalytics(42, { db, now: NOW, granularity: 'weekly' });

  const aggregates = calls.filter((call) => !call.sql.includes('usage_rollup_state'));
  assert.equal(aggregates.length, 4);
  for (const call of aggregates) {
    assert.equal(call.params[0], 42, `missing tenant scope: ${call.sql.slice(0, 40)}`);
    assert.ok(call.params[1] instanceof Date);
    assert.ok(call.params[2] instanceof Date);
    // The AA-161 `0` sentinel (system sweeps, cron, callbacks) cannot match a
    // positive company id, so it is excluded by construction.
    assert.notEqual(call.params[0], 0);
    assert.match(call.sql, /tenant_id = \$1/);
  }
});

test('all four grains read usage_rollup_daily so the chart and tables agree', () => {
  for (const sql of [
    SELECT_USAGE_SERIES_SQL,
    SELECT_USAGE_TOP_USERS_SQL,
    SELECT_USAGE_SLOWEST_TASKS_SQL,
    SELECT_USAGE_ENGINE_SPLIT_SQL,
  ]) {
    assert.match(sql, /FROM usage_rollup_daily/);
    // Never the raw log: it is purged at 90 days and would disagree with the
    // aggregates the plan gate enforces on.
    assert.doesNotMatch(sql, /FROM task_execution_log/);
  }
});

test('the series grain is the requested one', async () => {
  for (const [granularity, unit] of [
    ['daily', 'day'],
    ['weekly', 'week'],
    ['monthly', 'month'],
  ] as const) {
    const calls: Call[] = [];
    const db = recordingDb(() => [], calls);
    await loadUsageAnalytics(7, { db, now: NOW, granularity });
    const series = calls.find((call) => call.sql === SELECT_USAGE_SERIES_SQL);
    assert.equal(series?.params[3], unit);
  }
});

test('top users are ordered by token spend with tasks as the tie-break', () => {
  // Ordering by tokens first is what makes this the AC's "top users by token
  // spend" the moment usage is reported; NULLS LAST makes it degrade to task
  // volume today rather than to an arbitrary order.
  assert.match(
    SELECT_USAGE_TOP_USERS_SQL,
    /ORDER BY sum\(r\.total_tokens\) DESC NULLS LAST, sum\(r\.events\) DESC/,
  );
});

test('the users join is guarded by membership in the requesting company', () => {
  // A stale user_id must never surface another workspace's name or email.
  assert.match(SELECT_USAGE_TOP_USERS_SQL, /u\.organization_id = \$1/);
  assert.match(SELECT_USAGE_TOP_USERS_SQL, /m\.organization_id = \$1/);
  assert.match(SELECT_USAGE_TOP_USERS_SQL, /m\.status = 'active'/);
});

test('table queries are bounded by an explicit row limit', async () => {
  const calls: Call[] = [];
  const db = recordingDb(() => [], calls);

  await loadUsageAnalytics(7, { db, now: NOW });

  for (const sql of [SELECT_USAGE_TOP_USERS_SQL, SELECT_USAGE_SLOWEST_TASKS_SQL]) {
    assert.match(sql, /LIMIT \$4/);
  }
  const users = calls.find((call) => call.sql === SELECT_USAGE_TOP_USERS_SQL);
  assert.equal(users?.params[3], DEFAULT_TABLE_LIMIT);
});

test('a query failure propagates instead of returning an empty breakdown', async () => {
  const db: Queryable = {
    query: async (sql: string) => {
      if (sql.includes('usage_rollup_state')) {
        return { rows: [{ rolled_through: '2026-07-30T09:00:00Z' }], rowCount: 1 };
      }
      throw new Error('connection terminated');
    },
  };

  // A confidently empty report reads as "nobody used anything", which is a
  // wrong answer rather than a missing one. The route turns this into a 503.
  await assert.rejects(() => loadUsageAnalytics(7, { db, now: NOW }), /connection terminated/);
});
