import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import pg from 'pg';

import { requireDbEnvOrSkip } from '../helpers/requires-infra';

import { ingestProductionCreativeAssetsToDb } from '../../backend/marketing/ingest-production-assets';
import type { SocialContentJobRuntimeDocument } from '../../backend/marketing/runtime-state';

// Real-Postgres regression test for the creative_assets ingest INSERT.
//
// This is the test that catches a malformed ON CONFLICT clause. The ingest's
// `INSERT INTO creative_assets ... ON CONFLICT (tenant_id, checksum) ...` must
// repeat the predicate of the PARTIAL unique index
// `idx_creative_assets_tenant_checksum_unique` (UNIQUE (tenant_id, checksum)
// WHERE checksum IS NOT NULL). Omitting `WHERE checksum IS NOT NULL` makes
// Postgres reject every INSERT with "no unique or exclusion constraint matching
// the ON CONFLICT specification" — the bug that left every completed pipeline
// with 0 creative_assets.
//
// CRITICAL: this test MUST execute the real INSERT against real Postgres. A
// recording / capturing mock pool records SQL without running it and CANNOT
// catch a broken ON CONFLICT — every prior ingest fix was mock-verified and
// missed exactly this. The pg client below executes the statement inside a
// transaction that is always rolled back, so the malformed clause is caught
// while nothing is persisted.

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

function makeStage(name: string, primaryOutput: unknown = null) {
  return {
    stage: name,
    status: 'completed',
    started_at: null,
    completed_at: null,
    failed_at: null,
    run_id: null,
    summary: null,
    primary_output: primaryOutput,
    outputs: {},
    artifacts: [],
    errors: [],
  };
}

function makeDoc(jobId: string, tenantId: number, creativeAssets: unknown[]): SocialContentJobRuntimeDocument {
  return {
    schema_name: 'marketing_job_state_schema',
    schema_version: '1.0.0',
    job_id: jobId,
    tenant_id: String(tenantId),
    job_type: 'weekly_social_content',
    state: 'completed',
    status: 'completed',
    current_stage: 'production',
    stage_order: ['research', 'strategy', 'production', 'publish'],
    stages: {
      research: makeStage('research'),
      strategy: makeStage('strategy'),
      production: makeStage('production', { stage: 'production', artifacts: { creative_assets: creativeAssets, errors: [] } }),
      publish: makeStage('publish'),
    },
    approvals: { current: null, history: [] },
    publish_config: { platforms: [], live_publish_platforms: [], video_render_platforms: [] },
    brand_kit: null,
    inputs: { request: {}, brand_url: 'https://example.com' },
    history: [],
    errors: [],
    last_error: null,
  } as unknown as SocialContentJobRuntimeDocument;
}

const dbConfig = dbConfigFromEnv();

test('ingestProductionCreativeAssetsToDb INSERT runs against real Postgres without an ON CONFLICT error', async (t) => {
  if (!dbConfig) {
    console.warn(
      '\n[ingest-production-assets-live-db] SKIPPED: DB_HOST/DB_PORT/DB_USER/' +
        'DB_PASSWORD/DB_NAME not all set. This test MUST run against a real ' +
        'database — a mock pool cannot catch a malformed ON CONFLICT clause.\n',
    );
    requireDbEnvOrSkip(t);
    return;
  }

  // Temp mount with two real image files — ingest readFile()s each by basename.
  const prevMount = process.env.HERMES_IMAGE_CACHE_MOUNT;
  const mount = await mkdtemp(path.join(tmpdir(), 'aries-ingest-livedb-'));
  process.env.HERMES_IMAGE_CACHE_MOUNT = mount;

  const pool = new pg.Pool(dbConfig);
  try {
    await writeFile(path.join(mount, 'img_a.png'), Buffer.from('alpha-bytes'));
    await writeFile(path.join(mount, 'img_b.png'), Buffer.from('beta-bytes'));

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const orgResult = await client.query<{ id: number }>(
        `INSERT INTO organizations (name) VALUES ($1) RETURNING id`,
        ['ingest-livedb-tenant'],
      );
      const tenantId = orgResult.rows[0].id;
      const jobId = `mkt_ingest_livedb_${Date.now()}`;

      const doc = makeDoc(jobId, tenantId, [
        { assetId: 'img_1', type: 'generated_image', path: '/home/node/.hermes/profiles/aries-content-generator/cache/images/img_a.png' },
        { assetId: 'img_2', type: 'generated_image', path: '/home/node/.hermes/profiles/aries-content-generator/cache/images/img_b.png' },
      ]);

      // Runs the REAL INSERT ... ON CONFLICT against real Postgres. A broken
      // ON CONFLICT clause throws here; ingestProductionCreativeAssetsToDb
      // catches per-row errors and counts them as skipped, so the assertion
      // below on `inserted` is what fails when the clause is malformed.
      const result = await ingestProductionCreativeAssetsToDb({
        jobId,
        tenantId,
        doc,
        pool: client,
      });

      assert.equal(result.total, 2, 'two creative_assets considered');
      assert.equal(
        result.inserted,
        2,
        'both rows INSERTed — a malformed ON CONFLICT would make this 0 (every row skipped)',
      );
      assert.equal(result.skipped, 0, 'no rows skipped — the ON CONFLICT clause is valid');

      // The rows are really in the table.
      const rows = await client.query<{ id: string; source_asset_id: string; checksum: string; served_asset_ref: string | null }>(
        `SELECT id, source_asset_id, checksum, served_asset_ref FROM creative_assets WHERE source_job_id = $1 ORDER BY source_asset_id`,
        [jobId],
      );
      assert.equal(rows.rows.length, 2, 'two creative_assets rows persisted');
      assert.ok(rows.rows.every((r) => r.checksum && r.checksum.length === 64), 'each row has a sha256 checksum');

      // REGRESSION GUARD (#517): served_asset_ref MUST be populated and equal
      // `/api/internal/hermes/media/<id>`. The prior data-modifying-CTE form
      // (`WITH ins AS (INSERT ... RETURNING id) UPDATE ... FROM ins`) left this
      // NULL because Postgres runs the outer UPDATE on a pre-INSERT snapshot —
      // and resolveMediaUrls then returns [] for the post, so Instagram (which
      // hard-requires a media URL) fails every publish with instagram_media_required.
      // A mock pool cannot catch this; only a real-Postgres INSERT can. This is
      // the test that proves the self-referential INSERT…SELECT actually writes
      // the ref.
      for (const r of rows.rows) {
        assert.ok(
          r.served_asset_ref && r.served_asset_ref.length > 0,
          `served_asset_ref must be populated (NULL = the #517 regression that broke IG publishing) for ${r.source_asset_id}`,
        );
        assert.equal(
          r.served_asset_ref,
          `/api/internal/hermes/media/${r.id}`,
          'served_asset_ref must embed the row\'s own id',
        );
      }

      // Idempotency: a replayed callback must ON CONFLICT DO NOTHING, not error
      // and not duplicate. This exercises the conflict arm of the partial index.
      const replay = await ingestProductionCreativeAssetsToDb({
        jobId,
        tenantId,
        doc,
        pool: client,
      });
      assert.equal(replay.total, 2);
      assert.equal(replay.inserted, 0, 'replay inserts zero new rows (ON CONFLICT DO NOTHING)');
      assert.equal(replay.skipped, 2, 'replay sees both as existing conflicts');

      const afterReplay = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM creative_assets WHERE source_job_id = $1`,
        [jobId],
      );
      assert.equal(afterReplay.rows[0].count, '2', 'still exactly two rows after replay');

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    console.log(
      '[ingest-production-assets-live-db] PASS: ingest INSERT ... ON CONFLICT ' +
        'executed against real Postgres — 2 rows inserted, replay idempotent.',
    );
  } finally {
    await pool.end();
    if (prevMount === undefined) delete process.env.HERMES_IMAGE_CACHE_MOUNT;
    else process.env.HERMES_IMAGE_CACHE_MOUNT = prevMount;
    await rm(mount, { recursive: true, force: true });
  }
});
