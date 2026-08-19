import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ENGAGEMENT_TREND_FLAT_THRESHOLD_PCT,
  WEEKLY_ENGAGEMENT_METRICS_SQL,
  WEEKLY_ENGAGEMENT_UPSERT_SQL,
  materializeWeeklyEngagementTrends,
  runWeeklyEngagementIfDue,
  summarizeEngagementRows,
  type WeeklyEngagementScheduleState,
  type WeeklyEngagementQueryable,
  type EngagementMetricRow,
} from '../backend/insights/weekly-engagement-job';
import { runWorkerCycle } from '../scripts/automations/insights-sync-worker';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function metric(
  tenantId: number,
  period: 'current' | 'previous',
  engagement: number,
): EngagementMetricRow {
  return {
    tenant_id: tenantId,
    period,
    likes: engagement,
    comments_count: 0,
    shares: 0,
    saves: 0,
  };
}

test('classifies upward, downward, and flat per-tenant average engagement trends', () => {
  const summaries = summarizeEngagementRows([
    metric(1, 'previous', 10),
    metric(1, 'previous', 20),
    metric(1, 'current', 30),
    metric(1, 'current', 40),
    metric(2, 'previous', 30),
    metric(2, 'current', 10),
    metric(3, 'previous', 100),
    metric(3, 'current', 100 + ENGAGEMENT_TREND_FLAT_THRESHOLD_PCT - 1),
  ]);

  assert.deepEqual(
    summaries.map(({ tenantId, direction }) => ({ tenantId, direction })),
    [
      { tenantId: 1, direction: 'upward' },
      { tenantId: 2, direction: 'downward' },
      { tenantId: 3, direction: 'flat' },
    ],
  );
  assert.deepEqual(summaries[0], {
    tenantId: 1,
    currentPostCount: 2,
    previousPostCount: 2,
    currentAverage: 35,
    previousAverage: 15,
    changePercent: 133.3,
    direction: 'upward',
  });
});

test('returns no tenant summaries when no metric rows are available', () => {
  assert.deepEqual(summarizeEngagementRows([]), []);
});

test('reports insufficient data when only one comparison period has metrics', () => {
  assert.deepEqual(summarizeEngagementRows([metric(1, 'current', 12)])[0], {
    tenantId: 1,
    currentPostCount: 1,
    previousPostCount: 0,
    currentAverage: 12,
    previousAverage: null,
    changePercent: null,
    direction: 'insufficient_data',
  });
});

test('the metrics query uses one cumulative snapshot per post as of each period end', () => {
  assert.match(WEEKLY_ENGAGEMENT_METRICS_SQL, /ORDER BY d\.date DESC\s+LIMIT 1/);
  assert.match(WEEKLY_ENGAGEMENT_METRICS_SQL, /d\.date < CASE/);
  assert.match(WEEKLY_ENGAGEMENT_METRICS_SQL, /AT TIME ZONE 'UTC'/);
  assert.doesNotMatch(WEEKLY_ENGAGEMENT_METRICS_SQL, /SUM\s*\(/i);
});

test('the bounded metrics read includes every tenant with comparison-window data', () => {
  assert.match(WEEKLY_ENGAGEMENT_METRICS_SQL, /insights_post_metrics_daily/);
  assert.match(WEEKLY_ENGAGEMENT_METRICS_SQL, /published_at/);
  assert.doesNotMatch(WEEKLY_ENGAGEMENT_METRICS_SQL, /p\.tenant_id\s*=\s*\$1/);
  assert.doesNotMatch(WEEKLY_ENGAGEMENT_METRICS_SQL, /insights_accounts/);
});

test('rerunning the same completed week upserts one stable row per tenant', async () => {
  const stored = new Map<string, unknown[]>();
  let metricsReads = 0;
  let upsertAttempts = 0;
  const metricRows = [
    metric(1, 'previous', 10), metric(1, 'current', 20),
    metric(2, 'previous', 20), metric(2, 'current', 10),
    metric(3, 'previous', 10), metric(3, 'current', 10),
  ];
  const db: WeeklyEngagementQueryable = {
    async query(sql, params = []) {
      if (sql === WEEKLY_ENGAGEMENT_UPSERT_SQL) {
        upsertAttempts += 1;
        stored.set(`${params[0]}:${params[1]}`, params);
        return { rows: [] };
      }
      metricsReads += 1;
      return { rows: metricRows };
    },
  };

  const now = new Date('2026-08-12T12:00:00Z');
  const first = await materializeWeeklyEngagementTrends(db, now);
  const second = await materializeWeeklyEngagementTrends(db, now);

  assert.deepEqual(first, { weekIso: '2026-W32', tenantsScanned: 3, summariesWritten: 3 });
  assert.deepEqual(second, first);
  assert.equal(upsertAttempts, 6, 'a retry converges through the same UPSERT keys');
  assert.equal(metricsReads, 2, 'each run reads the bounded two-week metric set once');
  assert.equal(stored.size, 3, 'no duplicate tenant/week rows are created');
  assert.match(WEEKLY_ENGAGEMENT_UPSERT_SQL, /ON CONFLICT \(tenant_id, week_start\)/);
});

test('the scheduler runs once per completed week and leaves retries to a failed run', async () => {
  let writes = 0;
  const db: WeeklyEngagementQueryable = {
    async query(sql, params = []) {
      if (sql === WEEKLY_ENGAGEMENT_UPSERT_SQL) {
        writes += 1;
        return { rows: [] };
      }
      return { rows: [metric(7, 'previous', 10), metric(7, 'current', 20)] };
    },
  };
  const state: WeeklyEngagementScheduleState = { completedWeekIso: null };

  const first = await runWeeklyEngagementIfDue(db, state, new Date('2026-08-12T12:00:00Z'));
  const second = await runWeeklyEngagementIfDue(db, state, new Date('2026-08-13T12:00:00Z'));

  assert.equal(first?.weekIso, '2026-W32');
  assert.equal(second, null, 'another 30-minute sync tick in the same week is a no-op');
  assert.equal(writes, 1);
  assert.equal(state.completedWeekIso, '2026-W32');
});

test('the scheduler retries a completed week after a materialization failure', async () => {
  let failUpsert = true;
  const db: WeeklyEngagementQueryable = {
    async query(sql) {
      if (sql === WEEKLY_ENGAGEMENT_UPSERT_SQL) {
        if (failUpsert) throw new Error('database unavailable');
        return { rows: [] };
      }
      return { rows: [metric(7, 'previous', 10), metric(7, 'current', 20)] };
    },
  };
  const state: WeeklyEngagementScheduleState = { completedWeekIso: null };
  const now = new Date('2026-08-12T12:00:00Z');

  await assert.rejects(runWeeklyEngagementIfDue(db, state, now), /database unavailable/);
  assert.equal(state.completedWeekIso, null);

  failUpsert = false;
  const retry = await runWeeklyEngagementIfDue(db, state, now);
  assert.equal(retry?.summariesWritten, 1);
  assert.equal(state.completedWeekIso, '2026-W32');
});

test('the tenant/week materialization key is installed by migration and startup init', () => {
  const migration = readFileSync(
    path.join(PROJECT_ROOT, 'migrations', '20260819203008_weekly_engagement_trends.sql'),
    'utf8',
  );
  const initDb = readFileSync(path.join(PROJECT_ROOT, 'scripts', 'init-db.js'), 'utf8');

  for (const source of [migration, initDb]) {
    assert.match(source, /CREATE TABLE IF NOT EXISTS insights_engagement_trends_weekly/);
    assert.match(source, /PRIMARY KEY \(tenant_id, week_start\)/);
    assert.match(source, /direction IN \('upward', 'downward', 'flat', 'insufficient_data'\)/);
  }
});

test('the insights worker refreshes metrics before materializing the weekly trend', async () => {
  const order: string[] = [];
  const db: WeeklyEngagementQueryable = {
    async query(sql) {
      order.push(sql === WEEKLY_ENGAGEMENT_METRICS_SQL ? 'metrics-read' : 'upsert');
      if (sql === WEEKLY_ENGAGEMENT_UPSERT_SQL) return { rows: [] };
      return { rows: [metric(1, 'previous', 10), metric(1, 'current', 20)] };
    },
  };

  const report = await runWorkerCycle(
    db,
    async () => { order.push('sync'); },
    { completedWeekIso: null },
    new Date('2026-08-12T12:00:00Z'),
  );

  assert.equal(report?.summariesWritten, 1);
  assert.deepEqual(order.slice(0, 2), ['sync', 'metrics-read']);
});

test('the insights worker does not start another cycle while a sync is running', async () => {
  let releaseSync!: () => void;
  const syncBlocked = new Promise<void>((resolve) => { releaseSync = resolve; });
  let syncCalls = 0;
  const db: WeeklyEngagementQueryable = {
    async query(sql) {
      if (sql === WEEKLY_ENGAGEMENT_UPSERT_SQL) return { rows: [] };
      return { rows: [metric(1, 'current', 10)] };
    },
  };
  const state: WeeklyEngagementScheduleState = { completedWeekIso: null };
  const first = runWorkerCycle(db, async () => {
    syncCalls += 1;
    await syncBlocked;
  }, state, new Date('2026-08-12T12:00:00Z'));
  await Promise.resolve();

  const overlapping = await runWorkerCycle(
    db,
    async () => { syncCalls += 1; },
    state,
    new Date('2026-08-12T12:30:00Z'),
  );

  assert.equal(overlapping, null);
  assert.equal(syncCalls, 1);
  releaseSync();
  await first;
});
