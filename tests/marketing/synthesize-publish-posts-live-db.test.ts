import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import pg from 'pg';

import { synthesizePublishPostsFromContentPackage } from '../../backend/marketing/synthesize-publish-posts';
import { findLatestMarketingApprovalRecord } from '../../backend/marketing/approval-store';
import { UNSCHEDULED_POSTS_QUERY } from '../../app/api/social-content/scheduled-posts/route';
import type { MarketingJobRuntimeDocument } from '../../backend/marketing/runtime-state';

// Real-Postgres regression test for the publish-posts synthesizer.
//
// This proves the Cause 2 fix end to end: a completed Hermes publish stage
// carrying a `content_package` (and ingested `creative_assets`) must produce
// real APPROVED `posts` rows that (a) are returned by the calendar's
// unscheduled-approved backlog query and (b) pass the schedule route's
// publish-approval gate — so a completed pipeline populates the calendar and
// the posts are schedulable with no manual approval click.
//
// A mock pool cannot catch this: it relies on the live `posts` schema (the
// partial unique index powering ON CONFLICT DO NOTHING, the status CHECK
// constraints) and the real backlog query. The approval-record half is
// file-backed, so the test points DATA_ROOT at a temp dir.
//
// The posts/creative_assets work runs inside a transaction that is always
// rolled back; the approval record lives under the temp DATA_ROOT which is
// removed in teardown. When DB env is absent the test skips loudly.

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
    job_type: 'weekly_social_content',
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

test('synthesized publish posts are approved, calendar-visible, and pass the publish gate', async (t) => {
  if (!dbConfig) {
    console.warn(
      '\n[synthesize-publish-posts-live-db] SKIPPED: DB_HOST/DB_PORT/DB_USER/' +
        'DB_PASSWORD/DB_NAME not all set. This test MUST run against a real ' +
        'database in CI/prod validation — a skip means the real posts insert ' +
        'path, partial unique index, and backlog query were never exercised.\n',
    );
    t.skip('database env not configured');
    return;
  }

  // The approval record is file-backed; isolate it under a temp DATA_ROOT.
  const prevDataRoot = process.env.DATA_ROOT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-synth-publish-'));
  process.env.DATA_ROOT = dataRoot;

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

      // Seed two ingested creative_assets — post_number 1 and 2 map to them
      // (1-indexed, source_asset_id order).
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
      // post 2 IG) approved posts.
      const first = await synthesizePublishPostsFromContentPackage({
        jobId,
        tenantId,
        doc,
        publishRunId: 'run_synthtest',
        pool: client,
      });
      assert.equal(first.total, 3, 'two posts -> three (post x platform) pairs');
      assert.equal(first.inserted, 3, 'all three posts inserted on first run');
      assert.equal(first.skipped, 0);
      assert.equal(first.approvalRecordReady, true, 'publish approval record synthesized');

      // (a) Every synthesized post is approved on BOTH status columns.
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
      assert.equal(rows.rows.length, 3, 'three posts rows persisted');
      for (const row of rows.rows) {
        assert.equal(row.status, 'approved', 'synthesized post status is approved');
        assert.equal(row.published_status, 'approved', 'synthesized post published_status is approved');
        assert.equal(row.hermes_run_id, 'run_synthtest', 'publish run id stored');
        assert.ok(row.caption.includes('Hook'), 'caption carries content_package copy');
        assert.equal(row.creative_asset_ids.length, 1, 'each post links exactly one creative asset');
      }
      const fbPost1 = rows.rows.find((r) => r.platform === 'facebook');
      assert.ok(fbPost1 && fbPost1.creative_asset_ids[0] === 'img_1', 'post 1 (facebook) linked to img_1');

      // (b) The REAL calendar unscheduled-approved backlog query returns all 3.
      // This is the exact SQL the /api/social-content/scheduled-posts route runs.
      const backlog = await client.query<{ id: string | number; job_id: string }>(
        UNSCHEDULED_POSTS_QUERY,
        [tenantId],
      );
      const backlogForJob = backlog.rows.filter((r) => r.job_id === jobId);
      assert.equal(
        backlogForJob.length,
        3,
        'all three synthesized posts appear in the calendar unscheduled-approved backlog',
      );

      // (c) The schedule route's publish-approval gate passes. The route gates
      // on findLatestMarketingApprovalRecord(stage='publish', status='approved')
      // — exercise that exact resolver.
      const gateRecord = findLatestMarketingApprovalRecord({
        marketingJobId: jobId,
        tenantId: String(tenantId),
        marketingStage: 'publish',
        statuses: ['approved'],
      });
      assert.ok(gateRecord, 'an approved publish-stage approval record exists');
      assert.equal(gateRecord!.marketing_stage, 'publish');
      assert.equal(gateRecord!.status, 'approved');
      assert.equal(gateRecord!.marketing_job_id, jobId);

      // Idempotency: replaying the exact same synthesis creates NO new posts and
      // no duplicate approval record.
      const second = await synthesizePublishPostsFromContentPackage({
        jobId,
        tenantId,
        doc,
        publishRunId: 'run_synthtest',
        pool: client,
      });
      assert.equal(second.total, 3);
      assert.equal(second.inserted, 0, 'replay inserts zero new posts');
      assert.equal(second.skipped, 3, 'replay sees all three as existing (ON CONFLICT DO NOTHING)');
      assert.equal(second.approvalRecordReady, true, 'replay still reports approval ready');

      const afterReplay = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM posts WHERE job_id = $1`,
        [jobId],
      );
      assert.equal(afterReplay.rows[0].count, '3', 'still exactly three posts after replay');

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    console.log(
      '[synthesize-publish-posts-live-db] PASS: 3 approved posts synthesized, ' +
        'visible in the calendar backlog query, publish gate passes, replay ' +
        'idempotent — all against real Postgres.',
    );
  } finally {
    await pool.end();
    if (prevDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = prevDataRoot;
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('synthesizePublishPostsFromContentPackage defers when a CONSUMABLE publish_package is present', async (t) => {
  if (!dbConfig) {
    t.skip('database env not configured');
    return;
  }
  const prevDataRoot = process.env.DATA_ROOT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-synth-publish-pp-'));
  process.env.DATA_ROOT = dataRoot;

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
      // Inject a CONSUMABLE publish_package (has platform_previews) — the legacy
      // dashboard consumer owns this; the synthesizer must no-op so the two
      // paths never double-create posts.
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
      assert.equal(result.approvalRecordReady, false, 'no approval record synthesized when deferring');

      const count = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM posts WHERE job_id = $1`,
        [jobId],
      );
      assert.equal(count.rows[0].count, '0', 'no posts synthesized when a consumable publish_package exists');

      // No publish approval record should have been written either.
      const record = findLatestMarketingApprovalRecord({
        marketingJobId: jobId,
        tenantId: String(tenantId),
        marketingStage: 'publish',
        statuses: ['approved'],
      });
      assert.equal(record, null, 'no approval record synthesized for the publish_package path');

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
    if (prevDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = prevDataRoot;
    await rm(dataRoot, { recursive: true, force: true });
  }
});

// Cause 3 regression: the Hermes publish agent commonly returns a THIN,
// plan-only publish_package (approval_gate / cadence / schedule, no
// platform_previews / posts / media). The old scope guard deferred on the mere
// presence of a publish_package key, so the synthesizer produced nothing and
// nothing reached the calendar. A thin publish_package must NOT block synthesis.
test('synthesizePublishPostsFromContentPackage does NOT defer for a thin plan-only publish_package', async (t) => {
  if (!dbConfig) {
    t.skip('database env not configured');
    return;
  }
  const prevDataRoot = process.env.DATA_ROOT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-synth-publish-thin-'));
  process.env.DATA_ROOT = dataRoot;

  const pool = new pg.Pool(dbConfig);
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const orgResult = await client.query<{ id: number }>(
        `INSERT INTO organizations (name) VALUES ($1) RETURNING id`,
        ['synthtest-tenant-thin'],
      );
      const tenantId = orgResult.rows[0].id;
      const jobId = `mkt_synthtest_thin_${Date.now()}`;
      const doc = makeDoc(jobId, tenantId);
      // The exact thin shape Hermes returned for the Cause 3 reproduction
      // (mkt_37933254): a scheduling plan with NO platform_previews / posts /
      // content_calendar — nothing the legacy consumer can turn into posts.
      (doc.stages.publish as Record<string, unknown>).primary_output = {
        stage: 'publish',
        status: 'approved_for_publishing',
        publish_package: {
          approval_gate: 'approved',
          cadence: 'one post per day for 7 days',
          platforms: ['instagram', 'facebook'],
          publishing_notes: ['Use only the approved captions.'],
          schedule: [{ day: 'Monday', post_number: 1, theme: 'planning', publish_status: 'cleared' }],
          risk_controls: [],
        },
      };

      const result = await synthesizePublishPostsFromContentPackage({
        jobId,
        tenantId,
        doc,
        publishRunId: 'run_synthtest_thin',
        pool: client,
      });
      assert.notEqual(
        result.reason,
        'publish_package_present',
        'a thin plan-only publish_package must NOT trigger the scope guard',
      );
      assert.equal(result.inserted, 3, 'synthesizer ran and created posts despite the thin publish_package');
      assert.equal(result.approvalRecordReady, true, 'publish approval record synthesized');

      const count = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM posts WHERE job_id = $1`,
        [jobId],
      );
      assert.equal(count.rows[0].count, '3', 'three posts synthesized for the thin-publish_package job');

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
    if (prevDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = prevDataRoot;
    await rm(dataRoot, { recursive: true, force: true });
  }
});
