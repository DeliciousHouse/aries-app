/**
 * Slice 3 — buildProductionResumeContext emits a 9:16 video brief + the
 * VIDEO_EXECUTION_CONTRACT schema when videoRenderCount > 0 AND
 * ARIES_VIDEO_PUBLISH_ENABLED is on.
 *
 * CRITICAL golden no-op test: when videoRenderCount === 0 (or flag off) the
 * contextBlock is byte-identical to the pre-change baseline.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/social-content/video-production-context.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildProductionResumeContext } from '../../backend/social-content/workflow-request';
import type { SocialContentJobRuntimeDocument } from '../../backend/marketing/runtime-state';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function makeDoc(videoRenderCount = 0): SocialContentJobRuntimeDocument {
  const ts = '2026-06-23T00:00:00.000Z';
  const stage = (name: string, status: string) => ({
    stage: name, status, started_at: ts, completed_at: null, failed_at: null,
    run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [],
  });
  return {
    schema_name: 'marketing_job_state_schema',
    schema_version: '1.0.0',
    job_id: 'mkt_video_ctx',
    tenant_id: '15',
    job_type: 'weekly_social_content',
    state: 'running',
    status: 'running',
    current_stage: 'production',
    stage_order: ['research', 'strategy', 'production', 'publish'],
    stages: {
      research: { ...stage('research', 'completed'), stage: 'research' },
      strategy: { ...stage('strategy', 'completed'), stage: 'strategy' },
      production: { ...stage('production', 'in_progress'), stage: 'production' },
      publish: { ...stage('publish', 'not_started'), stage: 'publish' },
    } as SocialContentJobRuntimeDocument['stages'],
    approvals: { current: null, history: [] },
    publish_config: { platforms: [], live_publish_platforms: [], video_render_platforms: [] },
    brand_kit: {
      source_url: 'https://brand.example/',
      canonical_url: 'https://brand.example/',
      brand_name: 'Test Brand',
      logo_urls: ['https://brand.example/logo.svg'],
      colors: { primary: '#111111', secondary: '#f4f4f4', accent: null, palette: ['#111111', '#f4f4f4'] },
      font_families: ['Inter'],
      external_links: [],
      extracted_at: ts,
      brand_voice_summary: 'Direct and warm.',
      offer_summary: null,
      positioning: null,
      audience: null,
      tone_of_voice: null,
      style_vibe: null,
      path: '/tmp/brand-kit.json',
    },
    inputs: {
      brand_url: 'https://brand.example/',
      request: {
        imageCreativeCount: 1,
        videoRenderCount,
        channels: ['instagram'],
      },
    },
    errors: [], last_error: null, history: [], created_at: ts, updated_at: ts,
    social_content_runtime: null, created_by: null, deleted_at: null, deleted_by: null,
    soft_cancel_requested_at: null,
  } as SocialContentJobRuntimeDocument;
}

function withVideoFlag<T>(value: '0' | '1', fn: () => T): T {
  const prev = process.env.ARIES_VIDEO_PUBLISH_ENABLED;
  process.env.ARIES_VIDEO_PUBLISH_ENABLED = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.ARIES_VIDEO_PUBLISH_ENABLED;
    else process.env.ARIES_VIDEO_PUBLISH_ENABLED = prev;
  }
}

// ---------------------------------------------------------------------------
// Slice 3 — video brief emission
// ---------------------------------------------------------------------------

test('flag ON + videoRenderCount=1: contextBlock emits 9:16 aspect ratio in video clip section', () => {
  // FAIL BEFORE: video section was not emitted at all (videoClipCount always 0 or not wired)
  // PASS AFTER:  video clip section appears with "9:16" aspect ratio
  withVideoFlag('1', () => {
    const { contextBlock } = buildProductionResumeContext({
      doc: makeDoc(1),
      researchOutput: null,
      strategyOutput: null,
    });
    assert.match(contextBlock, /Aspect ratio: 9:16/, 'video clip section must declare 9:16 aspect ratio');
    assert.match(contextBlock, /Video context \(1 video requested\):/, 'video block must announce the count, mirroring the image "Production context (N images requested)" header');
    assert.match(contextBlock, /--- Video 1 of 1 ---/, 'video clip header must mirror the "--- Image N of M ---" format');
    assert.match(contextBlock, /Target duration:.*15 seconds/, 'target duration must be stated');
  });
});

test('flag ON + videoRenderCount=1: contextBlock emits the VIDEO_EXECUTION_CONTRACT schema fields', () => {
  withVideoFlag('1', () => {
    const { contextBlock } = buildProductionResumeContext({
      doc: makeDoc(1),
      researchOutput: null,
      strategyOutput: null,
    });
    // Schema emitted in the context block
    assert.match(contextBlock, /"type": "generated_video"/, 'schema must specify type: generated_video');
    assert.match(contextBlock, /"media_type": "video"/, 'schema must specify media_type: video');
    assert.match(contextBlock, /"surface": "reel"/, 'schema must specify surface: reel');
    assert.match(contextBlock, /"duration_seconds"/, 'schema must include duration_seconds field');
    assert.match(contextBlock, /width.*height/, 'schema must mention width and height');
    assert.match(contextBlock, /MANDATORY.*width.*height.*duration_seconds/i, 'MANDATORY clause for dims must be present');
  });
});

test('flag ON + videoRenderCount=1: videoPrompts is returned with aspectRatio 9:16', () => {
  withVideoFlag('1', () => {
    const result = buildProductionResumeContext({
      doc: makeDoc(1),
      researchOutput: null,
      strategyOutput: null,
    });
    assert.ok(result.videoPrompts && result.videoPrompts.length > 0, 'videoPrompts must be non-empty when flag ON');
    const vp = result.videoPrompts![0]!;
    assert.equal(vp.aspectRatio, '9:16', 'videoPrompt aspectRatio must be 9:16');
    assert.equal(vp.clipIndex, 1);
    assert.equal(vp.totalClips, 1);
    assert.ok(typeof vp.targetDurationSeconds === 'number', 'targetDurationSeconds must be a number');
    assert.ok(vp.prompt.length > 0, 'prompt must be non-empty');
  });
});

test('flag ON + videoRenderCount=2: clamped to MAX (1) — only 1 clip in this pass', () => {
  // SOCIAL_CONTENT_MAX_VIDEO_RENDER_COUNT = 1 in this pass (single-clip MVP).
  // The request with videoRenderCount=2 is clamped to 1 by clampCount().
  withVideoFlag('1', () => {
    const { contextBlock, videoPrompts } = buildProductionResumeContext({
      doc: makeDoc(2),
      researchOutput: null,
      strategyOutput: null,
    });
    // Clamped to 1, so header reads "1 of 1" (not "1 of 2").
    assert.match(contextBlock, /--- Video 1 of 1 ---/, 'clamped to 1 clip');
    assert.ok(!contextBlock.includes('--- Video 2 of'), 'no second clip section');
    assert.equal(videoPrompts?.length, 1, 'exactly 1 videoPrompt returned (clamped)');
  });
});

// ---------------------------------------------------------------------------
// CRITICAL golden no-op: byte-identical when flag OFF or videoRenderCount=0
// ---------------------------------------------------------------------------

test('GOLDEN: flag OFF → contextBlock is byte-identical regardless of videoRenderCount', () => {
  // This is the core regression guard: the flag OFF path must be byte-identical
  // to the baseline (no video section, no schema, no dims). If this test breaks,
  // the contextBlock changed for existing jobs and is a regression.
  const baseline = withVideoFlag('0', () =>
    buildProductionResumeContext({ doc: makeDoc(0), researchOutput: null, strategyOutput: null }).contextBlock
  );
  withVideoFlag('0', () => {
    const withCount = buildProductionResumeContext({ doc: makeDoc(1), researchOutput: null, strategyOutput: null }).contextBlock;
    assert.equal(withCount, baseline, 'flag OFF + videoRenderCount=1 must equal the 0-count baseline');
    const withTwo = buildProductionResumeContext({ doc: makeDoc(2), researchOutput: null, strategyOutput: null }).contextBlock;
    assert.equal(withTwo, baseline, 'flag OFF + videoRenderCount=2 must equal the 0-count baseline');
  });
});

test('GOLDEN: flag unset → contextBlock byte-identical to flag OFF', () => {
  const baseline = withVideoFlag('0', () =>
    buildProductionResumeContext({ doc: makeDoc(0), researchOutput: null, strategyOutput: null }).contextBlock
  );
  const prevFlag = process.env.ARIES_VIDEO_PUBLISH_ENABLED;
  delete process.env.ARIES_VIDEO_PUBLISH_ENABLED;
  try {
    const unset = buildProductionResumeContext({ doc: makeDoc(1), researchOutput: null, strategyOutput: null }).contextBlock;
    assert.equal(unset, baseline, 'flag unset must be byte-identical to flag=0 baseline');
  } finally {
    if (prevFlag === undefined) delete process.env.ARIES_VIDEO_PUBLISH_ENABLED;
    else process.env.ARIES_VIDEO_PUBLISH_ENABLED = prevFlag;
  }
});

test('GOLDEN: flag ON + videoRenderCount=0 → contextBlock byte-identical to baseline', () => {
  const baseline = withVideoFlag('0', () =>
    buildProductionResumeContext({ doc: makeDoc(0), researchOutput: null, strategyOutput: null }).contextBlock
  );
  withVideoFlag('1', () => {
    const ctx = buildProductionResumeContext({ doc: makeDoc(0), researchOutput: null, strategyOutput: null }).contextBlock;
    assert.equal(ctx, baseline, 'flag ON + videoRenderCount=0 must be byte-identical (no video section)');
  });
});

test('GOLDEN: videoPrompts absent when flag OFF', () => {
  withVideoFlag('0', () => {
    const result = buildProductionResumeContext({ doc: makeDoc(1), researchOutput: null, strategyOutput: null });
    assert.ok(!result.videoPrompts || result.videoPrompts.length === 0, 'videoPrompts must be absent when flag OFF');
  });
});

test('GOLDEN: videoPrompts absent when videoRenderCount=0 even with flag ON', () => {
  withVideoFlag('1', () => {
    const result = buildProductionResumeContext({ doc: makeDoc(0), researchOutput: null, strategyOutput: null });
    assert.ok(!result.videoPrompts || result.videoPrompts.length === 0, 'videoPrompts must be absent when count=0');
  });
});

// ---------------------------------------------------------------------------
// Guard: existing image-only contextBlock is not disturbed when flag ON
// ---------------------------------------------------------------------------

test('image section is unaffected by video flag — image prompts still emitted', () => {
  withVideoFlag('1', () => {
    const { contextBlock, imagePrompts } = buildProductionResumeContext({
      doc: makeDoc(1),
      researchOutput: null,
      strategyOutput: null,
    });
    assert.ok(imagePrompts.length > 0, 'image prompts must still be emitted');
    assert.match(contextBlock, /--- Image 1 of/, 'image section header must appear');
    assert.match(contextBlock, /"type": "generated_image"/, 'image schema must still appear');
  });
});
