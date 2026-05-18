import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBrandKitPayload } from '../../backend/social-content/brand-kit-payload';
import {
  buildProductionResumeContext,
  buildSocialContentWeeklyRequest,
} from '../../backend/social-content/workflow-request';
import type { MarketingBrandKitReference, MarketingJobRuntimeDocument } from '../../backend/marketing/runtime-state';

function makeBrandKit(overrides: Partial<MarketingBrandKitReference> = {}): MarketingBrandKitReference {
  return {
    path: '/tmp/brand-kit.json',
    source_url: 'https://brand.example/',
    canonical_url: 'https://brand.example/',
    brand_name: 'Brand Example',
    brand_voice_summary: 'Warm, direct guidance for ambitious operators.',
    offer_summary: 'Operator coaching intensives.',
    positioning: 'Proof-led operator coaching.',
    audience: 'Operators building the next layer of systems.',
    tone_of_voice: 'Grounded and premium.',
    style_vibe: 'Editorial warmth with sharp proof points.',
    colors: {
      primary: '#111111',
      secondary: '#f4f4f4',
      accent: '#c24d2c',
      palette: ['#111111', '#f4f4f4', '#c24d2c'],
    },
    logo_urls: [
      'https://brand.example/logo.svg?token=secret',
      'data:image/svg+xml;base64,xyz',
    ],
    font_families: ['Inter', 'inter', 'Manrope'],
    external_links: [],
    extracted_at: '2026-05-18T00:00:00.000Z',
    ...overrides,
  };
}

function makeDoc(overrides: Record<string, unknown> = {}): MarketingJobRuntimeDocument {
  return {
    schema_name: 'marketing_job_runtime',
    schema_version: '1.0.0',
    job_id: 'mkt_brand_payload',
    tenant_id: 'tenant_brand_payload',
    created_at: '2026-05-18T00:00:00.000Z',
    updated_at: '2026-05-18T00:00:00.000Z',
    status: 'in_progress',
    current_stage: 'production',
    stage_order: ['research', 'strategy', 'production', 'publish'],
    stages: {
      research: { status: 'completed', outputs: {}, primary_output: null, started_at: null, completed_at: null },
      strategy: { status: 'completed', outputs: {}, primary_output: null, started_at: null, completed_at: null },
      production: { status: 'pending', outputs: {}, primary_output: null, started_at: null, completed_at: null },
      publish: { status: 'pending', outputs: {}, primary_output: null, started_at: null, completed_at: null },
    },
    approvals: { current: null, history: [] },
    publish_config: { enabled: false, channels: [] },
    brand_kit: makeBrandKit(),
    inputs: {
      brand_url: 'https://brand.example/',
      competitor_url: 'https://competitor.example/',
      competitor_brand: 'Competitor',
      facebook_page_url: null,
      ad_library_url: null,
      request: {
        businessName: 'Brand Example',
        businessType: 'Operator coaching',
        primaryGoal: 'Book more consulting calls',
        goal: 'Book more consulting calls',
        offer: 'Operator coaching intensives',
        audience: 'Operators building the next layer of systems',
        toneOfVoice: 'Grounded and premium',
        brandVoice: 'Warm, direct guidance for ambitious operators.',
        styleVibe: 'Editorial warmth with sharp proof points.',
        channels: ['instagram', 'meta'],
        windowDays: 7,
        staticPostCount: 3,
        imageCreativeCount: 2,
        videoScriptCount: 1,
        videoRenderCount: 0,
        visualReferences: [
          'https://brand.example/lookbook?token=secret&sig=abc',
          ' https://brand.example/lookbook?token=secret&sig=abc ',
          'https://brand.example/editorial?client_secret=hunter2',
        ],
        mustAvoidAesthetics: 'grainy mockups; low-effort templates\nwashed out stock',
        notes: 'Lead with premium proof, not generic hustle slogans.',
      },
    },
    ...overrides,
  } as unknown as MarketingJobRuntimeDocument;
}

test('buildBrandKitPayload sanitizes visual references, strips token-like params, and dedupes fonts', () => {
  const payload = buildBrandKitPayload(makeDoc(), makeBrandKit(), {
    businessName: 'Brand Example',
    businessType: 'Operator coaching',
    primaryGoal: 'Book more consulting calls',
    goal: 'Book more consulting calls',
    offer: 'Operator coaching intensives',
    audience: 'Operators building the next layer of systems',
    toneOfVoice: 'Grounded and premium',
    visualReferences: [
      'https://brand.example/lookbook?token=secret&sig=abc',
      'https://brand.example/editorial?client_secret=hunter2',
    ],
  });

  assert.deepEqual(payload.brand.visual_references, [
    'https://brand.example/lookbook',
    'https://brand.example/editorial',
  ]);
  assert.deepEqual(payload.brand.logo_urls, [
    'https://brand.example/logo.svg',
    'data:image/svg+xml;base64,xyz',
  ]);
  assert.deepEqual(payload.brand.font_families, ['Inter', 'Manrope']);
});

test('buildBrandKitPayload falls back to request data from the runtime doc when onboarding is omitted', () => {
  const payload = buildBrandKitPayload(makeDoc(), makeBrandKit(), null);

  assert.equal(payload.brand.name, 'Brand Example');
  assert.equal(payload.brand.business_type, 'Operator coaching');
  assert.equal(payload.objective.primary_goal, 'Book more consulting calls');
  assert.equal(payload.objective.offer, 'Operator coaching intensives');
  assert.equal(payload.objective.audience, 'Operators building the next layer of systems');
});

test('buildBrandKitPayload carries helper-only defaults without mutating weekly constraints shape', () => {
  const payload = buildBrandKitPayload(makeDoc(), makeBrandKit(), null);

  assert.equal(payload.brand.notes, 'Lead with premium proof, not generic hustle slogans.');
  assert.ok(payload.brand.must_avoid_aesthetics.includes('grainy mockups'));
  assert.ok(payload.brand.must_avoid_aesthetics.includes('washed out stock'));
  assert.ok(payload.brand.must_avoid_aesthetics.includes('split-screen'));
  assert.equal(payload.brand.voice, 'Warm, direct guidance for ambitious operators. Tone: Grounded and premium..');
});

test('buildSocialContentWeeklyRequest keeps the weekly payload byte-shape stable after brand-kit helper extraction', () => {
  const actual = buildSocialContentWeeklyRequest({
    doc: makeDoc(),
    ariesRunId: 'arun_weekly_regression',
    callbackUrl: 'https://aries.example.com/api/internal/hermes/runs',
  });

  const expected = {
    workflow_key: 'social_content_weekly',
    workflow_version: '2026-05-social-content-weekly-v2',
    aries_run_id: 'arun_weekly_regression',
    tenant_id: 'tenant_brand_payload',
    job_id: 'mkt_brand_payload',
    callback_url: 'https://aries.example.com/api/internal/hermes/runs',
    input: {
      brand: {
        url: 'https://brand.example/',
        name: 'Brand Example',
        business_type: 'Operator coaching',
        voice: 'Warm, direct guidance for ambitious operators. Tone: Grounded and premium..',
        style_vibe: 'Editorial warmth with sharp proof points.',
        visual_references: [
          'https://brand.example/lookbook',
          'https://brand.example/lookbook',
          'https://brand.example/editorial',
        ],
        logo_urls: ['https://brand.example/logo.svg', 'data:image/svg+xml;base64,xyz'],
        colors: {
          primary: '#111111',
          secondary: '#f4f4f4',
          accent: '#c24d2c',
          palette: ['#111111', '#f4f4f4', '#c24d2c'],
        },
        font_families: ['Inter', 'Manrope'],
        offer: 'Operator coaching intensives',
        notes: 'Lead with premium proof, not generic hustle slogans.',
        must_avoid_aesthetics: [
          'grainy mockups',
          'low-effort templates',
          'washed out stock',
          'split-screen',
          'before/after',
          'side-by-side comparison',
          'two-panel layout',
          'old way vs new way',
          'generic stock office',
        ],
      },
      objective: {
        primary_goal: 'Book more consulting calls',
        offer: 'Operator coaching intensives',
        audience: 'Operators building the next layer of systems',
      },
      competitor: {
        url: 'https://competitor.example/',
        brand: 'Competitor',
        facebook_page_url: '',
        ad_library_url: '',
      },
      scope: {
        window_days: 7,
        static_post_count: 3,
        image_creative_count: 2,
        video_script_count: 1,
        video_render_count: 0,
        channels: ['instagram', 'meta'],
      },
      constraints: {
        must_use_copy: '',
        must_avoid_aesthetics: 'grainy mockups; low-effort templates\nwashed out stock',
        forbidden_visual_patterns: [
          'split-screen',
          'before/after',
          'side-by-side comparison',
          'two-panel layout',
          'old way vs new way',
          'generic stock office',
        ],
      },
      media_requests: [
        {
          type: 'image.generate',
          aspect_ratio: '4:5',
          count: 2,
          target_channels: ['instagram', 'meta'],
          creative_briefs: [
            'Book more consulting calls',
            'Operator coaching intensives',
            'Editorial warmth with sharp proof points.',
            'Operators building the next layer of systems',
          ],
        },
      ],
    },
  };

  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
});

test('buildProductionResumeContext keeps the production resume shape byte-stable after brand-kit helper extraction', () => {
  const actual = buildProductionResumeContext({
    doc: makeDoc({
      inputs: {
        brand_url: 'https://brand.example/',
        competitor_url: 'https://competitor.example/',
        competitor_brand: 'Competitor',
        facebook_page_url: null,
        ad_library_url: null,
        request: {
          businessName: 'Brand Example',
          businessType: 'Operator coaching',
          primaryGoal: 'Book more consulting calls',
          goal: 'Book more consulting calls',
          offer: 'Operator coaching intensives',
          audience: 'Operators building the next layer of systems',
          brandVoice: 'Warm, direct guidance for ambitious operators.',
          toneOfVoice: 'Grounded and premium',
          styleVibe: 'Editorial warmth with sharp proof points.',
          channels: ['instagram', 'meta'],
          windowDays: 7,
          imageCreativeCount: 1,
          mustAvoidAesthetics: 'grainy mockups; low-effort templates',
        },
      },
    }),
    researchOutput: null,
    strategyOutput: null,
  });

  const prompt = [
    'Generate an image to use for social media content.',
    'This is part of a 7-day collection of posts to publish throughout the week.',
    'This is image 1 of 1.',
    '',
    'Brand: Brand Example',
    'Offer: Operator coaching intensives',
    'Brand voice: Warm, direct guidance for ambitious operators. Tone: Grounded and premium..',
    'Style and vibe: Editorial warmth with sharp proof points.',
    'Brand palette: #111111, #f4f4f4, #c24d2c',
    'Must avoid: grainy mockups, low-effort templates, split-screen, before/after, side-by-side comparison, two-panel layout',
    '',
    'Target platforms: instagram, meta',
    'Aspect ratio: 4:5 (instagram: portrait 4:5, meta: square 1:1 or landscape 1.91:1)',
    'Use 4:5 framing to maximise visual impact on these platforms.',
  ].join('\n');

  const expected = {
    imagePrompts: [
      {
        imageIndex: 1,
        totalImages: 1,
        prompt,
        aspectRatio: '4:5',
        targetChannels: ['instagram', 'meta'],
      },
    ],
    contextBlock: [
      'Production context (1 image requested):',
      '--- Image 1 of 1 ---',
      prompt,
      '',
      'Return your results in this EXACT JSON shape:',
      '',
      'When you finish image_generate, place the results in your final response under `artifacts.creative_assets[]` with this shape per item:',
      '',
      '{',
      '  "assetId": "img_0",',
      '  "type": "generated_image",',
      '  "path": "<absolute path returned by image_generate>",',
      '  "placement": "<which post>",',
      '  "prompt": "<the rendered prompt>"',
      '}',
      '',
      'The bridge will also accept `artifacts.images[]` with `{index, status:"generated", filePath, prompt, intendedUse}`, but `creative_assets` is preferred.',
    ].join('\n'),
  };

  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
});
