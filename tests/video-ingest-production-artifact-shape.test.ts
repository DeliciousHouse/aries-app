/**
 * Regression coverage for the production-stage artifact SHAPE.
 *
 * Hermes returns `artifacts` two different ways:
 *   - the production stage's execution contract specifies an OBJECT,
 *     `artifacts:{creative_assets:[...], errors:[]}` (see
 *     PRODUCTION_EXECUTION_CONTRACT in backend/marketing/ports/hermes.ts);
 *   - the standalone `video_render` stage returns a bare ARRAY.
 *
 * The video ingest originally read only the array shape. Every production
 * callback therefore reported zero video artifacts, which tripped the
 * all-skipped fail-closed gate and terminally failed any job with
 * videoRenderCount > 0 — destroying that week's copy and images before they
 * were persisted. The whole existing video suite fed the array shape, so CI
 * stayed green. These tests pin the object shape end to end.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/video-ingest-production-artifact-shape.test.ts
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createExecutionRunRecord, loadExecutionRunRecord } from '../backend/execution/run-store';
import { handleHermesRunCallback } from '../backend/execution/hermes-callbacks';
import { ingestSocialContentVideoRenderOutput } from '../backend/social-content/media-ingest';
import {
  createSocialContentJobRuntimeDocument,
  loadSocialContentJobRuntime,
  saveSocialContentJobRuntime,
} from '../backend/marketing/runtime-state';

function brandKit() {
  return {
    path: '/tmp/brand-kit.json',
    source_url: 'https://brand.example',
    canonical_url: 'https://brand.example',
    brand_name: 'Brand',
    logo_urls: [],
    colors: { primary: null, secondary: null, accent: null, palette: [] },
    font_families: [],
    external_links: [],
    extracted_at: new Date().toISOString(),
    brand_voice_summary: 'clear',
    offer_summary: null,
    positioning: null,
    audience: null,
    tone_of_voice: null,
    style_vibe: null,
  };
}

function seedJob(jobId: string, videoRenderCount: number, imageCreativeCount: number) {
  const doc = createSocialContentJobRuntimeDocument({
    jobId,
    tenantId: 'tenant-video-shape',
    payload: {
      brandUrl: 'https://brand.example',
      businessType: 'marketing agency',
      competitorUrl: 'https://competitor.example',
      jobType: 'weekly_social_content',
      videoRenderCount,
      imageCreativeCount,
    },
    brandKit: brandKit(),
  });
  saveSocialContentJobRuntime(jobId, doc);
  return doc;
}

async function withRuntimeEnv<T>(run: () => Promise<T>): Promise<T> {
  const previousDataRoot = process.env.DATA_ROOT;
  const previousVideoMount = process.env.HERMES_VIDEO_CACHE_MOUNT;
  const root = await mkdtemp(path.join(tmpdir(), 'aries-video-shape-'));
  const dataRoot = path.join(root, 'data');
  const videoMount = path.join(root, 'hermes-video-media');
  await mkdir(dataRoot, { recursive: true });
  await mkdir(videoMount, { recursive: true });
  process.env.DATA_ROOT = dataRoot;
  process.env.HERMES_VIDEO_CACHE_MOUNT = videoMount;
  try {
    return await run();
  } finally {
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    if (previousVideoMount === undefined) delete process.env.HERMES_VIDEO_CACHE_MOUNT;
    else process.env.HERMES_VIDEO_CACHE_MOUNT = previousVideoMount;
    await rm(root, { recursive: true, force: true });
  }
}

function renderedImage(assetId: string, basename: string) {
  return {
    assetId,
    type: 'generated_image',
    status: 'created',
    path: `/home/node/.hermes/cache/images/${basename}`,
    placement: assetId,
    prompt: 'Editorial shot.',
  };
}

/** A clip Hermes genuinely reported but that resolves outside every approved
 *  cache root, so it is reported-but-not-ingestible. */
function unusableClip(id: string) {
  return {
    id,
    type: 'generated_video',
    media_type: 'video',
    path: '/tmp/untrusted-provider-output.mp4',
    mime_type: 'video/mp4',
    platform_slug: 'instagram_reels',
    family_id: 'weekly_primary',
  };
}

function productionRun(jobId: string, tenantId: string) {
  return createExecutionRunRecord({
    provider: 'hermes',
    domain: 'marketing',
    workflowKey: 'social_content_weekly',
    action: 'run',
    tenantId,
    marketingJobId: jobId,
    stage: 'production',
  });
}

const approvePublish = {
  stage: 'publish' as const,
  approval_step: 'approve_publish' as const,
  workflow_step_id: 'approve_stage_4',
  prompt: 'Review creative assets',
  resume_token: 'social_content_weekly:arun_shape:production',
};

// ---------------------------------------------------------------------------
// B1 — the object shape is read at all
// ---------------------------------------------------------------------------

test('video ingest reports clips carried in the production object artifact shape', async () => {
  await withRuntimeEnv(async () => {
    const output = [{
      stage: 'production',
      artifacts: {
        creative_assets: [unusableClip('clip-1')],
        errors: [],
      },
    }];

    const result = ingestSocialContentVideoRenderOutput('mkt_shape_reported', output);

    // Before the fix this was 0: recordArray() returned [] for the object
    // shape, so the clip was invisible and the fail-closed gate misfired.
    assert.equal(result.reportedCount, 1);
    assert.equal(result.ingestedCount, 0);
    assert.equal(result.skipped.length, 1);
  });
});

// ---------------------------------------------------------------------------
// B3 — consolidation must not clobber entry 0's rendered images
// ---------------------------------------------------------------------------

test('consolidating trailing video artifacts preserves entry 0 rendered images', async () => {
  await withRuntimeEnv(async () => {
    const output: Array<Record<string, unknown>> = [
      {
        stage: 'production',
        artifacts: {
          creative_assets: [renderedImage('img_1', 'gpt_image_shape_001.png')],
          errors: [],
        },
      },
      { artifacts: [unusableClip('clip-trailing')] },
    ];

    ingestSocialContentVideoRenderOutput('mkt_shape_merge', output);

    const artifacts = output[0].artifacts as Record<string, unknown>;
    // Before the fix this assertion failed: `artifacts` had been replaced by a
    // flat array, so ingest-production-assets.ts read `.creative_assets` off an
    // array, found nothing, and silently inserted zero creative_assets rows.
    assert.ok(!Array.isArray(artifacts), 'entry 0 artifacts must remain the object shape');
    const assets = artifacts.creative_assets as Array<Record<string, unknown>>;
    assert.equal(assets.length, 2, 'image is retained and the trailing clip is merged in');
    assert.equal(assets[0].type, 'generated_image');
    assert.equal(assets[0].assetId, 'img_1');
    assert.equal(assets[1].id, 'clip-trailing');
  });
});

// ---------------------------------------------------------------------------
// B2 — a missing clip must never discard completed images and copy
// ---------------------------------------------------------------------------

test('a production callback with rendered images and an unusable clip keeps the completed stage', async () => {
  await withRuntimeEnv(async () => {
    const jobId = 'mkt_123e4567-e89b-42d3-a456-4266141740a1';
    const doc = seedJob(jobId, 1, 2);
    const run = productionRun(jobId, doc.tenant_id);

    const result = await handleHermesRunCallback({
      event_id: 'evt-shape-images-plus-bad-clip',
      aries_run_id: run.aries_run_id,
      hermes_run_id: 'hrun-shape-images-plus-bad-clip',
      status: 'requires_approval',
      stage: 'production',
      approval: approvePublish,
      output: [{
        stage: 'production',
        content_package: [
          { post_number: 1, hook: 'Hook one', body: 'Body one', cta: 'Shop', hashtags: ['#a', '#b', '#c'] },
          { post_number: 2, hook: 'Hook two', body: 'Body two', cta: 'Shop', hashtags: ['#a', '#b', '#c'] },
        ],
        artifacts: {
          creative_assets: [
            renderedImage('img_1', 'gpt_image_shape_101.png'),
            renderedImage('img_2', 'gpt_image_shape_102.png'),
            unusableClip('clip-unusable'),
          ],
          errors: [],
        },
        weekly_content_plan: { posts: [], image_creatives: [], video_scripts: [] },
      }],
    });

    assert.equal(result.status, 'accepted');
    const after = await loadSocialContentJobRuntime(jobId);

    // Before the fix: state 'failed', production 'failed', primary_output null —
    // two rendered images and a full week of copy destroyed over one clip.
    assert.notEqual(after?.state, 'failed');
    assert.notEqual(after?.stages.production.status, 'failed');
    assert.ok(after?.stages.production.primary_output, 'production primary_output must be persisted');

    const primaryOutput = after?.stages.production.primary_output as Record<string, unknown>;
    const artifacts = primaryOutput.artifacts as Record<string, unknown>;
    assert.ok(!Array.isArray(artifacts), 'persisted artifacts must keep the object shape');
    const assets = artifacts.creative_assets as Array<Record<string, unknown>>;
    assert.equal(
      assets.filter((asset) => asset.type === 'generated_image').length,
      2,
      'both rendered images survive into primary_output',
    );

    const executionRecord = loadExecutionRunRecord(run.aries_run_id);
    assert.notEqual(executionRecord?.status, 'failed');
  });
});

test('a production callback with rendered images but no clip at all does not fail the job', async () => {
  await withRuntimeEnv(async () => {
    const jobId = 'mkt_123e4567-e89b-42d3-a456-4266141740a2';
    const doc = seedJob(jobId, 1, 2);
    const run = productionRun(jobId, doc.tenant_id);

    const result = await handleHermesRunCallback({
      event_id: 'evt-shape-no-clip-reported',
      aries_run_id: run.aries_run_id,
      hermes_run_id: 'hrun-shape-no-clip-reported',
      status: 'requires_approval',
      stage: 'production',
      approval: approvePublish,
      output: [{
        stage: 'production',
        content_package: [
          { post_number: 1, hook: 'Hook one', body: 'Body one', cta: 'Shop', hashtags: ['#a', '#b', '#c'] },
        ],
        artifacts: {
          creative_assets: [
            renderedImage('img_1', 'gpt_image_shape_201.png'),
            renderedImage('img_2', 'gpt_image_shape_202.png'),
          ],
          errors: [],
        },
        weekly_content_plan: { posts: [], image_creatives: [], video_scripts: [] },
      }],
    });

    assert.equal(result.status, 'accepted');
    const after = await loadSocialContentJobRuntime(jobId);

    // A weekly job that rendered its images and merely missed the clip keeps
    // its stage output. The missing clip is handled downstream by the
    // reel-companion outcome gate and by publish-time video-target dropping —
    // not by destroying a week of work here. (A reel-only job that produced
    // nothing publishable still fails closed; see the last test.)
    assert.notEqual(after?.state, 'failed');
    assert.notEqual(after?.stages.production.status, 'failed');
    assert.ok(after?.stages.production.primary_output);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed intent is preserved where nothing of value would be lost
// ---------------------------------------------------------------------------

test('a job with no publishable output still fails closed when a reported clip cannot be ingested', async () => {
  await withRuntimeEnv(async () => {
    const jobId = 'mkt_123e4567-e89b-42d3-a456-4266141740a3';
    const doc = seedJob(jobId, 1, 0);
    const run = productionRun(jobId, doc.tenant_id);

    const result = await handleHermesRunCallback({
      event_id: 'evt-shape-clip-only-unusable',
      aries_run_id: run.aries_run_id,
      hermes_run_id: 'hrun-shape-clip-only-unusable',
      status: 'requires_approval',
      stage: 'production',
      approval: {
        stage: 'publish',
        approval_step: 'approve_video_render',
        workflow_step_id: 'approve_video_render',
        prompt: 'Approve the completed video render.',
      },
      output: [{
        stage: 'production',
        artifacts: {
          creative_assets: [unusableClip('clip-only')],
          errors: [],
        },
      }],
    });

    assert.equal(result.status, 'accepted');
    const after = await loadSocialContentJobRuntime(jobId);
    assert.equal(after?.state, 'failed');
    assert.equal(after?.stages.production.status, 'failed');
    assert.equal(after?.last_error?.code, 'hermes_video_artifact_ingest_failed');

    const executionRecord = loadExecutionRunRecord(run.aries_run_id);
    assert.equal(executionRecord?.status, 'failed');
  });
});
