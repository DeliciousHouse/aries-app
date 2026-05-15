/**
 * hermes-image-path-fallback.test.ts
 *
 * Verifies the schema-agnostic PNG path harvest fallback in
 * `bridgeHermesCreativeAssets` (backend/marketing/hermes-callbacks.ts).
 *
 * The fallback fires AFTER the three named-shape harvesters
 * (creative_assets, images, image_creatives) return zero. It walks the
 * entire output record recursively and collects any string that looks like a
 * Hermes cache image path — regardless of the JSON field names used.
 *
 * Live regression: job mkt_10fd7f1b rendered 2 real PNGs to disk but the
 * dashboard showed "Generated assets 0 / Image ads 0 / Posts 0" because the
 * callback came back in an unrecognized shape that all named harvesters
 * silently skipped.
 *
 * Test cases:
 *   (a) totally unknown shape containing PNG paths → 2 image_creatives, no fail-loud
 *   (b) deeply nested / mixed arrays+objects → harvested correctly
 *   (c) PNG path in BOTH unknown shape AND a recognized shape → no dupes
 *   (d) NO PNG paths anywhere + media_requests length > 0 → fail-loud fires
 *   (e) media_requests length 0 → fallback may fire but no fail-loud
 *   (f) PNG paths NOT in Hermes cache dir pattern → NOT harvested
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/hermes-image-path-fallback.test.ts
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { bridgeHermesCreativeAssets } from '@/backend/marketing/hermes-callbacks';

// ---------------------------------------------------------------------------
// Helper: set APP_BASE_URL for synchronous bridge tests
// ---------------------------------------------------------------------------

function withAppBaseUrl(fn: () => void): void {
  const prev = process.env.APP_BASE_URL;
  process.env.APP_BASE_URL = 'https://aries.example.com';
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = prev;
  }
}

// ---------------------------------------------------------------------------
// Helper: temporary DATA_ROOT + APP_BASE_URL for async integration tests
// ---------------------------------------------------------------------------

async function withRuntimeEnv<T>(run: () => Promise<T>): Promise<T> {
  const prevDataRoot = process.env.DATA_ROOT;
  const prevAppBaseUrl = process.env.APP_BASE_URL;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-fallback-'));
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
    jobId: `mkt_fallback-${imageCreativeCount}-${Date.now()}`,
    tenantId: 'tenant-fallback',
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

// ===========================================================================
// (a) Totally unknown shape with PNG paths → harvested into image_creatives
// ===========================================================================

test('(a) unknown output shape with Hermes cache PNG paths is harvested into image_creatives', () => {
  withAppBaseUrl(() => {
    // Shape Hermes actually returned for mkt_10fd7f1b (synthesized for test).
    // None of the named harvesters (creative_assets, images, image_creatives) fire.
    const input = {
      result: {
        step3: {
          final_outputs: [
            {
              file: '/home/node/.hermes/cache/images/openai_codex_gpt-image-2-medium_20260515_155915_22de209e.png',
              prompt: 'Editorial portrait post 1.',
              intendedUse: 'post_1',
            },
            {
              file: '/home/node/.hermes/cache/images/openai_codex_gpt-image-2-medium_20260515_160018_1f7b7da9.png',
              prompt: 'Lifestyle shot post 2.',
              intendedUse: 'post_2',
            },
          ],
        },
      },
    };

    const result = bridgeHermesCreativeAssets(input);
    const plan = result.weekly_content_plan as { image_creatives: Array<Record<string, unknown>> };

    assert.ok(Array.isArray(plan?.image_creatives), 'image_creatives should be present after fallback');
    assert.equal(plan.image_creatives.length, 2, 'should harvest 2 PNG paths');

    for (const creative of plan.image_creatives) {
      assert.equal(creative.status, 'completed', 'status should be normalized to completed');
      assert.ok(
        typeof creative.artifact_url === 'string' &&
          (creative.artifact_url as string).startsWith('https://aries.example.com/api/internal/hermes/media/'),
        'artifact_url should be an internal hermes media URL',
      );
    }

    // Verify the two real job filenames from mkt_10fd7f1b are present.
    const urls = plan.image_creatives.map((c) => c.artifact_url as string);
    assert.ok(
      urls.some((u) => u.includes('22de209e')),
      'first PNG basename should appear in artifact_url',
    );
    assert.ok(
      urls.some((u) => u.includes('1f7b7da9')),
      'second PNG basename should appear in artifact_url',
    );
  });
});

// ===========================================================================
// (b) Deeply nested / mixed arrays + objects → harvested correctly
// ===========================================================================

test('(b) deeply nested PNG paths in mixed array+object structure are harvested', () => {
  withAppBaseUrl(() => {
    const input = {
      stages: [
        {
          name: 'image_gen',
          outputs: {
            batches: [
              [
                {
                  index: 0,
                  rendered_path: '/home/node/.hermes/cache/images/openai_gpt_image_20260515_aaa001.png',
                  prompt: 'Deep nested prompt A.',
                  placement: 'feed_post',
                },
              ],
              [
                {
                  index: 1,
                  rendered_path: '/home/node/.hermes/cache/images/openai_gpt_image_20260515_bbb002.png',
                  prompt: 'Deep nested prompt B.',
                },
              ],
            ],
          },
        },
      ],
    };

    const result = bridgeHermesCreativeAssets(input);
    const plan = result.weekly_content_plan as { image_creatives: Array<Record<string, unknown>> };

    assert.ok(Array.isArray(plan?.image_creatives), 'image_creatives should be present');
    assert.equal(plan.image_creatives.length, 2, 'both deeply nested PNG paths should be harvested');

    const urls = plan.image_creatives.map((c) => c.artifact_url as string);
    assert.ok(urls.some((u) => u.includes('aaa001.png')), 'first path should be harvested');
    assert.ok(urls.some((u) => u.includes('bbb002.png')), 'second path should be harvested');

    // Verify sibling context is captured.
    const creativeA = plan.image_creatives.find((c) =>
      (c.artifact_url as string).includes('aaa001.png'),
    );
    assert.equal(creativeA?.prompt, 'Deep nested prompt A.', 'prompt sibling should be captured');
    assert.equal(creativeA?.placement, 'feed_post', 'placement sibling should be captured');
  });
});

// ===========================================================================
// (c) PNG path in BOTH unknown shape AND recognized shape → no dupes
// ===========================================================================

test('(c) same PNG path in unknown shape AND recognized creative_assets → single creative, no duplicates', () => {
  withAppBaseUrl(() => {
    const sharedPath =
      '/home/node/.hermes/cache/images/openai_gpt_image_20260515_shared001.png';

    const input = {
      // Named shape: creative_assets (recognized harvester fires first).
      artifacts: {
        aspectRatio: '4:5',
        creative_assets: [
          {
            assetId: 'recognized_asset',
            type: 'generated_image',
            status: 'created',
            path: sharedPath,
            prompt: 'Recognized prompt.',
            placement: 'post_1',
          },
        ],
      },
      // Unknown shape: also contains the same path in a different field.
      unknown_output: {
        image_file: sharedPath,
      },
    };

    const result = bridgeHermesCreativeAssets(input);
    const plan = result.weekly_content_plan as { image_creatives: Array<Record<string, unknown>> };

    assert.ok(Array.isArray(plan?.image_creatives), 'image_creatives should be present');
    // The named shape fires first and returns 1 creative → fallback does NOT run.
    // Result: exactly 1 creative with no duplicate.
    assert.equal(plan.image_creatives.length, 1, 'should have exactly 1 creative — no duplicates');
    assert.ok(
      (plan.image_creatives[0].artifact_url as string).includes('shared001.png'),
      'the creative should reference the shared path',
    );
  });
});

test('(c-variant) fallback deduplicates when same path appears in two unknown locations', () => {
  withAppBaseUrl(() => {
    const sharedPath =
      '/home/node/.hermes/cache/images/openai_gpt_image_20260515_dup001.png';

    const input = {
      // No recognized named shapes — fallback fires.
      location_a: { file: sharedPath },
      location_b: { rendered: sharedPath },
    };

    const result = bridgeHermesCreativeAssets(input);
    const plan = result.weekly_content_plan as { image_creatives: Array<Record<string, unknown>> };

    assert.ok(Array.isArray(plan?.image_creatives), 'image_creatives should be present');
    assert.equal(plan.image_creatives.length, 1, 'duplicate path should collapse to one creative');
  });
});

// ===========================================================================
// (d) No PNG paths anywhere + media_requests > 0 → fail-loud fires
// ===========================================================================

test('(d) callback with zero PNG paths anywhere and imageCreativeCount=2 triggers fail-loud', async () => {
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

    // Output contains NO strings matching the Hermes cache path pattern.
    await handleHermesRunCallback({
      event_id: 'evt-fallback-no-png',
      aries_run_id: run.aries_run_id,
      hermes_run_id: 'hermes-fallback-d-1',
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
          result: {
            step3: {
              note: 'Images processed but paths not included in callback.',
              status: 'done',
            },
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
    assert.equal(
      after?.stages.production.status,
      'failed',
      'production stage should be failed when zero PNG paths found anywhere',
    );
    assert.equal(
      after?.last_error?.code,
      'hermes_image_generation_unrecognized',
      'fail-loud code should be hermes_image_generation_unrecognized',
    );
    assert.match(
      after?.last_error?.message ?? '',
      /no recognized images/i,
      'error message should describe the absence of recognized images',
    );
  });
});

// ===========================================================================
// (e) media_requests length 0 → no fail-loud even if fallback fires
// ===========================================================================

test('(e) callback with imageCreativeCount=0 does not trigger fail-loud even when fallback fires', async () => {
  await withRuntimeEnv(async () => {
    const { createExecutionRunRecord } = await import('../backend/execution/run-store');
    const { handleHermesRunCallback } = await import('../backend/execution/hermes-callbacks');
    const { loadMarketingJobRuntime } = await import('../backend/marketing/runtime-state');

    // imageCreativeCount=0 → no images were requested.
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

    // Output has PNG paths in an unknown location — fallback would find them —
    // but since imageCreativeCount=0 the fail-loud gate must NOT fire.
    await handleHermesRunCallback({
      event_id: 'evt-fallback-zero-requested',
      aries_run_id: run.aries_run_id,
      hermes_run_id: 'hermes-fallback-e-1',
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
          some_bonus_output: {
            // A PNG happens to be present in unknown location — irrelevant since 0 requested.
            thumbnail: '/home/node/.hermes/cache/images/openai_gpt_image_20260515_bonus.png',
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
      'should not fail when imageCreativeCount=0 regardless of PNG presence',
    );
    assert.notEqual(
      after?.last_error?.code,
      'hermes_image_generation_unrecognized',
      'hermes_image_generation_unrecognized must not fire when no images were requested',
    );
  });
});

// ===========================================================================
// (f) PNG paths NOT in Hermes cache dir pattern → NOT harvested
// ===========================================================================

test('(f) external CDN PNG URLs that lack Hermes cache path pattern are not harvested', () => {
  withAppBaseUrl(() => {
    const input = {
      // Competitor screenshot: external URL ending in .png — should NOT be harvested.
      competitor_analysis: {
        screenshot: 'https://cdn.example.com/screenshots/competitor_ad_2026.png',
        ad_library_screenshot: 'https://static.fbcdn.net/adslib/preview_abc123.png',
        thumbnail: 'https://images.unsplash.com/photo-1234567890.png?w=800',
      },
      // External image reference that happens to be a PNG.
      reference_image: 'https://brand.example.com/assets/logo.png',
    };

    const result = bridgeHermesCreativeAssets(input);

    // No image_creatives should appear — all paths are external CDN URLs with
    // no Hermes cache segment and no Hermes-style filename prefix.
    const plan = result.weekly_content_plan as Record<string, unknown> | undefined;
    const creatives = plan?.image_creatives as unknown[] | undefined;
    assert.ok(
      !creatives || creatives.length === 0,
      'external CDN PNG URLs must not be harvested by the fallback',
    );
  });
});

test('(f-variant) a local path outside the Hermes cache dir is also not harvested', () => {
  withAppBaseUrl(() => {
    const input = {
      // A PNG on disk but NOT in the hermes cache dir and with no Hermes prefix.
      brand_assets: {
        logo: '/home/node/brand/logo_final.png',
        hero_image: '/var/www/html/images/hero_banner.png',
      },
    };

    const result = bridgeHermesCreativeAssets(input);
    const plan = result.weekly_content_plan as Record<string, unknown> | undefined;
    const creatives = plan?.image_creatives as unknown[] | undefined;
    assert.ok(
      !creatives || creatives.length === 0,
      'local PNG paths outside the Hermes cache dir must not be harvested',
    );
  });
});
