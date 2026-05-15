/**
 * hermes-image-generation-fail-loud.test.ts
 *
 * Verifies the `hermes_image_generation_unrecognized` fail-loud gate:
 * when a production callback arrives with N image requests declared but zero
 * recognized images in any known output shape, the callback is rejected.
 *
 *   (d) media_requests count=2, artifacts={} AND image_creatives=[] → rejected
 *       with hermes_image_generation_unrecognized
 *   (e) media_requests count=2, artifacts.creative_assets length=2 → accepted
 *   (f) media_requests count=0 (imageCreativeCount=0) → no fail-loud check fires
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/hermes-image-generation-fail-loud.test.ts
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function withRuntimeEnv<T>(run: () => Promise<T>): Promise<T> {
  const prevDataRoot = process.env.DATA_ROOT;
  const prevAppBaseUrl = process.env.APP_BASE_URL;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-unrecognized-'));
  process.env.DATA_ROOT = dataRoot;
  process.env.APP_BASE_URL = 'https://aries.example.com';
  try {
    return await run();
  } finally {
    if (prevDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = prevDataRoot;
    if (prevAppBaseUrl === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = prevAppBaseUrl;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

async function seedSocialJobWithImageCount(imageCreativeCount: number) {
  const {
    createMarketingJobRuntimeDocument,
    saveMarketingJobRuntime,
  } = await import('../backend/marketing/runtime-state');

  const doc = createMarketingJobRuntimeDocument({
    jobId: `mkt_unrecognized-${imageCreativeCount}-${Date.now()}`,
    tenantId: 'tenant-unrecognized',
    payload: {
      brandUrl: 'https://brand.example',
      businessType: 'coaching',
      competitorUrl: '',
      imageCreativeCount,
    },
    brandKit: {
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
    },
  });
  saveMarketingJobRuntime(doc.job_id, doc);
  return doc;
}

// ---------------------------------------------------------------------------
// (d) Callback with media_requests count=2 and no recognized images anywhere
//     → rejected with hermes_image_generation_unrecognized
// ---------------------------------------------------------------------------

test('(d) callback with media_requests count=2 and artifacts:{} + image_creatives:[] is rejected with hermes_image_generation_unrecognized', async () => {
  await withRuntimeEnv(async () => {
    const { createExecutionRunRecord } = await import('../backend/execution/run-store');
    const { handleHermesRunCallback } = await import('../backend/execution/hermes-callbacks');
    const { loadMarketingJobRuntime } = await import('../backend/marketing/runtime-state');

    // imageCreativeCount=2 means 2 media_requests of type image.generate were sent to Hermes
    const doc = await seedSocialJobWithImageCount(2);

    const run = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'marketing',
      workflowKey: 'social_content_weekly',
      action: 'resume',
      tenantId: doc.tenant_id,
      marketingJobId: doc.job_id,
      stage: 'production',
    });

    // Hermes returns approve_publish but with empty artifacts and empty image_creatives —
    // neither the prompt-only check NOR the legacy check would catch this, but the
    // new hermes_image_generation_unrecognized check must.
    await handleHermesRunCallback({
      event_id: 'evt-unrecognized-empty',
      aries_run_id: run.aries_run_id,
      hermes_run_id: 'hermes-unrecognized-1',
      status: 'requires_approval',
      stage: 'production',
      approval: {
        stage: 'publish',
        approval_step: 'approve_publish',
        workflow_step_id: 'approve_stage_4',
        prompt: 'Review creative assets before publish review',
        resume_token: 'social_content_weekly:arun_abc:strategy_complete',
      },
      output: [
        {
          stage: 'production',
          artifacts: {},
          weekly_content_plan: {
            posts: [],
            image_creatives: [],
            video_scripts: [],
          },
        },
      ],
    });

    const after = await loadMarketingJobRuntime(doc.job_id);
    assert.equal(
      after?.stages.production.status,
      'failed',
      'production stage should be failed when zero images recognized',
    );
    assert.ok(after?.last_error, 'last_error should be set');
    assert.equal(
      after?.last_error?.code,
      'hermes_image_generation_unrecognized',
      'error code must be hermes_image_generation_unrecognized',
    );
    assert.match(
      after?.last_error?.message ?? '',
      /no recognized images/i,
      'error message should describe the failure',
    );
    // No approval checkpoint should have been created
    assert.equal(
      after?.approvals.current,
      null,
      'no approval checkpoint should be created when failing loud',
    );
  });
});

test('(d-variant) callback with media_requests count=2 and completely absent artifacts key is rejected', async () => {
  await withRuntimeEnv(async () => {
    const { createExecutionRunRecord } = await import('../backend/execution/run-store');
    const { handleHermesRunCallback } = await import('../backend/execution/hermes-callbacks');
    const { loadMarketingJobRuntime } = await import('../backend/marketing/runtime-state');

    const doc = await seedSocialJobWithImageCount(2);

    const run = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'marketing',
      workflowKey: 'social_content_weekly',
      action: 'resume',
      tenantId: doc.tenant_id,
      marketingJobId: doc.job_id,
      stage: 'production',
    });

    // No artifacts key at all, no image_creatives — Hermes returned nothing
    await handleHermesRunCallback({
      event_id: 'evt-unrecognized-absent',
      aries_run_id: run.aries_run_id,
      hermes_run_id: 'hermes-unrecognized-2',
      status: 'requires_approval',
      stage: 'production',
      approval: {
        stage: 'publish',
        approval_step: 'approve_publish',
        workflow_step_id: 'approve_stage_4',
        prompt: 'Review before publish',
        resume_token: 'social_content_weekly:arun_abc:strategy_complete',
      },
      output: [
        {
          stage: 'production',
          summary: 'Production complete.',
          weekly_content_plan: {
            posts: [],
          },
        },
      ],
    });

    const after = await loadMarketingJobRuntime(doc.job_id);
    assert.equal(
      after?.stages.production.status,
      'failed',
      'should fail when artifacts key is absent and images were requested',
    );
    assert.equal(
      after?.last_error?.code,
      'hermes_image_generation_unrecognized',
      'error code must be hermes_image_generation_unrecognized',
    );
  });
});

// ---------------------------------------------------------------------------
// (e) Callback with media_requests count=2 and artifacts.creative_assets length=2
//     → accepted (no failure)
// ---------------------------------------------------------------------------

test('(e) callback with media_requests count=2 and artifacts.creative_assets of length 2 is accepted', async () => {
  await withRuntimeEnv(async () => {
    const { createExecutionRunRecord } = await import('../backend/execution/run-store');
    const { handleHermesRunCallback } = await import('../backend/execution/hermes-callbacks');
    const { loadMarketingJobRuntime } = await import('../backend/marketing/runtime-state');

    const doc = await seedSocialJobWithImageCount(2);

    const run = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'marketing',
      workflowKey: 'social_content_weekly',
      action: 'resume',
      tenantId: doc.tenant_id,
      marketingJobId: doc.job_id,
      stage: 'production',
    });

    // Hermes returns two recognized creative_assets — should be accepted
    await handleHermesRunCallback({
      event_id: 'evt-recognized-creative-assets',
      aries_run_id: run.aries_run_id,
      hermes_run_id: 'hermes-recognized-1',
      status: 'requires_approval',
      stage: 'production',
      approval: {
        stage: 'publish',
        approval_step: 'approve_publish',
        workflow_step_id: 'approve_stage_4',
        prompt: 'Review creative assets',
        resume_token: 'social_content_weekly:arun_abc:production',
      },
      output: [
        {
          stage: 'production',
          artifacts: {
            aspectRatio: '4:5',
            creative_assets: [
              {
                assetId: 'sl_asset_01',
                type: 'generated_image',
                status: 'created',
                path: '/home/node/.hermes/cache/images/openai_gpt_image_20260513_abc001.png',
                placement: 'post_1',
                prompt: 'Editorial portrait for post 1.',
              },
              {
                assetId: 'sl_asset_02',
                type: 'generated_image',
                status: 'created',
                path: '/home/node/.hermes/cache/images/openai_gpt_image_20260513_abc002.png',
                placement: 'post_2',
                prompt: 'Lifestyle shot for post 2.',
              },
            ],
          },
          weekly_content_plan: {
            posts: [],
            image_creatives: [],
            video_scripts: [],
          },
        },
      ],
    });

    const after = await loadMarketingJobRuntime(doc.job_id);
    // Should NOT be failed — production should reach awaiting_approval or completed
    assert.notEqual(
      after?.stages.production.status,
      'failed',
      'production stage should not be failed when recognized images are present',
    );
    assert.notEqual(
      after?.last_error?.code,
      'hermes_image_generation_unrecognized',
      'should not set unrecognized error when creative_assets are present',
    );
    assert.notEqual(
      after?.last_error?.code,
      'hermes_image_generation_skipped',
      'should not set skipped error when creative_assets are present',
    );
  });
});

test('(e-variant) callback with artifacts.images shape of length 2 is also accepted', async () => {
  await withRuntimeEnv(async () => {
    const { createExecutionRunRecord } = await import('../backend/execution/run-store');
    const { handleHermesRunCallback } = await import('../backend/execution/hermes-callbacks');
    const { loadMarketingJobRuntime } = await import('../backend/marketing/runtime-state');

    const doc = await seedSocialJobWithImageCount(2);

    const run = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'marketing',
      workflowKey: 'social_content_weekly',
      action: 'resume',
      tenantId: doc.tenant_id,
      marketingJobId: doc.job_id,
      stage: 'production',
    });

    await handleHermesRunCallback({
      event_id: 'evt-recognized-images-shape',
      aries_run_id: run.aries_run_id,
      hermes_run_id: 'hermes-recognized-2',
      status: 'requires_approval',
      stage: 'production',
      approval: {
        stage: 'publish',
        approval_step: 'approve_publish',
        workflow_step_id: 'approve_stage_4',
        prompt: 'Review creative assets',
        resume_token: 'social_content_weekly:arun_abc:production',
      },
      output: [
        {
          stage: 'production',
          artifacts: {
            aspectRatio: '4:5',
            images: [
              {
                index: 0,
                status: 'generated',
                filePath: '/home/node/.hermes/cache/images/veo_render_20260513_img0.png',
                prompt: 'Dynamic motion portrait.',
                intendedUse: 'post_cover',
              },
              {
                index: 1,
                status: 'generated',
                filePath: '/home/node/.hermes/cache/images/veo_render_20260513_img1.png',
                prompt: 'Lifestyle reel thumbnail.',
                intendedUse: 'reel_thumb',
              },
            ],
          },
          weekly_content_plan: {
            posts: [],
            image_creatives: [],
          },
        },
      ],
    });

    const after = await loadMarketingJobRuntime(doc.job_id);
    assert.notEqual(
      after?.stages.production.status,
      'failed',
      'should not fail when artifacts.images shape carries recognized images',
    );
    assert.notEqual(
      after?.last_error?.code,
      'hermes_image_generation_unrecognized',
    );
  });
});

// ---------------------------------------------------------------------------
// (f) Callback with media_requests count=0 (imageCreativeCount=0)
//     → no fail-loud check fires regardless of artifact content
// ---------------------------------------------------------------------------

test('(f) callback with imageCreativeCount=0 does not trigger fail-loud check regardless of artifact content', async () => {
  await withRuntimeEnv(async () => {
    const { createExecutionRunRecord } = await import('../backend/execution/run-store');
    const { handleHermesRunCallback } = await import('../backend/execution/hermes-callbacks');
    const { loadMarketingJobRuntime } = await import('../backend/marketing/runtime-state');

    // imageCreativeCount=0 means no media_requests of type image.generate were sent
    const doc = await seedSocialJobWithImageCount(0);

    const run = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'marketing',
      workflowKey: 'social_content_weekly',
      action: 'resume',
      tenantId: doc.tenant_id,
      marketingJobId: doc.job_id,
      stage: 'production',
    });

    // Empty artifacts — but since no images were requested, this is valid
    await handleHermesRunCallback({
      event_id: 'evt-no-images-requested',
      aries_run_id: run.aries_run_id,
      hermes_run_id: 'hermes-no-images-1',
      status: 'requires_approval',
      stage: 'production',
      approval: {
        stage: 'publish',
        approval_step: 'approve_publish',
        workflow_step_id: 'approve_stage_4',
        prompt: 'Review copy before publish',
        resume_token: 'social_content_weekly:arun_abc:production',
      },
      output: [
        {
          stage: 'production',
          artifacts: {},
          weekly_content_plan: {
            posts: [],
            image_creatives: [],
            video_scripts: [],
          },
        },
      ],
    });

    const after = await loadMarketingJobRuntime(doc.job_id);
    // Should NOT be failed — no images were requested so zero images is fine
    assert.notEqual(
      after?.stages.production.status,
      'failed',
      'should not fail when imageCreativeCount=0 (no images were requested)',
    );
    assert.notEqual(
      after?.last_error?.code,
      'hermes_image_generation_unrecognized',
      'hermes_image_generation_unrecognized must not fire when no images were requested',
    );
  });
});

test('(f-variant) callback with absent imageCreativeCount field does not trigger fail-loud check', async () => {
  await withRuntimeEnv(async () => {
    const {
      createMarketingJobRuntimeDocument,
      saveMarketingJobRuntime,
    } = await import('../backend/marketing/runtime-state');
    const { createExecutionRunRecord } = await import('../backend/execution/run-store');
    const { handleHermesRunCallback } = await import('../backend/execution/hermes-callbacks');
    const { loadMarketingJobRuntime } = await import('../backend/marketing/runtime-state');

    // Payload WITHOUT imageCreativeCount — legacy jobs that predate the field
    const doc = createMarketingJobRuntimeDocument({
      jobId: `mkt_legacy-no-count-${Date.now()}`,
      tenantId: 'tenant-unrecognized',
      payload: {
        brandUrl: 'https://brand.example',
        businessType: 'coaching',
        competitorUrl: '',
        // imageCreativeCount intentionally absent
      },
      brandKit: {
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
      },
    });
    saveMarketingJobRuntime(doc.job_id, doc);

    const run = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'marketing',
      workflowKey: 'social_content_weekly',
      action: 'resume',
      tenantId: doc.tenant_id,
      marketingJobId: doc.job_id,
      stage: 'production',
    });

    await handleHermesRunCallback({
      event_id: 'evt-legacy-no-count',
      aries_run_id: run.aries_run_id,
      hermes_run_id: 'hermes-legacy-1',
      status: 'requires_approval',
      stage: 'production',
      approval: {
        stage: 'publish',
        approval_step: 'approve_publish',
        workflow_step_id: 'approve_stage_4',
        prompt: 'Review before publish',
        resume_token: 'social_content_weekly:arun_abc:production',
      },
      output: [
        {
          stage: 'production',
          weekly_content_plan: {
            posts: [],
            image_creatives: [],
          },
        },
      ],
    });

    const after = await loadMarketingJobRuntime(doc.job_id);
    assert.notEqual(
      after?.stages.production.status,
      'failed',
      'legacy jobs without imageCreativeCount should not trigger the unrecognized check',
    );
    assert.notEqual(
      after?.last_error?.code,
      'hermes_image_generation_unrecognized',
    );
  });
});
