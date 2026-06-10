import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';

import { requireDbEnvOrSkip } from './helpers/requires-infra';
import {
  SWEEP_STRANDED_SYNC_RUNS_SQL,
  DEFAULT_STRANDED_RUN_GRACE_MINUTES,
} from '../backend/insights/sync/sweep-stranded-runs';
import { SYNC_RUN_TERMINAL_OK_SQL } from '../backend/insights/sync/dispatcher';

// Live-schema proof for the stranded-run sweep. The in-memory tests
// (tests/insights-sync-worker-stranded-runs.test.ts) only see the SQL as a
// string — a renamed column, a typo'd interval, or invalid SQL would pass
// them and then fail silently in prod every 30 minutes as
// insights_sync_sweep_failed. This file executes the real exported statements
// against the real schema inside a rolled-back transaction (the established
// requires-infra pattern), proving:
//   1. the predicate flips ONLY a stale 'running' row — a fresh 'running' row
//      (grace window) and terminal ok/partial rows are untouched;
//   2. the dispatcher's terminal ok UPDATE wins over a mid-flight sweep AND
//      clears the sweep's abort message (the PR #581-review F1 finding: a
//      swept-then-completed run must not end as status='ok' with
//      error_message='aborted by worker restart').

test('stranded-run sweep: predicate and terminal-ok override against real Postgres', async (t) => {
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

    const insertRun = async (status: string, age: string): Promise<number> => {
      const res = await client.query<{ id: number }>(
        `INSERT INTO insights_sync_runs
           (tenant_id, account_id, platform, trigger, started_at, status)
         VALUES (999999, 1, 'instagram', 'interval', now() - $1::interval, $2)
         RETURNING id`,
        [age, status],
      );
      return res.rows[0].id;
    };

    const stale = await insertRun('running', '2 hours');
    const fresh = await insertRun('running', '5 minutes');
    const okRow = await insertRun('ok', '2 hours');
    const partialRow = await insertRun('partial', '2 hours');

    // Real planner, real predicate — the exact statement the worker runs.
    await client.query(SWEEP_STRANDED_SYNC_RUNS_SQL, [DEFAULT_STRANDED_RUN_GRACE_MINUTES]);

    const readRows = async () => {
      const res = await client.query<{
        id: string | number;
        status: string;
        finished_at: Date | null;
        error_message: string | null;
      }>(
        `SELECT id, status, finished_at, error_message
         FROM insights_sync_runs WHERE id = ANY($1)`,
        [[stale, fresh, okRow, partialRow]],
      );
      return new Map(res.rows.map((r) => [Number(r.id), r]));
    };

    const afterSweep = await readRows();
    assert.equal(afterSweep.get(stale)?.status, 'failed', 'the stale running row is failed out');
    assert.equal(
      afterSweep.get(stale)?.error_message,
      'aborted by worker restart',
      'the swept row carries the restart-abort message',
    );
    assert.ok(afterSweep.get(stale)?.finished_at, 'the swept row is closed out');
    assert.equal(
      afterSweep.get(fresh)?.status,
      'running',
      'the grace window protects a sync genuinely in flight',
    );
    assert.equal(afterSweep.get(okRow)?.status, 'ok', 'terminal ok rows are never re-failed');
    assert.equal(
      afterSweep.get(partialRow)?.status,
      'partial',
      'terminal partial rows are never re-failed',
    );

    // A swept run that then completes: the dispatcher's terminal ok UPDATE
    // (keyed on id alone) must win AND clear the abort message.
    await client.query(SYNC_RUN_TERMINAL_OK_SQL, [5, 2, 3, stale]);
    const afterComplete = await readRows();
    assert.equal(
      afterComplete.get(stale)?.status,
      'ok',
      "the dispatcher's true outcome overrides a mid-flight sweep",
    );
    assert.equal(
      afterComplete.get(stale)?.error_message,
      null,
      'a completed run must not keep the sweep abort message on a status=ok row',
    );
  } finally {
    await client.query('ROLLBACK').catch(() => {
      // rollback is best-effort; the connection is dropped right after
    });
    client.release();
    await pool.end();
  }
});
