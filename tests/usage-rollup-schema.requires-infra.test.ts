import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';

import { requireDbEnvOrSkip } from './helpers/requires-infra';
import { runUsageRetentionSweep } from '../backend/telemetry/usage-retention';
import { runUsageRollup } from '../backend/telemetry/usage-rollups';

// Live-schema proof for the AA-161 usage time-series layer. The in-memory tests
// (tests/telemetry/usage-rollup.test.ts, usage-retention.test.ts) only ever see
// the SQL as a string — a renamed column, a bad date_trunc, or an UPSERT whose
// conflict target does not match the real PRIMARY KEY would pass them and then
// silently produce wrong billing numbers in prod. This file runs the real
// exported statements against the real schema inside a rolled-back transaction,
// proving:
//   1. an hour aggregates with the right measures, and AI rows that did not
//      report usage stay OUT of the token sum while still being counted
//      (total_tokens = the reported row only; ai_events_with_usage < ai_events);
//   2. NULL tenant/user land on the 0 sentinel, so the PK-based UPSERT matches;
//   3. re-rolling an overlapping window CONVERGES instead of double counting;
//   4. day/month buckets are UTC regardless of the session TimeZone;
//   5. the retention sweep never deletes a raw row inside the re-roll window,
//      and daily aggregates survive the purge of the rows they came from;
//   6. (AA-162) the daily_company_usage materialized view reconciles exactly
//      against the grain it projects and carries the denominators that qualify a
//      $0 COGS, and it has the UNIQUE index without which the sidecar's
//      REFRESH ... CONCURRENTLY would fail on every tick.

const TENANT = 990161; // scoped to this test; the whole transaction is rolled back

test('usage rollups + retention against real Postgres', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;

  const pool = new pg.Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    max: 1,
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // A hostile session TimeZone: the bucket boundaries must not move with it.
    await client.query("SET LOCAL TimeZone = 'Asia/Kathmandu'");

    await client.query(
      `INSERT INTO task_execution_log
         (tenant_id, user_id, task_key, execution_engine, status,
          prompt_tokens, completion_tokens, total_tokens, cost_cents, duration_ms, cpu_ms, started_at)
       VALUES
         ($1, 3, 'marketing.stage.production', 'AI_LLM', 'succeeded', 100, 20, 120, 4.5, 900, NULL, now() - interval '5 hours'),
         ($1, 3, 'marketing.stage.production', 'AI_LLM', 'retry', NULL, NULL, NULL, NULL, 300, NULL, now() - interval '5 hours'),
         (NULL, NULL, 'marketing.draft_expiry_sweep', 'DETERMINISTIC_RULE', 'succeeded', 0, 0, 0, 0, 50, 12, now() - interval '5 hours'),
         ($1, 3, 'marketing.stage.research', 'AI_LLM', 'succeeded', 10, 5, 15, 1.0, 100, NULL, now() - interval '100 days')`,
      [TENANT],
    );

    const db = {
      query: (sql: string, params?: unknown[]) => client.query(sql, params as never[]),
    };

    // Roll a window that covers the seeded hour. maxBackfillDays keeps the pass
    // bounded even on a database with real history in it.
    const first = await runUsageRollup(db, { maxHoursPerPass: 24, maxBackfillDays: 1 });
    assert.equal(first.skipped, false);

    const readAi = async () =>
      client.query(
        `SELECT events, retries, ai_events, ai_events_with_usage, total_tokens, cost_cents
           FROM usage_rollup_hourly
          WHERE tenant_id = $1 AND task_key = 'marketing.stage.production'`,
        [TENANT],
      );

    const ai = await readAi();
    assert.equal(ai.rows.length, 1, 'both AI attempts collapse into one bucket');
    assert.equal(Number(ai.rows[0].events), 2);
    assert.equal(Number(ai.rows[0].retries), 1, 'a retry is counted separately from settled work');
    assert.equal(Number(ai.rows[0].ai_events), 2);
    // The honesty pair: 2 AI runs, only 1 reported usage. A consumer that reads
    // total_tokens without this denominator would understate spend, not see zero.
    assert.equal(Number(ai.rows[0].ai_events_with_usage), 1);
    assert.equal(Number(ai.rows[0].total_tokens), 120);

    const sweepRow = await client.query(
      `SELECT tenant_id, user_id, total_tokens
         FROM usage_rollup_hourly
        WHERE task_key = 'marketing.draft_expiry_sweep' AND tenant_id = 0`,
    );
    assert.equal(sweepRow.rows.length, 1, 'a userless system row lands on the 0 sentinel');
    assert.equal(Number(sweepRow.rows[0].user_id), 0);
    assert.equal(Number(sweepRow.rows[0].total_tokens), 0, 'zero-cost engines are a hard 0');

    // Buckets are UTC midnight / month start even under a +05:45 session zone.
    const bounds = await client.query(
      `SELECT (SELECT count(*) FROM usage_rollup_daily
                WHERE tenant_id = $1
                  AND bucket_start <> date_trunc('day', bucket_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS bad_days,
              (SELECT count(*) FROM usage_rollup_monthly
                WHERE tenant_id = $1
                  AND bucket_start <> date_trunc('month', bucket_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS bad_months`,
      [TENANT],
    );
    assert.equal(Number(bounds.rows[0].bad_days), 0);
    assert.equal(Number(bounds.rows[0].bad_months), 0);

    // AA-162: the per-company surface must reconcile exactly against the grain it
    // projects, and must carry the denominators that qualify a $0 COGS.
    //
    // A plain REFRESH is used here because REFRESH ... CONCURRENTLY cannot run
    // inside a transaction block, and this whole test is one rolled-back
    // transaction. What CONCURRENTLY additionally needs is the unique index,
    // which is asserted separately below.
    await client.query('REFRESH MATERIALIZED VIEW daily_company_usage');
    const company = await client.query(
      `SELECT total_tasks, settled_tasks, retries, ai_tasks, tasks_with_usage_reported,
              total_tokens, total_duration_ms, total_cogs_cents
         FROM daily_company_usage
        WHERE company_id = $1`,
      [TENANT],
    );
    assert.equal(company.rows.length, 1, 'one row per company per day');
    const day = company.rows[0];
    assert.equal(Number(day.total_tasks), 2, 'both AI attempts, retries included');
    assert.equal(Number(day.settled_tasks), 1, 'the retry is not a settled task');
    assert.equal(Number(day.retries), 1);
    assert.equal(Number(day.ai_tasks), 2);
    // The whole point of the denominator: 2 AI tasks, 1 reported usage. A
    // chargeback reading total_cogs_cents alone would bill this day as $0.
    assert.equal(Number(day.tasks_with_usage_reported), 1);
    assert.equal(Number(day.total_tokens), 120);
    assert.equal(Number(day.total_duration_ms), 1200);
    assert.equal(Number(day.total_cogs_cents), 4.5);

    const uniqueIndex = await client.query(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'daily_company_usage'
          AND indexname = 'idx_daily_company_usage_company_date'`,
    );
    assert.equal(uniqueIndex.rows.length, 1, 'the MV has its index');
    assert.match(
      String(uniqueIndex.rows[0].indexdef),
      /CREATE UNIQUE INDEX/,
      'REFRESH ... CONCURRENTLY refuses to run without a UNIQUE index',
    );

    const dailyBefore = await client.query(
      `SELECT sum(events)::bigint AS events, sum(total_tokens)::bigint AS tokens
         FROM usage_rollup_daily WHERE tenant_id = $1`,
      [TENANT],
    );

    // Re-roll the SAME window (far enough back to definitely re-cover the seeded
    // hour). Convergence, not accumulation.
    await client.query(
      `UPDATE usage_rollup_state SET rolled_through = rolled_through - interval '6 hours'`,
    );
    await runUsageRollup(db, { maxHoursPerPass: 24, maxBackfillDays: 1 });
    const dailyAfter = await client.query(
      `SELECT sum(events)::bigint AS events, sum(total_tokens)::bigint AS tokens
         FROM usage_rollup_daily WHERE tenant_id = $1`,
      [TENANT],
    );
    assert.equal(String(dailyAfter.rows[0].events), String(dailyBefore.rows[0].events));
    assert.equal(String(dailyAfter.rows[0].tokens), String(dailyBefore.rows[0].tokens));

    // Retention: past the window AND below the watermark is purged; anything
    // newer than the cutoff — including everything inside the re-roll overlap —
    // is retained.
    const purge = await runUsageRetentionSweep(db, {
      dryRun: false,
      rawRetentionDays: 1,
      hourlyRetentionDays: 1,
      batchSize: 500,
    });
    assert.equal(purge.skippedReason, null);
    const remaining = await client.query(
      `SELECT task_key, count(*)::int AS n FROM task_execution_log
        WHERE tenant_id = $1 GROUP BY 1 ORDER BY 1`,
      [TENANT],
    );
    assert.deepEqual(
      remaining.rows.map((r) => r.task_key),
      ['marketing.stage.production'],
      'the 100-day-old row is purged; the recent rows are retained',
    );
    assert.equal(Number(remaining.rows[0].n), 2);
    const belowCutoff = await client.query(
      `SELECT count(*)::int AS n FROM task_execution_log
        WHERE tenant_id = $1 AND started_at < $2::timestamptz`,
      [TENANT, purge.rawCutoff],
    );
    assert.equal(belowCutoff.rows[0].n, 0, 'nothing below the cutoff survives');
    // The aggregate outlives the raw rows — the whole reason these are tables and
    // not materialized views over the log.
    const dailyKept = await client.query(
      `SELECT count(*)::int AS n FROM usage_rollup_daily WHERE tenant_id = $1`,
      [TENANT],
    );
    assert.ok(dailyKept.rows[0].n > 0, 'daily aggregates survive the raw purge');
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});
