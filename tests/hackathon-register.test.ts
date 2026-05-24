import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// Source-level + live-DB tests for the hackathon registration endpoint.
// Source-level always runs; the live-DB upsert smoke test skips without
// DB env. The route lives at app/api/hackathon/register/route.ts and the
// schema at scripts/init-db.js.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUTE_SRC = readFileSync(
  path.join(REPO_ROOT, 'app/api/hackathon/register/route.ts'),
  'utf8',
);
const INIT_DB_SRC = readFileSync(
  path.join(REPO_ROOT, 'scripts/init-db.js'),
  'utf8',
);

test('init-db.js declares hackathon_registrations table with required columns', () => {
  assert.match(
    INIT_DB_SRC,
    /CREATE TABLE IF NOT EXISTS hackathon_registrations \(/,
    'hackathon_registrations must be declared in init-db.js',
  );
  assert.match(INIT_DB_SRC, /name TEXT NOT NULL/);
  assert.match(INIT_DB_SRC, /email TEXT NOT NULL/);
  assert.match(
    INIT_DB_SRC,
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_hackathon_registrations_email_lower/,
    'unique lower(email) index must be declared to prevent duplicate registrations',
  );
});

test('register route validates name + email and rejects empty payload with 422', () => {
  assert.match(ROUTE_SRC, /Name is required\./);
  assert.match(ROUTE_SRC, /Email is required\./);
  assert.match(ROUTE_SRC, /Enter a valid email address\./);
  assert.match(ROUTE_SRC, /status: 422/);
});

test('register route uses ON CONFLICT to upsert, not error, on duplicate email', () => {
  assert.match(
    ROUTE_SRC,
    /ON CONFLICT \(\(lower\(email\)\)\) DO UPDATE/,
    'duplicate email must upsert, not 409 -- the page is direct-URL share-friendly',
  );
});

test('register route caps field lengths and never trusts client ip beyond x-forwarded-for', () => {
  assert.match(ROUTE_SRC, /MAX_FIELD_LEN = 1000/);
  assert.match(ROUTE_SRC, /x-forwarded-for/);
  assert.match(ROUTE_SRC, /\.slice\(0, 100\)/, 'IP must be length-capped');
});

test('landing page metadata is configured to noindex', () => {
  const pageSrc = readFileSync(
    path.join(REPO_ROOT, 'app/hackathon/page.tsx'),
    'utf8',
  );
  assert.match(pageSrc, /index: false/);
  assert.match(pageSrc, /follow: false/);
  assert.match(pageSrc, /googleBot:/);
});

test('robots.txt disallows /hackathon for all user-agents', () => {
  const robots = readFileSync(path.join(REPO_ROOT, 'public/robots.txt'), 'utf8');
  assert.match(robots, /User-agent: \*/);
  assert.match(robots, /Disallow: \/hackathon/);
});

// Live-DB smoke: insert + upsert through the real schema, then ROLLBACK.
function dbConfigFromEnv(): pg.PoolConfig | null {
  const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } = process.env;
  if (!DB_HOST || !DB_PORT || !DB_USER || !DB_PASSWORD || !DB_NAME) return null;
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

test('hackathon_registrations table accepts insert + upsert against real Postgres', async (t) => {
  if (!dbConfig) {
    console.warn(
      '\n[hackathon-register] SKIPPED: DB env not configured. The live-DB ' +
        'smoke runs after init-db migration applies in prod.\n',
    );
    t.skip('database env not configured');
    return;
  }

  const pool = new pg.Pool(dbConfig);
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Column existence check.
      const cols = await client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'hackathon_registrations'`,
      );
      const names = cols.rows.map((r) => r.column_name).sort();
      for (const required of ['id', 'name', 'email', 'motivation', 'registered_at', 'updated_at']) {
        assert.ok(names.includes(required), `column ${required} must exist`);
      }

      // First insert.
      const testEmail = `qa-${Date.now()}@example.test`;
      const first = await client.query(
        `INSERT INTO hackathon_registrations (name, email, motivation)
         VALUES ($1, $2, $3)
         ON CONFLICT ((lower(email))) DO UPDATE
           SET name = EXCLUDED.name, motivation = EXCLUDED.motivation, updated_at = now()
         RETURNING id, name, email`,
        ['Test Person', testEmail, 'first registration'],
      );
      assert.equal(first.rowCount, 1);

      // Re-insert same email upserts (idempotent on share-and-refresh).
      const second = await client.query(
        `INSERT INTO hackathon_registrations (name, email, motivation)
         VALUES ($1, $2, $3)
         ON CONFLICT ((lower(email))) DO UPDATE
           SET name = EXCLUDED.name, motivation = EXCLUDED.motivation, updated_at = now()
         RETURNING id`,
        ['Test Person Updated', testEmail.toUpperCase(), 'updated motivation'],
      );
      assert.equal(second.rowCount, 1);
      assert.equal(
        second.rows[0].id,
        first.rows[0].id,
        'upsert must return the same row id (case-insensitive email match)',
      );

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    console.log('[hackathon-register] PASS: insert + case-insensitive upsert against real Postgres.');
  } finally {
    await pool.end();
  }
});
