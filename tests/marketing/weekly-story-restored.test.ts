// AA-222 regression: the weekly package must include the story, and a promised
// surface that yields nothing must be LOUD.
//
// The drop point was `startSocialContentJob`: the manual intake route runs its
// payload through `normalizeWeeklySocialContentPayload` (which stamps
// storyCount from DEFAULT_SOCIAL_CONTENT_COUNTS), the worker weekly trigger did
// not. The worker payload carries only brandUrl/websiteUrl/businessType/
// publishRequested, so the persisted `doc.inputs.request` had no storyCount at
// all, `readRequestedStoryCount` fell through to its defensive 0, and the run
// synthesized zero story rows — while SOCIAL_CONTENT_DEFAULT_SCOPE promised 1.
// Nothing logged it. Nothing recorded it on the run doc.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { prepareStartJobPayload } from '../../backend/marketing/orchestrator';
import { synthesizePublishPostsFromContentPackage } from '../../backend/marketing/synthesize-publish-posts';
import type { SocialContentJobRuntimeDocument } from '../../backend/marketing/runtime-state';

async function withDataRoot<T>(fn: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'aries-weekly-story-'));
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

async function withCapturedError<T>(run: () => Promise<T>): Promise<{ value: T; errors: unknown[][] }> {
  const original = console.error;
  const errors: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    const value = await run();
    return { value, errors };
  } finally {
    console.error = original;
  }
}

function storyShortfallErrors(errors: unknown[][]): Record<string, unknown>[] {
  return errors
    .filter((args) => String(args[0]).includes('story promised but zero story rows synthesized'))
    .map((args) => (args[1] ?? {}) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// prepareStartJobPayload — the exact seam where the story was lost
// ---------------------------------------------------------------------------

// backend/marketing/weekly-trigger.ts builds precisely this and nothing more.
const WORKER_WEEKLY_PAYLOAD = {
  brandUrl: 'https://brand.example/',
  websiteUrl: 'https://brand.example/',
  businessType: 'retail',
  publishRequested: true,
};

test('prepareStartJobPayload: the worker weekly payload gains storyCount 1', async () => {
  const prepared = prepareStartJobPayload('weekly_social_content', { ...WORKER_WEEKLY_PAYLOAD });
  assert.equal(prepared.storyCount, 1, 'the weekly package must ask for the week\'s story');
  assert.equal(prepared.storiesCount, 1, 'legacy mirror stays in sync');
  assert.equal(prepared.publishRequested, true, 'worker-supplied fields survive normalization');
});

test('prepareStartJobPayload: the onboarding variant batch keeps every explicit scope override', async () => {
  // backend/marketing/onboarding-variant-batch.ts rides the weekly job type but
  // deliberately requests one post, one image, and NO story. Normalization must
  // not "helpfully" restore the weekly defaults over any of that.
  const prepared = prepareStartJobPayload('weekly_social_content', {
    ...WORKER_WEEKLY_PAYLOAD,
    staticPostCount: 1,
    imageCreativeCount: 1,
    storyCount: 0,
    videoRenderCount: 0,
  });
  assert.equal(prepared.storyCount, 0);
  assert.equal(prepared.storiesCount, 0);
  assert.equal(prepared.staticPostCount, 1);
  assert.equal(prepared.imageCreativeCount, 1);
  assert.equal(prepared.videoRenderCount, 0);
  assert.equal(prepared.renderVideoAfterApproval, false);
});

test('prepareStartJobPayload: an explicit storyCount > 1 is respected', async () => {
  const prepared = prepareStartJobPayload('weekly_social_content', {
    ...WORKER_WEEKLY_PAYLOAD,
    storyCount: 3,
  });
  assert.equal(prepared.storyCount, 3);
});

test('prepareStartJobPayload: re-preparing an already-normalized payload is a no-op (manual route)', async () => {
  const once = prepareStartJobPayload('weekly_social_content', { ...WORKER_WEEKLY_PAYLOAD });
  const twice = prepareStartJobPayload('weekly_social_content', { ...once });
  assert.deepEqual(twice, once, 'normalization must be idempotent — the manual route already normalizes');
});

test('prepareStartJobPayload: one-off jobs are NOT given weekly defaults', async () => {
  const reelCompanion = prepareStartJobPayload('one_off_post', {
    brandUrl: 'https://brand.example/',
    businessType: 'retail',
  });
  assert.equal('storyCount' in reelCompanion, false, 'a reel companion is not a weekly package');
  assert.equal('staticPostCount' in reelCompanion, false);

  const oneOffCampaign = prepareStartJobPayload('one_off_campaign', { brandUrl: 'https://brand.example/' });
  assert.equal('storyCount' in oneOffCampaign, false);
});

// ---------------------------------------------------------------------------
// End to end: the prepared payload is what synthesis reads
// ---------------------------------------------------------------------------

function stage(name: string, primaryOutput: unknown) {
  return {
    stage: name, status: 'completed', started_at: null, completed_at: null,
    failed_at: null, run_id: null, summary: null, primary_output: primaryOutput,
    outputs: {}, artifacts: [], errors: [],
  };
}

const SCHEDULE = [
  { post_number: 1, platforms: ['instagram'], placement: 'feed', media_type: 'image' },
  { post_number: 2, platforms: ['instagram'], placement: 'feed', media_type: 'image' },
];

function makeDoc(jobId: string, request: Record<string, unknown>): SocialContentJobRuntimeDocument {
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
      publish: stage('publish', { stage: 'publish', schedule: SCHEDULE }),
    },
    approvals: { current: null, history: [] },
    publish_config: { platforms: [], live_publish_platforms: [], video_render_platforms: [] },
    brand_kit: null, inputs: { request, brand_url: 'https://brand.example/' },
    history: [], errors: [], last_error: null,
  } as unknown as SocialContentJobRuntimeDocument;
}

/**
 * @param assetRows creative_assets the job "ingested" (empty = story cannot link a creative)
 * @param storyCountRows what the replay-guard COUNT returns
 */
function makeFakePool(
  assetRows: unknown[],
  opts: { storyCountRows?: number; countThrows?: boolean } = {},
) {
  const inserts: unknown[][] = [];
  let countQueries = 0;
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      if (/INSERT INTO posts/i.test(sql)) {
        inserts.push(params);
        return { rows: [{ id: inserts.length }], rowCount: 1 };
      }
      if (/count\(\*\)::int AS n/i.test(sql)) {
        countQueries += 1;
        if (opts.countThrows) throw new Error('read replica is down');
        return { rows: [{ n: opts.storyCountRows ?? 0 }], rowCount: 1 };
      }
      if (/FROM creative_assets/i.test(sql)) {
        return { rows: assetRows, rowCount: assetRows.length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { pool, inserts, countQueries: () => countQueries };
}

const IMAGE_ASSETS = [
  { id: 'uuid-1', source_asset_id: 'img_1', media_type: 'image' },
  { id: 'uuid-2', source_asset_id: 'img_2', media_type: 'image' },
];

test('worker-path request synthesizes the story: prepared payload -> a surface=story row', async () => {
  await withDataRoot(async () => {
    delete process.env.ARIES_VIDEO_PUBLISH_ENABLED;
    const request = prepareStartJobPayload('weekly_social_content', { ...WORKER_WEEKLY_PAYLOAD });
    const { pool, inserts } = makeFakePool(IMAGE_ASSETS);
    const result = await synthesizePublishPostsFromContentPackage({
      jobId: 'job_worker_story', tenantId: 15, doc: makeDoc('job_worker_story', request), publishRunId: null, pool,
    });
    const story = inserts.find((p) => p[8] === 'story');
    assert.ok(story, 'the weekly run ships its story again');
    assert.equal(story![5], 'job_worker_story:1:instagram:story');
    assert.equal(result.droppedStoryPromised, 0, 'promise kept — no shortfall');
  });
});

test('pre-fix worker request (no story keys at all) synthesizes NO story — the bug, pinned', async () => {
  await withDataRoot(async () => {
    delete process.env.ARIES_VIDEO_PUBLISH_ENABLED;
    const { pool, inserts } = makeFakePool(IMAGE_ASSETS);
    const result = await synthesizePublishPostsFromContentPackage({
      jobId: 'job_prefix', tenantId: 15, doc: makeDoc('job_prefix', { ...WORKER_WEEKLY_PAYLOAD }), publishRunId: null, pool,
    });
    assert.equal(inserts.some((p) => p[8] === 'story'), false);
    // And note it stays SILENT — a request that never promised a story cannot
    // report a shortfall. That is exactly why the fix has to be at the payload
    // seam, not only in the reporting.
    assert.equal(result.droppedStoryPromised, 0);
  });
});

// ---------------------------------------------------------------------------
// Loud signal when a promised surface yields nothing
// ---------------------------------------------------------------------------

test('promised story + zero story rows => droppedStoryPromised and an error-level line', async () => {
  await withDataRoot(async () => {
    delete process.env.ARIES_VIDEO_PUBLISH_ENABLED;
    const request = prepareStartJobPayload('weekly_social_content', { ...WORKER_WEEKLY_PAYLOAD });
    // No ingested creatives: a story is single-media, so every entry is skipped.
    const { pool, inserts } = makeFakePool([]);
    const { value: result, errors } = await withCapturedError(async () =>
      synthesizePublishPostsFromContentPackage({
        jobId: 'job_shortfall', tenantId: 15, doc: makeDoc('job_shortfall', request), publishRunId: null, pool,
      }),
    );

    assert.equal(inserts.some((p) => p[8] === 'story'), false, 'precondition: no story row');
    assert.equal(result.droppedStoryPromised, 1);
    const signals = storyShortfallErrors(errors);
    assert.equal(signals.length, 1, 'the shortfall must be reported once');
    assert.equal(signals[0].jobId, 'job_shortfall');
    assert.equal(signals[0].tenantId, 15);
    assert.equal(signals[0].requested, 1);
  });
});

test('replay: story rows already exist => no shortfall signal', async () => {
  await withDataRoot(async () => {
    delete process.env.ARIES_VIDEO_PUBLISH_ENABLED;
    const request = prepareStartJobPayload('weekly_social_content', { ...WORKER_WEEKLY_PAYLOAD });
    const { pool } = makeFakePool([], { storyCountRows: 2 });
    const { value: result, errors } = await withCapturedError(async () =>
      synthesizePublishPostsFromContentPackage({
        jobId: 'job_replay', tenantId: 15, doc: makeDoc('job_replay', request), publishRunId: null, pool,
      }),
    );
    assert.equal(result.droppedStoryPromised, 0, 'a re-delivered callback is not a failure');
    assert.deepEqual(storyShortfallErrors(errors), []);
  });
});

// A monitoring addition must never break completion bookkeeping, and must never
// invent a failure out of its own read error.
test('replay-guard query failure fails open: no throw, no false shortfall', async () => {
  await withDataRoot(async () => {
    delete process.env.ARIES_VIDEO_PUBLISH_ENABLED;
    const request = prepareStartJobPayload('weekly_social_content', { ...WORKER_WEEKLY_PAYLOAD });
    const { pool, countQueries } = makeFakePool([], { countThrows: true });
    const { value: result, errors } = await withCapturedError(async () =>
      synthesizePublishPostsFromContentPackage({
        jobId: 'job_dbdown', tenantId: 15, doc: makeDoc('job_dbdown', request), publishRunId: null, pool,
      }),
    );
    assert.equal(countQueries(), 1, 'precondition: the guard query really ran and really threw');
    assert.equal(result.droppedStoryPromised, 0);
    assert.deepEqual(storyShortfallErrors(errors), []);
  });
});

test('a deliberate zero-story request never reports a shortfall', async () => {
  await withDataRoot(async () => {
    delete process.env.ARIES_VIDEO_PUBLISH_ENABLED;
    const request = prepareStartJobPayload('weekly_social_content', { ...WORKER_WEEKLY_PAYLOAD, storyCount: 0 });
    const { pool } = makeFakePool([]);
    const { value: result, errors } = await withCapturedError(async () =>
      synthesizePublishPostsFromContentPackage({
        jobId: 'job_zero', tenantId: 15, doc: makeDoc('job_zero', request), publishRunId: null, pool,
      }),
    );
    assert.equal(result.droppedStoryPromised, 0);
    assert.deepEqual(storyShortfallErrors(errors), []);
  });
});
