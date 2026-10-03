import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import pg from 'pg';

import { requireDbEnvOrSkip } from '../helpers/requires-infra';

const dashboardPath = 'ops/grafana/dashboards/aries/daily-estimated-cost.json';
const readDashboard = () => JSON.parse(fs.readFileSync(dashboardPath, 'utf8'));

test('daily cost dashboard labels estimates and exposes the $100/day reference', () => {
  assert.ok(fs.existsSync(dashboardPath), 'the importable daily cost dashboard must exist');
  const dashboard = readDashboard();
  assert.equal(dashboard.timezone, 'utc');
  const panel = dashboard.panels[0];
  assert.equal(panel.type, 'table');
  assert.match(panel.title, /estimated.*\$100\/day/i);
  assert.match(panel.description, /not.*billing|not.*invoice/i);
  assert.equal(panel.datasource.type, 'grafana-postgresql-datasource');
  assert.equal(panel.datasource.uid, '${DS_ARIES_POSTGRES}');
  assert.equal(dashboard.__inputs[0].name, 'DS_ARIES_POSTGRES');
  const cost = panel.fieldConfig.overrides.find((field: { matcher: { options: string } }) =>
    field.matcher.options === 'estimated_cost_usd');
  assert.ok(cost);
  assert.equal(cost.properties.find((p: { id: string }) => p.id === 'unit').value, 'currencyUSD');
  assert.equal(cost.properties.find((p: { id: string }) => p.id === 'noValue').value, 'Not reported');
  assert.deepEqual(cost.properties.find((p: { id: string }) => p.id === 'thresholds').value,
    { mode: 'absolute', steps: [{ color: 'blue', value: null }, { color: 'red', value: 100 }] });
});

test('dashboard SQL sums seeded AI costs by tenant and UTC day without hiding missing costs', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;
  const client = new pg.Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL TimeZone = 'Asia/Kathmandu'");
    // Run the real table definition in a session-local table; never seed app data.
    const migration = fs.readFileSync('migrations/20260722000000_task_execution_log.sql', 'utf8');
    const ddl = migration.match(/CREATE TABLE IF NOT EXISTS task_execution_log \([\s\S]*?\n\);/)?.[0];
    assert.ok(ddl);
    await client.query(ddl.replace('CREATE TABLE IF NOT EXISTS', 'CREATE TEMP TABLE'));
    await client.query(`INSERT INTO task_execution_log
      (tenant_id, task_key, execution_engine, status, cost_cents, total_tokens, started_at)
      VALUES
        (15, 'research', 'AI_LLM', 'succeeded', 9999.125, NULL, '2026-09-08T00:00:00Z'),
        (15, 'production', 'AI_LLM', 'failed', 0.875, NULL, '2026-09-08T22:00:00Z'),
        (15, 'production', 'AI_LLM', 'retry', 25, NULL, '2026-09-08T23:59:59Z'),
        (15, 'production', 'AI_LLM', 'succeeded', NULL, 100, '2026-09-08T12:00:00Z'),
        (15, 'production', 'AI_LLM', 'succeeded', 50, NULL, '2026-09-09T00:00:00Z'),
        (16, 'production', 'AI_LLM', 'succeeded', NULL, 200, '2026-09-08T12:00:00Z'),
        (16, 'sweep', 'DETERMINISTIC_RULE', 'succeeded', 0, 0, '2026-09-08T12:00:00Z'),
        (16, 'render', 'LOCAL_EDGE', 'succeeded', 0, 0, '2026-09-08T12:00:00Z'),
        (16, 'production', 'AI_LLM', 'succeeded', 0, 0, '2026-09-09T00:00:00Z'),
        (17, 'sweep', 'DETERMINISTIC_RULE', 'succeeded', 0, 0, '2026-09-08T12:00:00Z'),
        (NULL, 'research', 'AI_LLM', 'failed', 900, NULL, '2026-09-08T12:00:00Z'),
        (15, 'before', 'AI_LLM', 'succeeded', 900, NULL, '2026-09-07T23:59:59Z'),
        (15, 'after', 'AI_LLM', 'succeeded', 900, NULL, '2026-09-09T12:00:00Z')`);
    // Only substitute Grafana's two time macros; execute the shipped query verbatim.
    const sql: string = readDashboard().panels[0].targets[0].rawSql
      .replaceAll('$__timeFrom()', '$1')
      .replaceAll('$__timeTo()', '$2');
    const params = ['2026-09-08T16:00:00Z', '2026-09-09T12:00:00Z'];
    const result = await client.query(sql, params);
    assert.deepEqual(result.rows.map((row) => ({
      day: row.time.toISOString(),
      tenant: row.tenant_id,
      cost: row.estimated_cost_usd === null ? null : Number(row.estimated_cost_usd),
      tasks: Number(row.ai_tasks),
      missing: Number(row.tasks_without_cost),
      reference: Number(row.daily_reference_usd),
    })), [
      { day: '2026-09-08T00:00:00.000Z', tenant: 15, cost: 100.25, tasks: 4, missing: 1, reference: 100 },
      { day: '2026-09-08T00:00:00.000Z', tenant: 16, cost: null, tasks: 1, missing: 1, reference: 100 },
      { day: '2026-09-09T00:00:00.000Z', tenant: 15, cost: 0.5, tasks: 1, missing: 0, reference: 100 },
      { day: '2026-09-09T00:00:00.000Z', tenant: 16, cost: 0, tasks: 1, missing: 0, reference: 100 },
    ]);
    assert.deepEqual((await client.query(sql, params)).rows, result.rows, 're-reading never accumulates');
    await client.query('TRUNCATE task_execution_log');
    assert.deepEqual((await client.query(sql, params)).rows, [], 'no telemetry is not a zero-cost day');
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});
