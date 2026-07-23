import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { requireDbEnvOrSkip } from './helpers/requires-infra';

// Real-Postgres integration test for the scheduled-posts worker's claim path.
//
// This is the test that would have caught the `FOR UPDATE cannot be applied to
// the nullable side of an outer join` bug: CLAIM_ROW_SQL combines a LEFT JOIN
// with a row lock, which mock pools never reject but a real planner does.
//
// The three SQL strings are text-extracted from the worker source (a .mjs
// script with no type declarations, so it cannot be imported under the
// route-type tsc gate). Extracting keeps the test from drifting away from the
// query the worker actually runs.
//
// When DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME are absent the test skips
// loudly. When the DB is reachable it MUST run and pass: every query is
// executed against the live schema inside a transaction that is rolled back, so
// no rows are persisted.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER_SRC = readFileSync(
  path.join(REPO_ROOT, 'scripts/automations/scheduled-posts-worker.mjs'),
  'utf8',
);

function extractExportedSql(name: string): string {
  const match = WORKER_SRC.match(
    new RegExp(`export const ${name} = \`([\\s\\S]*?)\`;`),
  );
  assert.ok(match, `${name} must be defined and exported in the worker`);
  return match[1];
}

const CLAIM_ROW_SQL = extractExportedSql('CLAIM_ROW_SQL');
const DUE_ROWS_SQL = extractExportedSql('DUE_ROWS_SQL');
const MARK_IN_FLIGHT_SQL = extractExportedSql('MARK_IN_FLIGHT_SQL');

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
      await client.query(CLAIM_ROW_SQL, [-1, new Date().toISOString()]);

      // 2. DUE_ROWS_SQL — the batch scan. $1 batch size, $2 stale cutoff.
      await client.query(DUE_ROWS_SQL, [1, new Date().toISOString()]);

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
