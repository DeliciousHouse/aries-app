import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { synthesizePublishPostsFromContentPackage } from '../backend/marketing/synthesize-publish-posts';
import type { SocialContentJobRuntimeDocument } from '../backend/marketing/runtime-state';

// Fake pool capturing INSERT params; SELECT creative_assets returns none.
function makeFakePool() {
  const inserts: unknown[][] = [];
  return {
    inserts,
    pool: {
      async query(sql: string, params: unknown[] = []) {
        if (/INSERT INTO posts/i.test(sql)) {
          inserts.push(params);
          return { rows: [{ id: inserts.length }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    },
  };
}

function stage(name: string, primaryOutput: unknown) {
  return {
    stage: name, status: 'completed', started_at: null, completed_at: null,
    failed_at: null, run_id: null, summary: null, primary_output: primaryOutput,
    outputs: {}, artifacts: [], errors: [],
  };
}

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
          { post_number: 2, hook: 'H2', body: 'B2', cta: 'C2', hashtags: ['#b'], platforms: ['instagram'] },
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

const SCHEDULE = [
  { post_number: 1, platforms: ['instagram'], placement: 'feed', media_type: 'image' },
  { post_number: 2, platforms: ['instagram'], placement: 'reel', media_type: 'video' },
];

async function withDataRoot<T>(fn: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'synth-surface-'));
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

test('flag OFF: reel/video entries are stripped; only feed/image persists with 4-segment surface key', async () => {
  await withDataRoot(async () => {
    delete process.env.ARIES_VIDEO_PUBLISH_ENABLED;
    const { pool, inserts } = makeFakePool();
    const result = await synthesizePublishPostsFromContentPackage({
      jobId: 'job_off', tenantId: 15, doc: makeDoc('job_off', SCHEDULE), publishRunId: null, pool,
    });
    assert.equal(inserts.length, 1, 'only the feed/image post is inserted');
    // INSERT params: [tenant, job, runId, platform, caption, idempotencyKey, assetIds, mediaType, surface]
    const params = inserts[0];
    assert.equal(params[5], 'job_off:1:instagram:feed');
    assert.equal(params[7], 'image');
    assert.equal(params[8], 'feed');
    assert.ok(result.inserted >= 1);
  });
});

test('flag ON: reel/video entry persists with 4-segment key + video/reel shape', async () => {
  await withDataRoot(async () => {
    process.env.ARIES_VIDEO_PUBLISH_ENABLED = '1';
    const { pool, inserts } = makeFakePool();
    try {
      await synthesizePublishPostsFromContentPackage({
        jobId: 'job_on', tenantId: 15, doc: makeDoc('job_on', SCHEDULE), publishRunId: null, pool,
      });
    } finally {
      delete process.env.ARIES_VIDEO_PUBLISH_ENABLED;
    }
    assert.equal(inserts.length, 2);
    const reel = inserts.find((p) => p[8] === 'reel');
    assert.ok(reel, 'reel post inserted');
    assert.equal(reel![5], 'job_on:2:instagram:reel');
    assert.equal(reel![7], 'video');
  });
});

// Fake pool that ALSO returns ingested creative assets for the SELECT so story
// auto-promotion can link a creative (a story is single-media; entries with no
// linked creative are skipped).
function makeFakePoolWithAssets() {
  const inserts: unknown[][] = [];
  return {
    inserts,
    pool: {
      async query(sql: string, params: unknown[] = []) {
        if (/INSERT INTO posts/i.test(sql)) {
          inserts.push(params);
          return { rows: [{ id: inserts.length }], rowCount: 1 };
        }
        if (/FROM creative_assets/i.test(sql)) {
          // index+1 => post_number; source_asset_id is what synthesize links.
          return { rows: [{ id: 'uuid-1', source_asset_id: 'img_1' }, { id: 'uuid-2', source_asset_id: 'img_2' }], rowCount: 2 };
        }
        return { rows: [], rowCount: 0 };
      },
    },
  };
}

function makeDocWithStoryBudget(jobId: string, schedule: unknown[], storyCount: number): SocialContentJobRuntimeDocument {
  const doc = makeDoc(jobId, schedule) as unknown as { inputs: { request: Record<string, unknown> } };
  doc.inputs.request = { scope: { story_count: storyCount } };
  return doc as unknown as SocialContentJobRuntimeDocument;
}

const ALL_FEED_SCHEDULE = [
  { post_number: 1, platforms: ['instagram'], placement: 'feed', media_type: 'image' },
  { post_number: 2, platforms: ['instagram'], placement: 'feed', media_type: 'image' },
];

test('story_count default 0: no story posts synthesized (feed-only unchanged)', async () => {
  await withDataRoot(async () => {
    delete process.env.ARIES_VIDEO_PUBLISH_ENABLED;
    const { pool, inserts } = makeFakePoolWithAssets();
    await synthesizePublishPostsFromContentPackage({
      jobId: 'job_nostory', tenantId: 15, doc: makeDoc('job_nostory', ALL_FEED_SCHEDULE), publishRunId: null, pool,
    });
    assert.equal(inserts.length, 2, 'only the two feed posts');
    assert.ok(inserts.every((p) => p[8] === 'feed'), 'no story surface inserted');
  });
});

test('story_count > 0: first N entries also promoted to live image-story posts', async () => {
  await withDataRoot(async () => {
    delete process.env.ARIES_VIDEO_PUBLISH_ENABLED;
    const { pool, inserts } = makeFakePoolWithAssets();
    const result = await synthesizePublishPostsFromContentPackage({
      jobId: 'job_story', tenantId: 15, doc: makeDocWithStoryBudget('job_story', ALL_FEED_SCHEDULE, 1), publishRunId: null, pool,
    });
    // 2 feed posts + 1 promoted story (first entry, instagram).
    assert.equal(inserts.length, 3);
    const story = inserts.find((p) => p[8] === 'story');
    assert.ok(story, 'story post inserted');
    assert.equal(story![5], 'job_story:1:instagram:story', '4-segment :story key, distinct from :feed');
    assert.equal(story![7], 'image', 'image media_type');
    assert.deepEqual(story![6], ['img_1'], 'story reuses the first entry creative');
    // The feed post for the same (post,platform) still exists — distinct key.
    assert.ok(inserts.some((p) => p[5] === 'job_story:1:instagram:feed'), 'feed post coexists');
    assert.ok(result.inserted >= 3);
  });
});

test('story_count > 0 with composer: story post is backed by the COMPOSED asset', async () => {
  await withDataRoot(async () => {
    delete process.env.ARIES_VIDEO_PUBLISH_ENABLED;
    const { pool, inserts } = makeFakePoolWithAssets();
    const composeCalls: Array<{ baseAssetId: string; headline: string }> = [];
    await synthesizePublishPostsFromContentPackage({
      jobId: 'job_compose', tenantId: 15, doc: makeDocWithStoryBudget('job_compose', ALL_FEED_SCHEDULE, 1), publishRunId: null, pool,
      composeStoryAsset: async ({ baseAssetId, headline }) => {
        composeCalls.push({ baseAssetId, headline });
        return 'composed-asset-uuid';
      },
    });
    const story = inserts.find((p) => p[8] === 'story');
    assert.ok(story, 'story post inserted');
    assert.deepEqual(story![6], ['composed-asset-uuid'], 'story uses composed asset, not raw img_1');
    assert.equal(composeCalls.length, 1, 'composed once per entry (reused across platforms)');
    assert.equal(composeCalls[0].baseAssetId, 'img_1');
    // Feed post is unaffected — still the raw creative.
    const feed = inserts.find((p) => p[5] === 'job_compose:1:instagram:feed');
    assert.deepEqual(feed![6], ['img_1'], 'feed still uses the raw creative');
  });
});

test('story composer that returns null falls back to the raw creative', async () => {
  await withDataRoot(async () => {
    delete process.env.ARIES_VIDEO_PUBLISH_ENABLED;
    const { pool, inserts } = makeFakePoolWithAssets();
    await synthesizePublishPostsFromContentPackage({
      jobId: 'job_fallback', tenantId: 15, doc: makeDocWithStoryBudget('job_fallback', ALL_FEED_SCHEDULE, 1), publishRunId: null, pool,
      composeStoryAsset: async () => null,
    });
    const story = inserts.find((p) => p[8] === 'story');
    assert.deepEqual(story![6], ['img_1'], 'falls back to raw creative when composition fails');
  });
});

// ---------------------------------------------------------------------------
// content_package fallback — when the separate publish stage emits no schedule,
// a reel/video shape stamped by the production skills on the content_package
// entry still synthesizes a reel post (the publish-stage-regression fix).
// ---------------------------------------------------------------------------

function makeDocCpPlacement(jobId: string): SocialContentJobRuntimeDocument {
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
          { post_number: 1, hook: 'H1', body: 'B1', cta: 'C1', hashtags: ['#a'], platforms: ['instagram'], placement: 'feed', media_type: 'image' },
          { post_number: 2, hook: 'H2', body: 'B2', cta: 'C2', hashtags: ['#b'], platforms: ['instagram'], placement: 'reel', media_type: 'video' },
        ],
      }),
      // EMPTY publish schedule — the separate publish-stage regression.
      publish: stage('publish', { stage: 'publish', schedule: [] }),
    },
    approvals: { current: null, history: [] },
    publish_config: { platforms: [], live_publish_platforms: [], video_render_platforms: [] },
    brand_kit: null, inputs: { request: {}, brand_url: 'https://example.com' },
    history: [], errors: [], last_error: null,
  } as unknown as SocialContentJobRuntimeDocument;
}

test('content_package fallback (flag ON): reel entry synthesizes a video post when publish schedule is empty', async () => {
  await withDataRoot(async () => {
    process.env.ARIES_VIDEO_PUBLISH_ENABLED = '1';
    const { pool, inserts } = makeFakePoolWithAssets();
    try {
      await synthesizePublishPostsFromContentPackage({
        jobId: 'job_cp_reel', tenantId: 15, doc: makeDocCpPlacement('job_cp_reel'), publishRunId: null, pool,
      });
    } finally {
      delete process.env.ARIES_VIDEO_PUBLISH_ENABLED;
    }
    const reel = inserts.find((p) => p[8] === 'reel');
    assert.ok(reel, 'reel post synthesized from content_package placement (no publish schedule)');
    assert.equal(reel![7], 'video', 'reel post is video');
    assert.equal(reel![5], 'job_cp_reel:2:instagram:reel', '4-segment :reel idempotency key');
    const feed = inserts.find((p) => p[8] === 'feed');
    assert.ok(feed, 'feed image post still synthesized alongside the reel');
    assert.equal(feed![7], 'image');
  });
});

test('content_package fallback (flag OFF): reel entry is stripped, only the feed image persists', async () => {
  await withDataRoot(async () => {
    delete process.env.ARIES_VIDEO_PUBLISH_ENABLED;
    const { pool, inserts } = makeFakePoolWithAssets();
    await synthesizePublishPostsFromContentPackage({
      jobId: 'job_cp_off', tenantId: 15, doc: makeDocCpPlacement('job_cp_off'), publishRunId: null, pool,
    });
    assert.ok(!inserts.some((p) => p[8] === 'reel'), 'no reel post when ARIES_VIDEO_PUBLISH_ENABLED is off');
    assert.ok(inserts.some((p) => p[8] === 'feed'), 'feed image post still persists');
  });
});
