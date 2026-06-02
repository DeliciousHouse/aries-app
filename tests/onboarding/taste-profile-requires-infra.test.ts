/**
 * Live-DB (requires-infra) test for the marketing_taste_profile +
 * marketing_taste_signal schema and the taste-profile store SQL.
 *
 * Source-level assertions always run; the live-DB leg self-skips without DB env
 * (requireDbEnvOrSkip) and wraps every write in BEGIN/ROLLBACK so nothing
 * persists in prod. Indexed in tests/REQUIRES_INFRA.md.
 *
 * Run:
 *   export DB_HOST=... DB_PORT=... DB_USER=... DB_PASSWORD=... DB_NAME=...
 *   export ARIES_TEST_REQUIRES_INFRA_ENABLED=1
 *   npm run test:requires-infra
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { requireDbEnvOrSkip } from '../helpers/requires-infra';
import { applyTasteSignal, getTasteProfile } from '../../backend/marketing/taste-profile-store';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const INIT_DB_SRC = readFileSync(path.join(REPO_ROOT, 'scripts/init-db.js'), 'utf8');

test('init-db.js declares marketing_taste_profile + marketing_taste_signal tables', () => {
  assert.match(INIT_DB_SRC, /CREATE TABLE IF NOT EXISTS marketing_taste_profile \(/);
  assert.match(INIT_DB_SRC, /CREATE TABLE IF NOT EXISTS marketing_taste_signal \(/);
  assert.match(INIT_DB_SRC, /dimensions JSONB NOT NULL DEFAULT '\{\}'::jsonb/);
  assert.match(INIT_DB_SRC, /marketing_taste_signal_rating_range CHECK \(rating IS NULL OR rating BETWEEN 1 AND 5\)/);
  // tenant_id/user_id must be INTEGER FKs (the 096c30a lesson), never BIGINT.
  assert.ok(!/marketing_taste_profile[\s\S]*?tenant_id BIGINT/.test(INIT_DB_SRC), 'tenant_id must not be BIGINT');
});

function dbConfigFromEnv(): pg.PoolConfig | null {
  const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } = process.env;
  if (!DB_HOST || !DB_PORT || !DB_USER || !DB_PASSWORD || !DB_NAME) return null;
  return { host: DB_HOST, port: Number(DB_PORT), user: DB_USER, password: DB_PASSWORD, database: DB_NAME, max: 2 };
}

const dbConfig = dbConfigFromEnv();

test('marketing_taste_profile upsert merges + decays; signal log enforces rating range (real Postgres, rolled back)', async (t) => {
  if (!dbConfig) {
    requireDbEnvOrSkip(t);
    return;
  }

  const pool = new pg.Pool(dbConfig);
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const org = await client.query('SELECT id FROM organizations ORDER BY id LIMIT 1');
      const usr = await client.query('SELECT id FROM users ORDER BY id LIMIT 1');
      if (org.rowCount === 0 || usr.rowCount === 0) {
        console.warn('[taste-profile-requires-infra] no organizations/users rows; skipping FK-dependent leg.');
        await client.query('ROLLBACK');
        return;
      }
      const tenantId = String(org.rows[0].id);
      const userId = String(usr.rows[0].id);

      // Unique dimension/value so this can never collide with real taste data.
      const dim = `__qa_dim_${Date.now()}__`;
      const value = `__qa_value_${Date.now()}__`;

      // First approved signal → stored approved_count = 1.
      await applyTasteSignal(
        { tenantId, userId, dimension: dim, value, outcome: 'approved' },
        client as never,
      );
      const after1 = await client.query(
        `SELECT (dimensions -> $3 -> $4 ->> 'approved_count')::int AS a
           FROM marketing_taste_profile WHERE tenant_id = $1 AND user_id = $2`,
        [Number(tenantId), Number(userId), dim, value],
      );
      assert.equal(after1.rows[0].a, 1, 'first approved signal sets approved_count = 1');

      // Second approved signal → deep-merge increments to 2 (siblings preserved).
      await applyTasteSignal(
        { tenantId, userId, dimension: dim, value, outcome: 'approved' },
        client as never,
      );
      const after2 = await client.query(
        `SELECT (dimensions -> $3 -> $4 ->> 'approved_count')::int AS a
           FROM marketing_taste_profile WHERE tenant_id = $1 AND user_id = $2`,
        [Number(tenantId), Number(userId), dim, value],
      );
      assert.equal(after2.rows[0].a, 2, 'second approved signal merges to approved_count = 2');

      // getTasteProfile reads + decays the row; our fresh unique dim tops out at our value.
      const view = await getTasteProfile(tenantId, userId, client as never);
      assert.ok(view, 'profile row exists after signals');
      assert.equal(view!.dimensions[dim]?.value, value, 'unique dimension resolves to our value');
      assert.ok(view!.dimensions[dim]!.confidence > 0, 'confidence is positive');

      // Append-only signal log accepts a valid (rating 1-5) row.
      const logged = await client.query(
        `INSERT INTO marketing_taste_signal
           (tenant_id, user_id, job_id, variant_batch_id, slot_index, variant_id, picked, rating, edit_ops)
         VALUES ($1, $2, $3, $4, 0, $5, true, 5, '{}'::jsonb)
         RETURNING id`,
        [Number(tenantId), Number(userId), 'qa-job', 'qa-batch', 'qa-variant'],
      );
      assert.equal(logged.rowCount, 1, 'valid taste signal row inserts');

      // The rating CHECK constraint rejects out-of-range ratings.
      await client.query('SAVEPOINT bad_rating');
      await assert.rejects(
        () =>
          client.query(
            `INSERT INTO marketing_taste_signal
               (tenant_id, user_id, job_id, variant_batch_id, slot_index, variant_id, picked, rating)
             VALUES ($1, $2, 'qa-job', 'qa-batch', 0, 'qa-variant', false, 6)`,
            [Number(tenantId), Number(userId)],
          ),
        /rating_range|check constraint/i,
        'rating = 6 must violate the CHECK constraint',
      );
      await client.query('ROLLBACK TO SAVEPOINT bad_rating');

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    console.log('[taste-profile-requires-infra] PASS: upsert merge + decay + signal-log constraint against real Postgres.');
  } finally {
    await pool.end();
  }
});
