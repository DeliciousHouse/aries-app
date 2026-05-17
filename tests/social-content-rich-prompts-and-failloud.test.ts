import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// ---------------------------------------------------------------------------
// Part 1: buildProductionResumeContext — per-image prompt construction
// ---------------------------------------------------------------------------

function makeMinimalDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    job_id: 'mkt_test-job',
    tenant_id: '15',
    inputs: {
      request: {
        businessName: 'Sugar and Leather',
        businessType: 'Elite coaching',
        styleVibe: 'Grounded and approachable with warm tones.',
        primaryGoal: 'Drive awareness and book discovery calls',
        offer: 'Elite coaching for women leaders',
        channels: ['meta', 'instagram'],
        imageCreativeCount: 2,
        windowDays: 7,
        staticPostCount: 7,
      },
      brand_url: 'https://sugarandleather.com/',
    },
    brand_kit: {
      brand_name: 'Sugar and Leather',
      brand_voice_summary: 'Warm, elite, empowering.',
      offer_summary: 'Elite coaching for women leaders and executives.',
      positioning: null,
      audience: null,
      tone_of_voice: null,
      style_vibe: null,
      colors: {
        primary: '#f6339a',
        secondary: '#a855f7',
        accent: '#e60076',
        palette: ['#f6339a', '#a855f7', '#e60076'],
      },
      logo_urls: [],
      font_families: ['Inter', 'Manrope'],
      external_links: [],
      extracted_at: new Date().toISOString(),
      source_url: 'https://sugarandleather.com/',
      canonical_url: 'https://sugarandleather.com/',
    },
    stages: {
      research: { primary_output: null },
      strategy: { primary_output: null },
      production: { primary_output: null },
      publish: { primary_output: null },
    },
    ...overrides,
  };
}

const FULL_RESEARCH_OUTPUT = {
  stage: 'research',
  brand: { name: 'Sugar and Leather' },
  positioning: 'Female-led elite coaching network for women leaders and executives.',
  audience_insights: {
    primary: ['Women leaders seeking advancement without burnout', 'Executives navigating high-stakes decisions'],
    pain_points: ['External success paired with internal strain', 'Isolation in leadership'],
  },
  channel_notes: {
    meta: 'Lean into emotional resonance and concise promise-led hooks.',
    instagram: 'Use polished editorial-style visuals and warm premium lifestyle imagery.',
  },
  recommended_research_conclusion: 'Focus on discovery-call awareness anchored in peace-centered success and women\'s leadership.',
};

const FULL_STRATEGY_OUTPUT = {
  stage: 'strategy',
  strategySummary: 'Lead with emotionally resonant leadership pain points and convert attention into discovery calls.',
  creativeDirection: {
    visualStyle: 'Grounded, warm, premium, and approachable with elevated feminine energy.',
    recommendedVisualMotifs: ['soft editorial portraiture', 'warm neutral backdrops', 'premium minimal layouts', 'single-subject compositions'],
    avoid: ['split-screen', 'before/after', 'side-by-side comparison', 'two-panel layout'],
    palette: ['#f6339a', '#a855f7', '#e60076'],
  },
  channelAdaptation: {
    meta: 'Use stronger emotional hooks and concise benefit-led copy for feed performance.',
    instagram: 'Favor polished editorial framing and aspirational but intimate tone.',
  },
};

test('buildProductionResumeContext produces one prompt per imageCreativeCount', async () => {
  const { buildProductionResumeContext } = await import('@/backend/social-content/workflow-request');
  const doc = makeMinimalDoc() as Parameters<typeof buildProductionResumeContext>[0]['doc'];
  const ctx = buildProductionResumeContext({ doc, researchOutput: FULL_RESEARCH_OUTPUT, strategyOutput: FULL_STRATEGY_OUTPUT });

  assert.equal(ctx.imagePrompts.length, 2, 'should produce 2 image prompts for imageCreativeCount=2');
  assert.equal(ctx.imagePrompts[0].imageIndex, 1);
  assert.equal(ctx.imagePrompts[0].totalImages, 2);
  assert.equal(ctx.imagePrompts[1].imageIndex, 2);
  assert.equal(ctx.imagePrompts[1].totalImages, 2);
});

test('buildProductionResumeContext prompt contains brand name', async () => {
  const { buildProductionResumeContext } = await import('@/backend/social-content/workflow-request');
  const doc = makeMinimalDoc() as Parameters<typeof buildProductionResumeContext>[0]['doc'];
  const ctx = buildProductionResumeContext({ doc, researchOutput: FULL_RESEARCH_OUTPUT, strategyOutput: FULL_STRATEGY_OUTPUT });

  for (const img of ctx.imagePrompts) {
    assert.ok(img.prompt.includes('Sugar and Leather'), `image ${img.imageIndex} prompt should contain brand name`);
  }
});

test('buildProductionResumeContext prompt contains "image N of M" numbering', async () => {
  const { buildProductionResumeContext } = await import('@/backend/social-content/workflow-request');
  const doc = makeMinimalDoc() as Parameters<typeof buildProductionResumeContext>[0]['doc'];
  const ctx = buildProductionResumeContext({ doc, researchOutput: FULL_RESEARCH_OUTPUT, strategyOutput: FULL_STRATEGY_OUTPUT });

  assert.ok(ctx.imagePrompts[0].prompt.includes('image 1 of 2'), 'first prompt should say "image 1 of 2"');
  assert.ok(ctx.imagePrompts[1].prompt.includes('image 2 of 2'), 'second prompt should say "image 2 of 2"');
});

test('buildProductionResumeContext prompt contains aspect ratio and channel context', async () => {
  const { buildProductionResumeContext } = await import('@/backend/social-content/workflow-request');
  const doc = makeMinimalDoc() as Parameters<typeof buildProductionResumeContext>[0]['doc'];
  const ctx = buildProductionResumeContext({ doc, researchOutput: FULL_RESEARCH_OUTPUT, strategyOutput: FULL_STRATEGY_OUTPUT });

  for (const img of ctx.imagePrompts) {
    // Instagram is dominant — expect 4:5
    assert.equal(img.aspectRatio, '4:5', `image ${img.imageIndex} should use 4:5 aspect ratio`);
    assert.ok(img.prompt.includes('4:5'), `image ${img.imageIndex} prompt should include aspect ratio`);
    assert.ok(img.prompt.includes('instagram'), `image ${img.imageIndex} prompt should reference instagram`);
  }
});

test('buildProductionResumeContext prompt folds in research findings', async () => {
  const { buildProductionResumeContext } = await import('@/backend/social-content/workflow-request');
  const doc = makeMinimalDoc() as Parameters<typeof buildProductionResumeContext>[0]['doc'];
  const ctx = buildProductionResumeContext({ doc, researchOutput: FULL_RESEARCH_OUTPUT, strategyOutput: FULL_STRATEGY_OUTPUT });

  for (const img of ctx.imagePrompts) {
    assert.ok(
      img.prompt.includes('Female-led elite coaching'),
      `image ${img.imageIndex} prompt should contain research positioning`,
    );
    assert.ok(
      img.prompt.includes('Women leaders seeking advancement'),
      `image ${img.imageIndex} prompt should contain research audience`,
    );
  }
});

test('buildProductionResumeContext prompt folds in strategy creative direction', async () => {
  const { buildProductionResumeContext } = await import('@/backend/social-content/workflow-request');
  const doc = makeMinimalDoc() as Parameters<typeof buildProductionResumeContext>[0]['doc'];
  const ctx = buildProductionResumeContext({ doc, researchOutput: FULL_RESEARCH_OUTPUT, strategyOutput: FULL_STRATEGY_OUTPUT });

  for (const img of ctx.imagePrompts) {
    assert.ok(
      img.prompt.includes('Grounded, warm, premium'),
      `image ${img.imageIndex} prompt should contain visual style from strategy`,
    );
    assert.ok(
      img.prompt.includes('soft editorial portraiture'),
      `image ${img.imageIndex} prompt should contain recommended visual motifs`,
    );
  }
});

test('buildProductionResumeContext falls back gracefully with null research and strategy', async () => {
  const { buildProductionResumeContext } = await import('@/backend/social-content/workflow-request');
  const doc = makeMinimalDoc() as Parameters<typeof buildProductionResumeContext>[0]['doc'];

  let ctx: ReturnType<typeof buildProductionResumeContext>;
  assert.doesNotThrow(() => {
    ctx = buildProductionResumeContext({ doc, researchOutput: null, strategyOutput: null });
  }, 'should not throw when research/strategy output is null');

  // @ts-ignore assigned in doesNotThrow
  assert.ok(ctx!.imagePrompts.length > 0, 'should still produce image prompts without research/strategy output');
  // @ts-ignore
  assert.ok(ctx!.imagePrompts[0].prompt.includes('Sugar and Leather'), 'fallback prompt should still reference brand name');
});


test('buildSocialContentWeeklyRequest repairs stale leather-goods offer before research dispatch', async () => {
  const { buildSocialContentWeeklyRequest } = await import('@/backend/social-content/workflow-request');
  const doc = makeMinimalDoc({
    inputs: {
      request: {
        businessName: 'Sugar and Leather',
        businessType: 'Elite coaching and professional development',
        styleVibe: 'Grounded and approachable with warm tones.',
        primaryGoal: 'Drive awareness of the coaching program and book discovery calls',
        offer: 'Sugar and Leather — handcrafted leather goods including bags, wallets, and accessories.',
        channels: ['meta', 'instagram'],
        imageCreativeCount: 2,
        windowDays: 7,
        staticPostCount: 7,
      },
      brand_url: 'https://sugarandleather.com/',
    },
    brand_kit: {
      brand_name: 'Sugar and Leather',
      brand_voice_summary: 'Warm, elite, empowering coaching for women leaders.',
      offer_summary: 'Elite coaching network for women leaders and executives.',
      positioning: null,
      audience: null,
      tone_of_voice: null,
      style_vibe: null,
      colors: {
        primary: '#f6339a',
        secondary: '#a855f7',
        accent: '#e60076',
        palette: ['#f6339a', '#a855f7', '#e60076'],
      },
      logo_urls: [],
      font_families: ['Inter', 'Manrope'],
      external_links: [],
      extracted_at: new Date().toISOString(),
      source_url: 'https://sugarandleather.com/',
      canonical_url: 'https://sugarandleather.com/',
    },
  }) as Parameters<typeof buildSocialContentWeeklyRequest>[0]['doc'];

  const request = buildSocialContentWeeklyRequest({
    doc,
    ariesRunId: 'arun_test',
    callbackUrl: 'https://aries.example.com/api/internal/hermes/runs',
  });

  assert.equal(request.input.brand.offer, 'Elite coaching network for women leaders and executives.');
  assert.equal(request.input.objective.offer, 'Elite coaching network for women leaders and executives.');

  // creative_briefs in image media_requests must also not contain the stale
  // leather-goods copy — the offer repair must run before creative_briefs are
  // constructed (Copilot regression-014 gap: raw req.offer was used here).
  const imageMediaRequest = (request.input.media_requests ?? []).find((r) => r.type === 'image.generate');
  assert.ok(imageMediaRequest, 'image media request should be present');
  const briefs = (imageMediaRequest as { creative_briefs?: string[] }).creative_briefs ?? [];
  const leatherLeak = briefs.some((b) => /leather goods|wallets|bags|accessories/i.test(b));
  assert.equal(leatherLeak, false, `creative_briefs must not contain stale leather-goods copy; got: ${JSON.stringify(briefs)}`);
});

test('buildProductionResumeContext contextBlock contains all image prompts', async () => {
  const { buildProductionResumeContext } = await import('@/backend/social-content/workflow-request');
  const doc = makeMinimalDoc() as Parameters<typeof buildProductionResumeContext>[0]['doc'];
  const ctx = buildProductionResumeContext({ doc, researchOutput: FULL_RESEARCH_OUTPUT, strategyOutput: FULL_STRATEGY_OUTPUT });

  assert.ok(ctx.contextBlock.includes('Image 1 of 2'), 'contextBlock should include image 1 header');
  assert.ok(ctx.contextBlock.includes('Image 2 of 2'), 'contextBlock should include image 2 header');
  assert.ok(ctx.contextBlock.includes('Sugar and Leather'), 'contextBlock should include brand name');
});

test('buildProductionResumeContext contextBlock appends canonical creative_assets schema once', async () => {
  const { buildProductionResumeContext } = await import('@/backend/social-content/workflow-request');
  const doc = makeMinimalDoc() as Parameters<typeof buildProductionResumeContext>[0]['doc'];
  const ctx = buildProductionResumeContext({ doc, researchOutput: FULL_RESEARCH_OUTPUT, strategyOutput: FULL_STRATEGY_OUTPUT });

  const schemaHeading = 'Return your results in this EXACT JSON shape:';
  assert.equal(ctx.contextBlock.split(schemaHeading).length - 1, 1, 'schema heading should appear exactly once');
  assert.ok(
    ctx.contextBlock.includes('`artifacts.creative_assets[]`'),
    'contextBlock should mention canonical creative_assets output',
  );
  assert.ok(
    ctx.contextBlock.includes('"assetId": "img_0"'),
    'contextBlock should include worked canonical creative_assets example',
  );
  assert.ok(
    ctx.contextBlock.includes('`artifacts.images[]`'),
    'contextBlock should mention fallback artifacts.images shape',
  );
});

// ---------------------------------------------------------------------------
// Part 2: fail-loud verification — production callback without rendered images
// ---------------------------------------------------------------------------

async function withRuntimeEnv<T>(run: () => Promise<T>): Promise<T> {
  const previousDataRoot = process.env.DATA_ROOT;
  const previousAppBaseUrl = process.env.APP_BASE_URL;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-failloud-'));
  process.env.DATA_ROOT = dataRoot;
  process.env.APP_BASE_URL = 'https://aries.example.com';
  try {
    return await run();
  } finally {
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    if (previousAppBaseUrl === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = previousAppBaseUrl;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

async function seedSocialJob() {
  const {
    createMarketingJobRuntimeDocument,
    saveMarketingJobRuntime,
  } = await import('../backend/marketing/runtime-state');

  const doc = createMarketingJobRuntimeDocument({
    jobId: 'mkt_failloud-test',
    tenantId: 'tenant-failloud',
    payload: {
      brandUrl: 'https://brand.example',
      businessType: 'coaching',
      competitorUrl: '',
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
      positioning: null,
      audience: null,
      tone_of_voice: null,
      style_vibe: null,
    },
  });
  saveMarketingJobRuntime(doc.job_id, doc);
  return doc;
}

test('production callback with unrendered image_creatives (no artifact_url) is rejected as failed', async () => {
  await withRuntimeEnv(async () => {
    const { createExecutionRunRecord } = await import('../backend/execution/run-store');
    const { handleHermesRunCallback } = await import('../backend/execution/hermes-callbacks');
    const { loadMarketingJobRuntime } = await import('../backend/marketing/runtime-state');

    const doc = await seedSocialJob();

    const run = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'marketing',
      workflowKey: 'social_content_weekly',
      action: 'resume',
      tenantId: doc.tenant_id,
      marketingJobId: doc.job_id,
      stage: 'production',
    });

    // Simulate Hermes returning approve_publish from production stage but with
    // image_creatives that have prompts and no artifact_url (image_generate skipped).
    await handleHermesRunCallback({
      event_id: 'evt-failloud-no-renders',
      aries_run_id: run.aries_run_id,
      hermes_run_id: 'hermes-failloud-1',
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
          weekly_content_plan: {
            image_creatives: [
              {
                id: 'creative_01',
                title: 'Brand hero',
                aspect_ratio: '4:5',
                prompt: 'A luxury editorial image for the brand.',
                status: 'pending',
                artifact_url: '',   // empty — not rendered
              },
              {
                id: 'creative_02',
                title: 'Brand lifestyle',
                aspect_ratio: '4:5',
                prompt: 'A lifestyle image for the brand.',
                status: 'pending',
                artifact_url: '',   // empty — not rendered
              },
            ],
          },
        },
      ],
    });

    const after = await loadMarketingJobRuntime(doc.job_id);
    assert.equal(after?.stages.production.status, 'failed', 'production stage should be failed');
    const lastError = after?.last_error;
    assert.ok(lastError, 'last_error should be set');
    assert.equal(lastError?.code, 'hermes_image_generation_skipped', 'error code should indicate images were skipped');
    assert.match(lastError?.message ?? '', /image_generate was not called/i, 'error message should explain what happened');
    // Must NOT create an approval checkpoint when failing loud
    assert.equal(after?.approvals.current, null, 'no approval checkpoint should be created when failing loud');
  });
});

test('production callback with rendered image_creatives (real artifact_url) passes validation', async () => {
  await withRuntimeEnv(async () => {
    const { createExecutionRunRecord } = await import('../backend/execution/run-store');
    const { handleHermesRunCallback } = await import('../backend/execution/hermes-callbacks');
    const { loadMarketingJobRuntime } = await import('../backend/marketing/runtime-state');

    const doc = await seedSocialJob();

    const run = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'marketing',
      workflowKey: 'social_content_weekly',
      action: 'resume',
      tenantId: doc.tenant_id,
      marketingJobId: doc.job_id,
      stage: 'production',
    });

    // Simulate Hermes returning approve_publish with real rendered image_creatives.
    await handleHermesRunCallback({
      event_id: 'evt-failloud-with-renders',
      aries_run_id: run.aries_run_id,
      hermes_run_id: 'hermes-failloud-2',
      status: 'requires_approval',
      stage: 'production',
      approval: {
        stage: 'publish',
        approval_step: 'approve_publish',
        workflow_step_id: 'approve_stage_4',
        prompt: 'Review creative assets before publish review',
        resume_token: 'social_content_weekly:arun_abc:production',
      },
      output: [
        {
          stage: 'production',
          artifacts: {
            creative_assets: [
              {
                assetId: 'sl_asset_01',
                type: 'generated_image',
                status: 'created',
                path: '/home/node/.hermes/cache/images/openai_codex_gpt-image-2-medium_20260513_194035_8af24877.png',
                placement: 'post_1',
              },
            ],
          },
          weekly_content_plan: {
            image_creatives: [],
          },
        },
      ],
    });

    const after = await loadMarketingJobRuntime(doc.job_id);
    // Should NOT be failed — production should complete (approval or publish-skip, both valid).
    assert.ok(
      after?.stages.production.status !== 'failed',
      'production stage should not be failed when images were rendered',
    );
    // Error code must NOT be hermes_image_generation_skipped.
    assert.notEqual(
      after?.last_error?.code,
      'hermes_image_generation_skipped',
      'should not set image-generation-skipped error when images were rendered',
    );
  });
});

test('production callback with no image_creatives at all does not trigger fail-loud (no images requested)', async () => {
  await withRuntimeEnv(async () => {
    const { createExecutionRunRecord } = await import('../backend/execution/run-store');
    const { handleHermesRunCallback } = await import('../backend/execution/hermes-callbacks');
    const { loadMarketingJobRuntime } = await import('../backend/marketing/runtime-state');

    const doc = await seedSocialJob();

    const run = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'marketing',
      workflowKey: 'social_content_weekly',
      action: 'resume',
      tenantId: doc.tenant_id,
      marketingJobId: doc.job_id,
      stage: 'production',
    });

    // No image_creatives at all — treat as "no images requested" path, not a failure.
    await handleHermesRunCallback({
      event_id: 'evt-failloud-no-creatives',
      aries_run_id: run.aries_run_id,
      hermes_run_id: 'hermes-failloud-3',
      status: 'requires_approval',
      stage: 'production',
      approval: {
        stage: 'publish',
        approval_step: 'approve_publish',
        workflow_step_id: 'approve_stage_4',
        prompt: 'Review creative assets before publish review',
        resume_token: 'social_content_weekly:arun_abc:production',
      },
      output: [
        {
          stage: 'production',
          weekly_content_plan: {
            posts: [],
            image_creatives: [],  // empty array — no images were requested/expected
            video_scripts: [],
          },
        },
      ],
    });

    const after = await loadMarketingJobRuntime(doc.job_id);
    assert.ok(
      after?.stages.production.status !== 'failed',
      'should not fail when image_creatives is empty (no images requested)',
    );
  });
});
