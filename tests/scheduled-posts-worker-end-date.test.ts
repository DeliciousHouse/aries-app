import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { requireDbEnvOrSkip } from './helpers/requires-infra';

// T6 [CRITICAL] regression: lock the event_campaign auto-stop filter into the
// worker's exported CLAIM_ROW_SQL and DUE_ROWS_SQL. The filter is the only
// structural guarantee that posts stop publishing past campaign_end_date --
// the LLM strategy/production prompts (Hermes-side, separate workstream) are
// best-effort. If this filter regresses, event campaigns publish past their
// deadline and the load-bearing premise of the design doc breaks silently.
//
// Two layers:
//   1. Source-level assertions on the exported SQL strings (always run).
//   2. Live-DB planner exercise of the new column (skips when DB env absent;
//      matches the established scheduled-posts-worker-live-db.test.ts pattern).
//
// Real-row behavioural cases (PT/JST tz boundary, in-flight crossover) live in
// scheduled-posts-worker-tz-boundary.test.ts -- they need a real tenant id and
// fresh row inserts inside a rolled-back transaction.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER_SRC = readFileSync(
  path.join(REPO_ROOT, 'scripts/automations/scheduled-posts-worker.mjs'),
  'utf8',
);
const INIT_DB_SRC = readFileSync(
  path.join(REPO_ROOT, 'scripts/init-db.js'),
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

// ---------------------------------------------------------------------------
// Layer 1: source-level assertions
// ---------------------------------------------------------------------------

test('init-db.js declares scheduled_posts.campaign_end_date TIMESTAMPTZ', () => {
  assert.match(
    INIT_DB_SRC,
    /ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS campaign_end_date TIMESTAMPTZ/,
    'scheduled_posts.campaign_end_date must be declared in init-db.js',
  );
});

test('CLAIM_ROW_SQL filters past-end-date rows and leaves NULL rows claimable', () => {
  // The filter must be present.
  assert.match(
    CLAIM_ROW_SQL,
    /campaign_end_date IS NULL OR\s+sp\.campaign_end_date >= NOW\(\)/,
    'CLAIM_ROW_SQL must filter on (campaign_end_date IS NULL OR campaign_end_date >= NOW())',
  );
  // The existing crash-safety semantics must still be there -- the new filter
  // is in addition to, not in place of, the pending/in_flight reclaim clause.
  assert.match(
    CLAIM_ROW_SQL,
    /sp\.dispatch_status = 'pending'/,
    'CLAIM_ROW_SQL must still accept pending rows',
  );
  assert.match(
    CLAIM_ROW_SQL,
    /sp\.dispatch_status = 'in_flight' AND sp\.updated_at < \$2/,
    'CLAIM_ROW_SQL must still reclaim stale in_flight rows',
  );
  // The lock and JOIN shape must not have changed.
  assert.match(CLAIM_ROW_SQL, /FOR UPDATE OF sp SKIP LOCKED/);
  assert.match(CLAIM_ROW_SQL, /LEFT JOIN posts p ON p\.id = sp\.post_id/);
});

test('DUE_ROWS_SQL filters past-end-date rows and leaves NULL rows claimable', () => {
  assert.match(
    DUE_ROWS_SQL,
    /campaign_end_date IS NULL OR campaign_end_date >= NOW\(\)/,
    'DUE_ROWS_SQL must filter on (campaign_end_date IS NULL OR campaign_end_date >= NOW())',
  );
  // Pending and stale-in_flight reclaim must still be there.
  assert.match(
    DUE_ROWS_SQL,
    /dispatch_status = 'pending'/,
    'DUE_ROWS_SQL must still scan pending rows',
  );
  assert.match(
    DUE_ROWS_SQL,
    /dispatch_status = 'in_flight' AND updated_at < \$2/,
    'DUE_ROWS_SQL must still reclaim stale in_flight rows',
  );
});

test('campaign_end_date filter is applied to scheduled_posts row, not to joined posts row', () => {
  // CLAIM_ROW_SQL JOINs posts; the filter must target sp (scheduled_posts),
  // not p (posts) -- the end-date column lives on scheduled_posts.
  assert.match(
    CLAIM_ROW_SQL,
    /sp\.campaign_end_date/,
    'CLAIM_ROW_SQL must reference sp.campaign_end_date, not p.campaign_end_date',
  );
  // Negative lookbehind keeps the assertion from matching sp.campaign_end_date
  // as a substring.
  assert.doesNotMatch(
    CLAIM_ROW_SQL,
    /(?<!s)p\.campaign_end_date/,
    'CLAIM_ROW_SQL must not look for campaign_end_date on the posts table',
  );
});

// ---------------------------------------------------------------------------
// Layer 2: live-DB planner exercise (skips when DB env absent)
// ---------------------------------------------------------------------------

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

test('campaign_end_date column exists and the new claim filter plans against real Postgres', async (t) => {
  if (!dbConfig) {
    console.warn(
      '\n[scheduled-posts-worker-end-date] SKIPPED: DB env not configured. ' +
        'This test must pass in CI/prod validation -- a skip here means the ' +
        'real planner never saw the new campaign_end_date filter.\n',
    );
    requireDbEnvOrSkip(t);
    return;
  }

  const pool = new pg.Pool(dbConfig);
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. The column must exist on the live schema (caught by init-db.js
      //    drift if missing). information_schema is read-only and cheap.
      const colCheck = await client.query(
        `SELECT data_type FROM information_schema.columns
         WHERE table_name = 'scheduled_posts' AND column_name = 'campaign_end_date'`,
      );
      assert.equal(
        colCheck.rows.length,
        1,
        'scheduled_posts.campaign_end_date must exist on the live schema (run init-db)',
      );
      assert.equal(
        colCheck.rows[0].data_type,
        'timestamp with time zone',
        'campaign_end_date must be TIMESTAMPTZ',
      );

      // 2. CLAIM_ROW_SQL with id=-1 plans the new WHERE term against the real
      //    planner. Any mistake in the column reference (e.g. p.campaign_end_date
      //    instead of sp.campaign_end_date) fails here even though no row matches.
      await client.query(CLAIM_ROW_SQL, [-1, new Date().toISOString()]);

      // 3. DUE_ROWS_SQL plans the same filter at scan time. A bad filter (wrong
      //    type, wrong column name) errors out before any row is touched.
      await client.query(DUE_ROWS_SQL, [1, new Date().toISOString()]);

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    console.log(
      '[scheduled-posts-worker-end-date] PASS: campaign_end_date column ' +
        'exists and the new filter planned against real Postgres.',
    );
  } finally {
    await pool.end();
  }
});
