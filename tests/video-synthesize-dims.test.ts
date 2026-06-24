/**
 * Slice 2 — synthesize-publish-posts copies width_px/height_px/duration_seconds
 * from the linked creative_asset DB row into the synthesized posts INSERT.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/video-synthesize-dims.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { synthesizePublishPostsFromContentPackage } from '../backend/marketing/synthesize-publish-posts';
import type { SocialContentJobRuntimeDocument } from '../backend/marketing/runtime-state';

// ---------------------------------------------------------------------------
// Helpers — mirrored from tests/synthesize-publish-posts-surface.test.ts
// ---------------------------------------------------------------------------

function stage(name: string, primaryOutput: unknown) {
  return {
    stage: name, status: 'completed', started_at: null, completed_at: null,
    failed_at: null, run_id: null, summary: null, primary_output: primaryOutput,
    outputs: {}, artifacts: [], errors: [],
  };
}

// Single-entry content_package so only 1 post is synthesized per test (1:1 dims check).
function makeDoc(jobId: string, schedule: unknown[]): SocialContentJobRuntimeDocument {
  return {
    schema_name: 'marketing_job_state_schema', schema_version: '1.0.0', job_id: jobId,
    tenant_id: '15', job_type: 'weekly_social_content', state: 'completed', status: 'completed',
    current_stage: 'publish',
    stages: {
      research: stage('research', null),
      strategy: stage('strategy', null),
      production: stage('production', {
        stage: 'production',
        content_package: [
          { post_number: 1, hook: 'H1', body: 'B1', cta: 'C1', hashtags: ['#a'], platforms: ['instagram'] },
        ],
      }),
      publish: stage('publish', { stage: 'publish', schedule }),
    },
    approvals: { current: null, history: [] },
    publish_config: { platforms: [], live_publish_platforms: [], video_render_platforms: [] },
    brand_kit: null, inputs: { request: {}, brand_url: 'https://example.com' },
    history: [], errors: [], last_error: null,
  } as unknown as SocialContentJobRuntimeDocument;
}

async function withDataRoot<T>(fn: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'synth-dims-'));
  const prev = process.env.DATA_ROOT;
  process.env.DATA_ROOT = dir;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

// Pool that returns creative_assets WITH video dims for the SELECT, and
// captures INSERT params.
function makeDimsPool(assetRows: unknown[]) {
  const inserts: unknown[][] = [];
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      if (/INSERT INTO posts/i.test(sql)) {
        inserts.push(params);
        return { rows: [{ id: inserts.length }], rowCount: 1 };
      }
      if (/FROM creative_assets/i.test(sql)) {
        return { rows: assetRows, rowCount: assetRows.length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { pool, inserts };
}

// ---------------------------------------------------------------------------
// Slice 2 — dims thread from creative_asset → posts INSERT
// ---------------------------------------------------------------------------

test('dims: synthesized post copies width/height/duration from linked creative_asset (flag ON)', async () => {
  // FAIL BEFORE: SELECT_CREATIVE_ASSETS_SQL didn't include width_px/height_px/duration_seconds,
  //   so the AssetInfo had null dims and params[11..13] were always null.
  // PASS AFTER:  SELECT includes dims; they are threaded into $12/$13/$14.
  await withDataRoot(async () => {
    const prevFlag = process.env.ARIES_VIDEO_PUBLISH_ENABLED;
    process.env.ARIES_VIDEO_PUBLISH_ENABLED = '1';
    const { pool, inserts } = makeDimsPool([
      // post_number 1 → reel asset with dims
      { id: 'uuid-vid1', source_asset_id: 'vid_1', width_px: 1080, height_px: 1920, duration_seconds: 15 },
    ]);
    const schedule = [
      { post_number: 1, platforms: ['instagram'], placement: 'reel', media_type: 'video' },
    ];
    try {
      await synthesizePublishPostsFromContentPackage({
        jobId: 'job_dims_on', tenantId: 15, doc: makeDoc('job_dims_on', schedule), publishRunId: null, pool,
      });
    } finally {
      if (prevFlag === undefined) delete process.env.ARIES_VIDEO_PUBLISH_ENABLED;
      else process.env.ARIES_VIDEO_PUBLISH_ENABLED = prevFlag;
    }

    assert.equal(inserts.length, 1, 'one reel post inserted');
    const p = inserts[0]!;
    // INSERT param positions (0-based):
    // [0]=tenantId [1]=jobId [2]=publishRunId [3]=platform [4]=caption
    // [5]=idempotencyKey [6]=creativeAssetIds [7]=mediaType [8]=surface
    // [9]=styleDimension [10]=styleValue [11]=widthPx [12]=heightPx [13]=durationSeconds
    assert.equal(p[11], 1080, '$12 widthPx must be 1080 from creative_asset');
    assert.equal(p[12], 1920, '$13 heightPx must be 1920 from creative_asset');
    assert.equal(p[13], 15, '$14 durationSeconds must be 15 from creative_asset');
    assert.equal(p[7], 'video', 'media_type must be video');
    assert.equal(p[8], 'reel', 'surface must be reel');
  });
});

test('dims: feed image post has null dims when creative_asset has no dims', async () => {
  await withDataRoot(async () => {
    const { pool, inserts } = makeDimsPool([
      // feed image asset: width_px/height_px/duration_seconds are null
      { id: 'uuid-img1', source_asset_id: 'img_1', width_px: null, height_px: null, duration_seconds: null },
    ]);
    const schedule = [
      { post_number: 1, platforms: ['instagram'], placement: 'feed', media_type: 'image' },
    ];
    delete process.env.ARIES_VIDEO_PUBLISH_ENABLED;
    await synthesizePublishPostsFromContentPackage({
      jobId: 'job_null_dims', tenantId: 15, doc: makeDoc('job_null_dims', schedule), publishRunId: null, pool,
    });

    assert.equal(inserts.length, 1);
    const p = inserts[0]!;
    assert.equal(p[11], null, '$12 widthPx null when asset has no dims');
    assert.equal(p[12], null, '$13 heightPx null');
    assert.equal(p[13], null, '$14 durationSeconds null');
  });
});

test('dims: story insert (composed story path) always has null dims in this pass', async () => {
  // The story path passes null for dims (composed story images don't carry dims
  // from the base asset in this slice).
  await withDataRoot(async () => {
    delete process.env.ARIES_VIDEO_PUBLISH_ENABLED;
    const { pool, inserts } = makeDimsPool([
      // Two feed assets so story promotion can link a creative.
      { id: 'uuid-1', source_asset_id: 'img_1', width_px: 800, height_px: 1000, duration_seconds: null },
      { id: 'uuid-2', source_asset_id: 'img_2', width_px: 800, height_px: 1000, duration_seconds: null },
    ]);

    const schedule = [
      { post_number: 1, platforms: ['instagram'], placement: 'feed', media_type: 'image' },
      { post_number: 2, platforms: ['instagram'], placement: 'feed', media_type: 'image' },
    ];
    // Use storyCount=1 so a story is promoted from the first entry.
    const doc = makeDoc('job_story_dims', schedule) as unknown as { inputs: { request: Record<string, unknown> } };
    (doc as unknown as { inputs: { request: Record<string, unknown> } }).inputs.request = { scope: { story_count: 1 } };

    await synthesizePublishPostsFromContentPackage({
      jobId: 'job_story_dims',
      tenantId: 15,
      doc: doc as unknown as SocialContentJobRuntimeDocument,
      publishRunId: null,
      pool,
    });

    const storyInsert = inserts.find((p) => p[8] === 'story');
    assert.ok(storyInsert, 'story post inserted');
    // Story posts always have null dims in this pass (composed story images).
    assert.equal(storyInsert![11], null, 'story widthPx null');
    assert.equal(storyInsert![12], null, 'story heightPx null');
    assert.equal(storyInsert![13], null, 'story durationSeconds null');
  });
});

test('dims: creative_asset with integer dims is faithfully passed through', async () => {
  await withDataRoot(async () => {
    process.env.ARIES_VIDEO_PUBLISH_ENABLED = '1';
    const { pool, inserts } = makeDimsPool([
      // Exact dims from Hermes Veo contract
      { id: 'uuid-v', source_asset_id: 'vid_1', width_px: 720, height_px: 1280, duration_seconds: 7.5 },
    ]);
    const schedule = [
      { post_number: 1, platforms: ['instagram'], placement: 'reel', media_type: 'video' },
    ];
    try {
      await synthesizePublishPostsFromContentPackage({
        jobId: 'job_exact', tenantId: 15, doc: makeDoc('job_exact', schedule), publishRunId: null, pool,
      });
    } finally {
      delete process.env.ARIES_VIDEO_PUBLISH_ENABLED;
    }

    assert.equal(inserts.length, 1);
    assert.equal(inserts[0]![11], 720);
    assert.equal(inserts[0]![12], 1280);
    assert.equal(inserts[0]![13], 7.5, 'fractional duration preserved');
  });
});
