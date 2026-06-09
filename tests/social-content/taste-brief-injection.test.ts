/**
 * PR2 Phase 2 — the taste-brief injection read path.
 *
 * The load-bearing guarantee: when the projection is null/empty OR the
 * ARIES_TASTE_BRIEF_INJECTION_ENABLED flag is OFF, buildProductionResumeContext
 * produces BYTE-IDENTICAL output to today (the ~40 existing callers + the
 * brand-kit-payload byte-stable golden must not shift). When the flag is ON and
 * a populated projection is passed, the learned descriptors splice into the
 * exact brand prompt fields (style / voice / must-avoid / audience).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildProductionResumeContext } from '../../backend/social-content/workflow-request';
import type { TasteDimensions } from '../../backend/marketing/taste-profile-store';
import type { MarketingBrandKitReference, SocialContentJobRuntimeDocument } from '../../backend/marketing/runtime-state';

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
    logo_urls: ['https://brand.example/logo.svg'],
    font_families: ['Inter', 'Manrope'],
    external_links: [],
    extracted_at: '2026-05-18T00:00:00.000Z',
    ...overrides,
  };
}

function makeDoc(): SocialContentJobRuntimeDocument {
  return {
    schema_name: 'marketing_job_runtime',
    schema_version: '1.0.0',
    job_id: 'mkt_taste_brief',
    tenant_id: 'tenant_taste_brief',
    created_at: '2026-06-09T00:00:00.000Z',
    updated_at: '2026-06-09T00:00:00.000Z',
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
        videoScriptCount: 0,
        videoRenderCount: 0,
        mustAvoidAesthetics: 'grainy mockups; low-effort templates',
        notes: 'Lead with premium proof.',
      },
    },
  } as unknown as SocialContentJobRuntimeDocument;
}

const POPULATED: TasteDimensions = {
  style_descriptors: ['Quiet Luxury'],
  voice_descriptors: ['Calm authority'],
  audience_descriptors: ['Founders scaling past $1M'],
  avoid: ['stock photography', 'grainy mockups'], // 'grainy mockups' already in base must-avoid → dedupe
};

const EMPTY: TasteDimensions = {
  style_descriptors: [],
  voice_descriptors: [],
  audience_descriptors: [],
  avoid: [],
};

function withFlag<T>(value: '0' | '1', fn: () => T): T {
  const prev = process.env.ARIES_TASTE_BRIEF_INJECTION_ENABLED;
  process.env.ARIES_TASTE_BRIEF_INJECTION_ENABLED = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.ARIES_TASTE_BRIEF_INJECTION_ENABLED;
    else process.env.ARIES_TASTE_BRIEF_INJECTION_ENABLED = prev;
  }
}

function build(tasteProjection?: TasteDimensions | null) {
  return buildProductionResumeContext({
    doc: makeDoc(),
    researchOutput: null,
    strategyOutput: null,
    tasteProjection,
  });
}

test('byte-identical: no tasteProjection arg === explicit null === all-empty projection (flag OFF)', () => {
  withFlag('0', () => {
    const baseline = build();
    assert.equal(build(null).contextBlock, baseline.contextBlock, 'null projection is byte-identical');
    assert.equal(build(EMPTY).contextBlock, baseline.contextBlock, 'empty projection is byte-identical');
    assert.equal(build(POPULATED).contextBlock, baseline.contextBlock, 'flag OFF gates a populated projection');
  });
});

test('byte-identical: a populated projection with the flag ON but all-empty arrays stays identical', () => {
  const baselineOff = withFlag('0', () => build());
  withFlag('1', () => {
    assert.equal(build(null).contextBlock, baselineOff.contextBlock, 'flag ON + null === baseline');
    assert.equal(build(EMPTY).contextBlock, baselineOff.contextBlock, 'flag ON + empty arrays === baseline');
  });
});

test('flag ON + populated projection splices learned descriptors into the exact brand fields', () => {
  const baseline = withFlag('0', () => build());
  withFlag('1', () => {
    const ctx = build(POPULATED).contextBlock;
    assert.notEqual(ctx, baseline.contextBlock, 'output changes when injection is active');
    // style_descriptors → Style and vibe line (appended as a "; " suffix)
    assert.match(ctx, /Style and vibe:.*Quiet Luxury/, 'style descriptor appended to Style and vibe');
    // voice_descriptors → Brand voice line
    assert.match(ctx, /Brand voice:.*Calm authority/, 'voice descriptor appended to Brand voice');
    // avoid → Must avoid line, deduped against the base must-avoid
    assert.match(ctx, /Must avoid:.*stock photography/, 'avoid descriptor appended to Must avoid');
    const mustAvoidLine = ctx.split('\n').find((l) => l.startsWith('Must avoid:')) ?? '';
    const grainyHits = (mustAvoidLine.match(/grainy mockups/g) ?? []).length;
    assert.equal(grainyHits, 1, "duplicate 'grainy mockups' is deduped, not repeated");
    // audience_descriptors → a dedicated learned-audience line
    assert.match(ctx, /Audience focus \(learned\):.*Founders scaling past \$1M/, 'audience descriptor emits a learned line');
  });
});
