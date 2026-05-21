import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';

import { synthesizePublishPostsFromContentPackage } from '../../backend/marketing/synthesize-publish-posts';
import type { MarketingJobRuntimeDocument } from '../../backend/marketing/runtime-state';

// Real-Postgres regression test for the publish-posts synthesizer.
//
// This is the test that proves the Cause 2 fix: a completed Hermes publish
// stage carrying a `content_package` (and ingested `creative_assets`) must
// produce real draft `posts` rows — the missing link that left the operator
// with "Publish items 0 / No launch items". A mock pool cannot catch this:
// the synthesizer relies on the live `posts` schema (the partial unique index
// `(tenant_id, platform, idempotency_key) WHERE idempotency_key IS NOT NULL`
// powering ON CONFLICT DO NOTHING) and the `creative_assets` join.
//
// Everything runs inside a transaction that is always rolled back, so no row
// is persisted. When DB env is absent the test skips loudly.

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

// A minimal runtime document with a production-stage `content_package` of two
// posts (one dual-platform, one single-platform) and no `publish_package`.
function makeDoc(jobId: string, tenantId: number): MarketingJobRuntimeDocument {
  const stage = (name: string, primaryOutput: unknown) => ({
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
  });
  return {
    schema_name: 'marketing_job_state_schema',
    schema_version: '1.0.0',
    job_id: jobId,
    tenant_id: String(tenantId),
    job_type: 'brand_campaign',
    state: 'completed',
    status: 'completed',
    current_stage: 'publish',
    stage_order: ['research', 'strategy', 'production', 'publish'],
    stages: {
      research: stage('research', null),
      strategy: stage('strategy', null),
      production: stage('production', {
        stage: 'production',
        content_package: [
          {
            post_number: 1,
            theme: 'educational',
            hook: 'Hook one.',
            body: 'Body one.',
            cta: 'CTA one.',
            hashtags: ['#one', '#aries'],
            platforms: ['instagram', 'facebook'],
            format: 'single_image',
          },
          {
            post_number: 2,
            theme: 'trust',
            hook: 'Hook two.',
            body: 'Body two.',
            cta: 'CTA two.',
            hashtags: ['#two'],
            platforms: ['instagram'],
            format: 'single_image',
          },
        ],
      }),
      // Publish stage: the strategy-shaped output Hermes actually returns — no
      // publish_package, so the synthesizer must run.
      publish: stage('publish', { stage: 'strategy', content_package: [] }),
    },
    approvals: { current: null, history: [] },
    publish_config: { platforms: [], live_publish_platforms: [], video_render_platforms: [] },
    brand_kit: null,
    inputs: { request: {}, brand_url: 'https://example.com' },
    history: [],
    errors: [],
    last_error: null,
  } as unknown as MarketingJobRuntimeDocument;
}

const dbConfig = dbConfigFromEnv();

test('synthesizePublishPostsFromContentPackage creates draft posts against real Postgres', async (t) => {
  if (!dbConfig) {
    console.warn(
      '\n[synthesize-publish-posts-live-db] SKIPPED: DB_HOST/DB_PORT/DB_USER/' +
        'DB_PASSWORD/DB_NAME not all set. This test MUST run against a real ' +
        'database in CI/prod validation — a skip means the real posts insert ' +
        'path and partial unique index were never exercised.\n',
    );
    t.skip('database env not configured');
    return;
  }

  const pool = new pg.Pool(dbConfig);
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Seed a real tenant (posts/creative_assets FK organizations).
      const orgResult = await client.query<{ id: number }>(
        `INSERT INTO organizations (name) VALUES ($1) RETURNING id`,
        ['synthtest-tenant'],
      );
      const tenantId = orgResult.rows[0].id;
      const jobId = `mkt_synthtest_${Date.now()}`;

      // Seed two ingested creative_assets — the images post_number 1 and 2 map
      // to (1-indexed, source_asset_id order).
      for (const sourceAssetId of ['img_1', 'img_2']) {
        await client.query(
          `INSERT INTO creative_assets (
             tenant_id, source_type, source_job_id, source_asset_id,
             served_asset_ref, storage_kind, media_type, permission_scope,
             learning_lifecycle, usable_for_generation
           ) VALUES ($1, 'generated_by_aries', $2, $3, $4, 'runtime_asset', 'image', 'generated', 'observed', false)`,
          [tenantId, jobId, sourceAssetId, `/api/internal/hermes/media/${sourceAssetId}.png`],
        );
      }

      const doc = makeDoc(jobId, tenantId);

      // First synthesis: 2 content_package entries x platforms = 3 (post 1 IG+FB,
      // post 2 IG) draft posts.
      const first = await synthesizePublishPostsFromContentPackage({
        jobId,
        tenantId,
        doc,
        publishRunId: 'run_synthtest',
        pool: client,
      });
      assert.equal(first.total, 3, 'two posts -> three (post x platform) pairs');
      assert.equal(first.inserted, 3, 'all three draft posts inserted on first run');
      assert.equal(first.skipped, 0);

      const afterFirst = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM posts WHERE job_id = $1`,
        [jobId],
      );
      assert.equal(afterFirst.rows[0].count, '3', 'three posts rows persisted');

      // Verify row shape: draft status, hermes_run_id, creative_asset_ids linked.
      const rows = await client.query<{
        platform: string;
        status: string;
        published_status: string;
        hermes_run_id: string | null;
        caption: string;
        creative_asset_ids: string[];
      }>(
        `SELECT platform, status, published_status, hermes_run_id, caption, creative_asset_ids
           FROM posts WHERE job_id = $1 ORDER BY platform, id`,
        [jobId],
      );
      for (const row of rows.rows) {
        assert.equal(row.status, 'draft', 'synthesized post is draft');
        assert.equal(row.published_status, 'draft', 'synthesized post published_status is draft');
        assert.equal(row.hermes_run_id, 'run_synthtest', 'publish run id stored');
        assert.ok(row.caption.includes('Hook'), 'caption carries content_package copy');
        assert.equal(row.creative_asset_ids.length, 1, 'each post links exactly one creative asset');
        assert.ok(
          row.creative_asset_ids[0] === 'img_1' || row.creative_asset_ids[0] === 'img_2',
          'creative_asset_ids references a seeded asset',
        );
      }
      // post 1 -> img_1 on both platforms; post 2 -> img_2 on instagram.
      const igPost1 = rows.rows.find((r) => r.platform === 'facebook');
      assert.ok(igPost1 && igPost1.creative_asset_ids[0] === 'img_1', 'post 1 (facebook) linked to img_1');

      // Idempotency: replaying the exact same synthesis must create NO new rows.
      const second = await synthesizePublishPostsFromContentPackage({
        jobId,
        tenantId,
        doc,
        publishRunId: 'run_synthtest',
        pool: client,
      });
      assert.equal(second.total, 3);
      assert.equal(second.inserted, 0, 'replay inserts zero new rows');
      assert.equal(second.skipped, 3, 'replay sees all three as existing (ON CONFLICT DO NOTHING)');

      const afterSecond = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM posts WHERE job_id = $1`,
        [jobId],
      );
      assert.equal(afterSecond.rows[0].count, '3', 'still exactly three posts after replay');

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    console.log(
      '[synthesize-publish-posts-live-db] PASS: 3 draft posts synthesized, ' +
        'replay idempotent, all against real Postgres.',
    );
  } finally {
    await pool.end();
  }
});

test('synthesizePublishPostsFromContentPackage defers when a real publish_package is present', async (t) => {
  if (!dbConfig) {
    t.skip('database env not configured');
    return;
  }
  const pool = new pg.Pool(dbConfig);
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const orgResult = await client.query<{ id: number }>(
        `INSERT INTO organizations (name) VALUES ($1) RETURNING id`,
        ['synthtest-tenant-pp'],
      );
      const tenantId = orgResult.rows[0].id;
      const jobId = `mkt_synthtest_pp_${Date.now()}`;
      const doc = makeDoc(jobId, tenantId);
      // Inject a real publish_package — the legacy consumer owns this; the
      // synthesizer must no-op so the two paths never double-create posts.
      (doc.stages.publish as Record<string, unknown>).primary_output = {
        stage: 'publish',
        publish_package: { platform_previews: [{ platform_slug: 'instagram' }] },
      };

      const result = await synthesizePublishPostsFromContentPackage({
        jobId,
        tenantId,
        doc,
        publishRunId: 'run_synthtest_pp',
        pool: client,
      });
      assert.equal(result.reason, 'publish_package_present', 'synthesis deferred to legacy path');
      assert.equal(result.inserted, 0);

      const count = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM posts WHERE job_id = $1`,
        [jobId],
      );
      assert.equal(count.rows[0].count, '0', 'no posts synthesized when publish_package exists');

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
});
