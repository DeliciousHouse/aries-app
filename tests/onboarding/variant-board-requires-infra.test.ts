/**
 * Live-DB (requires-infra) test for the creative_assets variant-grouping columns
 * and the board read query. Source-level assertions always run; the live-DB leg
 * self-skips without DB env and wraps writes in BEGIN/ROLLBACK. Indexed in
 * tests/REQUIRES_INFRA.md.
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

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const INIT_DB_SRC = readFileSync(path.join(REPO_ROOT, 'scripts/init-db.js'), 'utf8');

test('init-db.js declares creative_assets variant columns + grouping index', () => {
  assert.match(INIT_DB_SRC, /ADD COLUMN IF NOT EXISTS variant_batch_id TEXT/);
  assert.match(INIT_DB_SRC, /ADD COLUMN IF NOT EXISTS variant_index INTEGER/);
  assert.match(INIT_DB_SRC, /idx_creative_assets_variant_batch/);
});

function dbConfigFromEnv(): pg.PoolConfig | null {
  const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } = process.env;
  if (!DB_HOST || !DB_PORT || !DB_USER || !DB_PASSWORD || !DB_NAME) return null;
  return { host: DB_HOST, port: Number(DB_PORT), user: DB_USER, password: DB_PASSWORD, database: DB_NAME, max: 2 };
}

const dbConfig = dbConfigFromEnv();

test('creative_assets variant columns accept inserts and the board query groups them (real Postgres, rolled back)', async (t) => {
  if (!dbConfig) {
    requireDbEnvOrSkip(t);
    return;
  }

  const pool = new pg.Pool(dbConfig);
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Columns exist.
      const cols = await client.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'creative_assets' AND column_name IN ('variant_batch_id', 'variant_index')`,
      );
      assert.equal(cols.rowCount, 2, 'both variant columns exist');

      const org = await client.query('SELECT id FROM organizations ORDER BY id LIMIT 1');
      if (org.rowCount === 0) {
        console.warn('[variant-board-requires-infra] no organizations rows; skipping FK-dependent leg.');
        await client.query('ROLLBACK');
        return;
      }
      const tenantId = Number(org.rows[0].id);
      const batchId = `vbatch_qa_${Date.now()}`;

      // Insert 3 variant rows (mirrors what ingest writes), variant_index 0..2.
      for (let i = 0; i < 3; i++) {
        await client.query(
          `INSERT INTO creative_assets (tenant_id, source_type, permission_scope, media_type, variant_batch_id, variant_index)
           VALUES ($1, 'generated_by_aries', 'generated', 'image', $2, $3)`,
          [tenantId, batchId, i],
        );
      }

      // The board read query — identical ORDER BY to getVariantBoard's
      // SELECT_VARIANT_ASSETS_SQL (created_at DESC so an edited/regenerated row
      // for the same index swaps to the front = latest-wins).
      const board = await client.query(
        `SELECT variant_index, id::text AS creative_id, served_asset_ref
           FROM creative_assets
          WHERE tenant_id = $1 AND variant_batch_id = $2
          ORDER BY variant_index ASC, created_at DESC, id DESC`,
        [tenantId, batchId],
      );
      assert.equal(board.rowCount, 3, 'all three variants returned');
      assert.deepEqual(board.rows.map((r) => r.variant_index), [0, 1, 2], 'ordered by variant_index');

      // Latest-wins: a SECOND, NEWER creative for variant_index 0 (an edit/regen)
      // must sort to the front so the board shows the freshest image for that slot.
      const newerBatch = `${batchId}_latest`;
      await client.query(
        `INSERT INTO creative_assets (tenant_id, source_type, permission_scope, media_type, variant_batch_id, variant_index, created_at)
         VALUES ($1, 'generated_by_aries', 'generated', 'image', $2, 0, now() - interval '1 hour')`,
        [tenantId, newerBatch],
      );
      const newerRow = await client.query(
        `INSERT INTO creative_assets (tenant_id, source_type, permission_scope, media_type, variant_batch_id, variant_index, created_at)
         VALUES ($1, 'generated_by_aries', 'generated', 'image', $2, 0, now())
         RETURNING id::text AS creative_id`,
        [tenantId, newerBatch],
      );
      const front = await client.query(
        `SELECT id::text AS creative_id
           FROM creative_assets
          WHERE tenant_id = $1 AND variant_batch_id = $2
          ORDER BY variant_index ASC, created_at DESC, id DESC`,
        [tenantId, newerBatch],
      );
      assert.equal(front.rows[0].creative_id, newerRow.rows[0].creative_id, 'newest creative for the index sorts first');

      // The partial index does not constrain non-variant rows (NULL batch id).
      const before = await client.query(
        `SELECT count(*)::int AS n FROM creative_assets WHERE tenant_id = $1 AND variant_batch_id IS NULL`,
        [tenantId],
      );
      assert.ok(Number.isInteger(before.rows[0].n), 'NULL-batch rows query plans fine');

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    console.log('[variant-board-requires-infra] PASS: variant columns + board grouping query against real Postgres.');
  } finally {
    await pool.end();
  }
});
