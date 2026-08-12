import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

import { requireDbEnvOrSkip } from './helpers/requires-infra';

// Real-Postgres integration test for the scheduled-posts worker's claim path.
//
// This is the test that would have caught the `FOR UPDATE cannot be applied to
// the nullable side of an outer join` bug: CLAIM_ROW_SQL combines a LEFT JOIN
// with a row lock, which mock pools never reject but a real planner does.
//
// The three SQL strings are imported from the worker (a .mjs script with no
// type declarations, reached via a pathToFileURL dynamic import + cast — the
// same route tests/scheduled-worker-claim-lock-order.test.ts takes). They used
// to be text-extracted with a regex, which broke the moment the statements
// started composing a shared fragment (the owner-gated auto-publish admit
// predicate): extraction returns the raw `${...}` source text, and Postgres
// rejects it with `syntax error at or near "$"`. Importing evaluates the
// template, so the test runs the query the worker actually runs.
//
// When DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME are absent the test skips
// loudly. When the DB is reachable it MUST run and pass: every query is
// executed against the live schema inside a transaction that is rolled back, so
// no rows are persisted.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

type WorkerSql = {
  CLAIM_ROW_SQL: string;
  DUE_ROWS_SQL: string;
  MARK_IN_FLIGHT_SQL: string;
};

// Loaded inside the test rather than at module scope: tsx transforms these
// files to CJS, where top-level await is a build error.
async function loadWorkerSql(): Promise<WorkerSql> {
  return (await import(
    pathToFileURL(path.join(REPO_ROOT, 'scripts/automations/scheduled-posts-worker.mjs')).href
  )) as unknown as WorkerSql;
}

function dbConfigFromEnv(): pg.PoolConfig | null {
  const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } = process.env;
  if (!DB_HOST || !DB_PORT || !DB_USER || !DB_PASSWORD || !DB_NAME) {
    return null;
  }
  return {
    host: DB_HOST,
    port: Number(DB_PORT),
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    max: 2,
  };
}

const dbConfig = dbConfigFromEnv();

test('scheduled-posts worker claim queries run against real Postgres', async (t) => {
  if (!dbConfig) {
    console.warn(
      '\n[scheduled-posts-worker-live-db] SKIPPED: DB_HOST/DB_PORT/DB_USER/' +
        'DB_PASSWORD/DB_NAME not all set. This test MUST run against a real ' +
        'database in CI/prod validation — a skip here means the real planner ' +
        'was never exercised.\n',
    );
    requireDbEnvOrSkip(t);
    return;
  }

  const { CLAIM_ROW_SQL, DUE_ROWS_SQL, MARK_IN_FLIGHT_SQL } = await loadWorkerSql();
  const pool = new pg.Pool(dbConfig);
  try {
    const client = await pool.connect();
    try {
      // Everything runs inside a transaction that is always rolled back; the
      // worker SQL is exercised against the real planner and real schema
      // without persisting any row.
      await client.query('BEGIN');

      // 1. CLAIM_ROW_SQL — the regression target. A bare `FOR UPDATE` on this
      //    LEFT JOIN fails at plan time; `FOR UPDATE OF sp` must succeed. Run
      //    with an id that matches nothing so no real row is locked.
      await client.query(CLAIM_ROW_SQL, [-1, new Date().toISOString(), false]);

      // 2. DUE_ROWS_SQL — the batch scan. $1 batch size, $2 stale cutoff.
      await client.query(DUE_ROWS_SQL, [1, new Date().toISOString(), false]);

      // 3. MARK_IN_FLIGHT_SQL — writes dispatch_status='in_flight'. This fails
      //    against the live schema unless the dispatch_status CHECK constraint
      //    actually permits 'in_flight'. id=-1 matches nothing; the statement
      //    still parses, plans, and validates the constraint.
      await client.query(MARK_IN_FLIGHT_SQL, [-1, 'live-db-planner-attempt-token']);

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    console.log(
      '[scheduled-posts-worker-live-db] PASS: CLAIM_ROW_SQL, DUE_ROWS_SQL, ' +
        'MARK_IN_FLIGHT_SQL all executed against real Postgres with zero ' +
        'planner/schema errors.',
    );
  } finally {
    await pool.end();
  }
});
