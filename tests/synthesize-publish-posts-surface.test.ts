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

// ---------------------------------------------------------------------------
// Weekly cross-post fan-out (producer side). When enabled, each FB/IG feed
// image also produces x/linkedin/reddit rows with adapted captions; story/reel
// entries never fan out; flag OFF is byte-identical.
// ---------------------------------------------------------------------------

// Fake pool that ALSO answers the connected_accounts crosspost query so the
// resolver can return connected platforms. `connectedPlatforms` controls which
// rows come back for that SELECT.
function makeFakePoolWithCrosspost(connectedPlatforms: string[]) {
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
          return { rows: [{ id: 'uuid-1', source_asset_id: 'img_1' }, { id: 'uuid-2', source_asset_id: 'img_2' }], rowCount: 2 };
        }
        if (/FROM connected_accounts/i.test(sql)) {
          // $2 is the flag-enabled platform allowlist; intersect with connected.
          const allowlist = (params[1] as string[]) ?? [];
          const rows = connectedPlatforms
            .filter((p) => allowlist.includes(p))
            .map((platform) => ({ platform }));
          return { rows, rowCount: rows.length };
        }
        return { rows: [], rowCount: 0 };
      },
    },
  };
}

const CROSSPOST_FLAGS = ['ARIES_WEEKLY_CROSSPOST_ENABLED', 'ARIES_X_ENABLED', 'ARIES_LINKEDIN_ENABLED', 'ARIES_REDDIT_ENABLED'] as const;

function withCrosspostFlagsOn(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const prev = CROSSPOST_FLAGS.map((k) => [k, process.env[k]] as const);
    for (const k of CROSSPOST_FLAGS) process.env[k] = '1';
    try {
      await fn();
    } finally {
      for (const [k, v] of prev) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };
}

// A feed-only content_package where post 1 targets instagram (feed image).
function makeDocFeed(jobId: string): SocialContentJobRuntimeDocument {
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
          { post_number: 1, hook: 'Big news today.', body: 'The full body copy here.', cta: 'Shop now.', hashtags: ['#one', '#two', '#three'], platforms: ['instagram'] },
        ],
      }),
      publish: stage('publish', {
        stage: 'publish',
        schedule: [{ post_number: 1, platforms: ['instagram'], placement: 'feed', media_type: 'image' }],
      }),
    },
    approvals: { current: null, history: [] },
    publish_config: { platforms: [], live_publish_platforms: [], video_render_platforms: [] },
    brand_kit: null, inputs: { request: {}, brand_url: 'https://example.com' },
    history: [], errors: [], last_error: null,
  } as unknown as SocialContentJobRuntimeDocument;
}

test('crosspost ON: a feed image fans out x/linkedin/reddit rows with adapted captions + :feed keys', withCrosspostFlagsOn(async () => {
  await withDataRoot(async () => {
    delete process.env.ARIES_VIDEO_PUBLISH_ENABLED;
    const { pool, inserts } = makeFakePoolWithCrosspost(['x', 'linkedin', 'reddit']);
    await synthesizePublishPostsFromContentPackage({
      jobId: 'job_xp', tenantId: 15, doc: makeDocFeed('job_xp'), publishRunId: null, pool,
    });
    // 1 IG feed row + 3 crosspost rows.
    assert.equal(inserts.length, 4);
    const byPlatform = new Map(inserts.map((p) => [p[3] as string, p]));
    assert.ok(byPlatform.has('instagram'), 'IG feed row exists');
    for (const platform of ['x', 'linkedin', 'reddit']) {
      const row = byPlatform.get(platform);
      assert.ok(row, `${platform} crosspost row exists`);
      assert.equal(row![5], `job_xp:1:${platform}:feed`, `${platform} 4-segment :feed idempotency key`);
      assert.equal(row![8], 'feed', `${platform} surface feed`);
      assert.equal(row![7], 'image', `${platform} media_type image`);
      assert.deepEqual(row![6], ['img_1'], `${platform} reuses the same feed image`);
    }
    // X caption is adapted (hook + up to 2 hashtags), distinct from the IG caption.
    assert.equal(byPlatform.get('x')![5 - 0], 'job_xp:1:x:feed');
    assert.ok((byPlatform.get('x')![4] as string).includes('Big news today.'), 'x caption keeps the hook');
    assert.ok((byPlatform.get('x')![4] as string).includes('#one'), 'x caption keeps a hashtag');
    // Reddit caption serializes a clean first-line title.
    assert.equal((byPlatform.get('reddit')![4] as string).split('\n')[0], 'Big news today.');
  });
}));

test('crosspost ON but only reddit connected: only the reddit row is added', withCrosspostFlagsOn(async () => {
  await withDataRoot(async () => {
    delete process.env.ARIES_VIDEO_PUBLISH_ENABLED;
    const { pool, inserts } = makeFakePoolWithCrosspost(['reddit']);
    await synthesizePublishPostsFromContentPackage({
      jobId: 'job_xp1', tenantId: 15, doc: makeDocFeed('job_xp1'), publishRunId: null, pool,
    });
    // 1 IG feed + 1 reddit crosspost.
    assert.equal(inserts.length, 2);
    const platforms = inserts.map((p) => p[3]);
    assert.deepEqual(platforms.sort(), ['instagram', 'reddit']);
  });
}));

test('crosspost ON: story/reel entries produce NO crosspost rows', withCrosspostFlagsOn(async () => {
  await withDataRoot(async () => {
    process.env.ARIES_VIDEO_PUBLISH_ENABLED = '1';
    const { pool, inserts } = makeFakePoolWithCrosspost(['x', 'linkedin', 'reddit']);
    try {
      // makeDocCpPlacement: post 2 is a reel (video). Post 1 is feed image.
      await synthesizePublishPostsFromContentPackage({
        jobId: 'job_xp_reel', tenantId: 15, doc: makeDocCpPlacement('job_xp_reel'), publishRunId: null, pool,
      });
    } finally {
      delete process.env.ARIES_VIDEO_PUBLISH_ENABLED;
    }
    // Crosspost rows only for the feed image (post 1), never the reel (post 2).
    const crosspostRows = inserts.filter((p) => ['x', 'linkedin', 'reddit'].includes(p[3] as string));
    assert.ok(crosspostRows.length > 0, 'feed image fans out');
    assert.ok(crosspostRows.every((p) => p[5]?.toString().startsWith('job_xp_reel:1:')), 'only post 1 (feed image) fans out, never the reel post 2');
    assert.ok(crosspostRows.every((p) => p[8] === 'feed'), 'all crosspost rows are feed surface');
  });
}));

test('crosspost OFF (flag unset): synthesis is byte-identical — FB/IG rows only (golden)', async () => {
  await withDataRoot(async () => {
    delete process.env.ARIES_VIDEO_PUBLISH_ENABLED;
    // Even with per-platform flags on + accounts connected, the master flag OFF
    // means no fan-out and no connected_accounts query.
    for (const k of ['ARIES_X_ENABLED', 'ARIES_LINKEDIN_ENABLED', 'ARIES_REDDIT_ENABLED']) process.env[k] = '1';
    delete process.env.ARIES_WEEKLY_CROSSPOST_ENABLED;
    let connectedAccountsQueried = false;
    const inserts: unknown[][] = [];
    const pool = {
      async query(sql: string, params: unknown[] = []) {
        if (/FROM connected_accounts/i.test(sql)) connectedAccountsQueried = true;
        if (/INSERT INTO posts/i.test(sql)) { inserts.push(params); return { rows: [{ id: inserts.length }], rowCount: 1 }; }
        if (/FROM creative_assets/i.test(sql)) return { rows: [{ id: 'uuid-1', source_asset_id: 'img_1' }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    };
    try {
      await synthesizePublishPostsFromContentPackage({
        jobId: 'job_xp_off', tenantId: 15, doc: makeDocFeed('job_xp_off'), publishRunId: null, pool,
      });
    } finally {
      for (const k of ['ARIES_X_ENABLED', 'ARIES_LINKEDIN_ENABLED', 'ARIES_REDDIT_ENABLED']) delete process.env[k];
    }
    assert.equal(inserts.length, 1, 'only the IG feed row — no crosspost fan-out');
    assert.equal(inserts[0][3], 'instagram');
    assert.equal(connectedAccountsQueried, false, 'no connected_accounts query when the master flag is OFF');
  });
});
