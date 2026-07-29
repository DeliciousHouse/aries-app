/**
 * AA-162 — the daily_company_usage materialized view and its refresh hook.
 *
 * Covers the contracts a customer dashboard / chargeback run depends on:
 *   - the refresh is CONCURRENT, so rebuilding it never blocks the readers it
 *     exists to serve (and it requires the unique index, which the migration
 *     therefore must create — proven live in the requires-infra test);
 *   - it runs AFTER the rollup rows are durable, and a refresh failure degrades
 *     to a stale view rather than failing the pass or rewinding the watermark;
 *   - a pass that changed no daily bucket does not rebuild the view to the same
 *     bytes;
 *   - the projected measures are exactly the four the AC asks for, plus the
 *     denominators that keep a $0 COGS from being read as "no spend".
 *
 * Fully in-memory: the db handle is injected, no Postgres is touched.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  REFRESH_DAILY_COMPANY_USAGE_SQL,
  runUsageRollup,
} from '@/backend/telemetry/usage-rollups';

type Call = { sql: string; params: unknown[] };

function fakeDb(responder?: (sql: string) => { rows?: unknown[]; rowCount?: number } | undefined) {
  const calls: Call[] = [];
  return {
    calls,
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      const res = responder?.(sql);
      return { rows: res?.rows ?? [], rowCount: res?.rowCount ?? 0 };
    },
  };
}

const at = (iso: string) => () => new Date(iso);

/** Watermark present + `dailyRows` daily buckets written by the pass. */
function rollingDb(dailyRows: number, extra?: (sql: string) => { rows?: unknown[]; rowCount?: number } | undefined) {
  return fakeDb((sql) => {
    if (sql.includes('FROM usage_rollup_state')) {
      return { rows: [{ rolled_through: '2026-07-27T09:00:00.000Z' }] };
    }
    if (sql.includes('INSERT INTO usage_rollup_daily')) return { rowCount: dailyRows };
    return extra?.(sql);
  });
}

const NOW = at('2026-07-27T10:37:00.000Z');

test('the refresh is CONCURRENT so it never blocks the dashboards it serves', () => {
  assert.equal(
    REFRESH_DAILY_COMPANY_USAGE_SQL,
    'REFRESH MATERIALIZED VIEW CONCURRENTLY daily_company_usage',
  );
});

test('a pass with new daily rows refreshes the view', async () => {
  const db = rollingDb(4);

  const report = await runUsageRollup(db, { now: NOW });

  assert.equal(report.dailyCompanyUsageRefreshed, true);
  assert.equal(db.calls.filter((c) => c.sql.includes('REFRESH MATERIALIZED VIEW')).length, 1);
});

test('a pass that changed no daily bucket does not rebuild the view', async () => {
  const db = rollingDb(0);

  const report = await runUsageRollup(db, { now: NOW });

  assert.equal(report.dailyCompanyUsageRefreshed, false);
  assert.deepEqual(
    db.calls.filter((c) => c.sql.includes('REFRESH MATERIALIZED VIEW')),
    [],
  );
});

test('a failed refresh degrades to a stale view, never a failed pass', async () => {
  const db = rollingDb(4, (sql) => {
    if (sql.includes('REFRESH MATERIALIZED VIEW')) {
      throw new Error('cannot refresh materialized view concurrently');
    }
    return undefined;
  });

  const report = await runUsageRollup(db, { now: NOW });

  // The rollup tables are the source of truth and are already committed, so the
  // pass still succeeds and the watermark still advanced — only freshness is lost.
  assert.equal(report.dailyCompanyUsageRefreshed, false);
  assert.equal(report.rolledThrough, '2026-07-27T10:00:00.000Z');
  assert.equal(report.dailyRows, 4);
});

test('the view projects the AC measures plus the denominators that qualify them', () => {
  const sql = fs.readFileSync(
    path.join(process.cwd(), 'migrations', '20260728000000_daily_company_usage.sql'),
    'utf8',
  );

  // Grain and vocabulary: one row per company per UTC calendar day.
  assert.match(sql, /CREATE MATERIALIZED VIEW IF NOT EXISTS daily_company_usage/);
  assert.match(sql, /tenant_id AS company_id/);
  assert.match(sql, /\(bucket_start AT TIME ZONE 'UTC'\)::date AS usage_date/);

  // The four measures the AC names.
  assert.match(sql, /sum\(total_tokens\)::bigint\s+AS total_tokens/);
  assert.match(sql, /sum\(duration_ms_sum\)::bigint\s+AS total_duration_ms/);
  assert.match(sql, /sum\(cost_cents\)\s+AS total_cogs_cents/);
  assert.match(sql, /sum\(events\)::bigint\s+AS total_tasks/);

  // COGS is 0/NULL until Hermes reports usage, so the denominators are what stop
  // a chargeback from silently billing zero.
  assert.match(sql, /sum\(ai_events\)::bigint\s+AS ai_tasks/);
  assert.match(sql, /sum\(ai_events_with_usage\)::bigint\s+AS tasks_with_usage_reported/);
  // No price table: a cost is never synthesized from a rate card. Checked against
  // the statements only — the comments discuss the rule they document.
  const statements = sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  assert.ok(!/price|rate_card|per_token/i.test(statements));

  // Sourced from the aggregate, not the raw log — which is what makes the MV
  // cheap to refresh and lets it outlive the 90-day raw purge.
  assert.match(sql, /FROM usage_rollup_daily/);
  assert.ok(!sql.includes('FROM task_execution_log'));

  // REFRESH ... CONCURRENTLY refuses to run without a unique index.
  assert.match(
    sql,
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_company_usage_company_date\s+ON daily_company_usage \(company_id, usage_date\)/,
  );
});
