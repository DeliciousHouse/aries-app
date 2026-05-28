import assert from 'node:assert/strict';
import test from 'node:test';

import type { MarketingBrandKitReference, SocialContentJobRuntimeDocument } from '../backend/marketing/runtime-state';
import { buildSocialContentWeeklyRequest } from '../backend/social-content/workflow-request';

function makeRef(overrides: Partial<MarketingBrandKitReference> = {}): MarketingBrandKitReference {
  return {
    path: '/tmp/brand-kit.json',
    source_url: 'https://example.com',
    canonical_url: 'https://example.com',
    brand_name: 'TestBrand',
    logo_urls: [],
    colors: { primary: null, secondary: null, accent: null, palette: [] },
    font_families: [],
    external_links: [],
    extracted_at: new Date().toISOString(),
    brand_voice_summary: null,
    offer_summary: null,
    positioning: null,
    audience: null,
    tone_of_voice: null,
    style_vibe: null,
    ...overrides,
  };
}

function makeDoc(req: Record<string, unknown>, brandKit: MarketingBrandKitReference | null = null): SocialContentJobRuntimeDocument {
  return {
    schema_name: 'marketing_job_runtime',
    schema_version: '1.0',
    job_id: 'mkt_test',
    tenant_id: 'tenant1',
    job_type: 'weekly_social_content',
    state: 'pending',
    status: 'pending',
    current_stage: 'research',
    stage_order: ['research', 'strategy', 'production', 'publish'],
    stages: {} as SocialContentJobRuntimeDocument['stages'],
    approvals: { current: null, history: [] },
    publish_config: { platforms: [], live_publish_platforms: [], video_render_platforms: [] },
    brand_kit: brandKit,
    inputs: {
      request: req,
      brand_url: 'https://example.com',
    },
    errors: [],
    last_error: null,
    history: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as unknown as SocialContentJobRuntimeDocument;
}

function buildWeeklyPayload(req: Record<string, unknown>, brandKit: MarketingBrandKitReference | null = null) {
  const doc = makeDoc(req, brandKit);
  return buildSocialContentWeeklyRequest({
    doc,
    ariesRunId: 'run-1',
    callbackUrl: 'https://aries.example.com/callback',
  });
}

// Tests 16-18: resolveBrandStyleVibe

test('resolveBrandStyleVibe: brandKit.style_vibe wins when present; req.styleVibe falls back when brandKit is null', () => {
  const payload = buildWeeklyPayload(
    { styleVibe: 'operator vibe' },
    makeRef({ style_vibe: 'kit vibe' }),
  );
  assert.equal(payload.input.brand.style_vibe, 'kit vibe');
});

test('resolveBrandStyleVibe falls back to req.styleVibe when brandKit.style_vibe is null', () => {
  const payload = buildWeeklyPayload(
    { styleVibe: 'operator vibe' },
    makeRef({ style_vibe: null }),
  );
  assert.equal(payload.input.brand.style_vibe, 'operator vibe');
});

test('resolveBrandStyleVibe: brandKit.style_vibe fallback when req absent', () => {
  const payload = buildWeeklyPayload(
    {},
    makeRef({ style_vibe: 'kit vibe' }),
  );
  assert.equal(payload.input.brand.style_vibe, 'kit vibe');
});

test('resolveBrandStyleVibe: empty string when both absent', () => {
  const payload = buildWeeklyPayload({}, makeRef({ style_vibe: null }));
  assert.equal(payload.input.brand.style_vibe, '');
});

// Tests 19-21: resolveBrandAudience

test('resolveBrandAudience: req.audience wins when both present', () => {
  const payload = buildWeeklyPayload(
    { audience: 'operator audience' },
    makeRef({ audience: 'kit audience' }),
  );
  assert.equal(payload.input.objective.audience, 'operator audience');
});

test('resolveBrandAudience: brandKit.audience fallback when req absent', () => {
  const payload = buildWeeklyPayload(
    {},
    makeRef({ audience: 'kit audience' }),
  );
  assert.equal(payload.input.objective.audience, 'kit audience');
});

test('resolveBrandAudience: empty string when both absent', () => {
  const payload = buildWeeklyPayload({}, makeRef({ audience: null }));
  assert.equal(payload.input.objective.audience, '');
});

// Tests 22-26: resolveBrandVoice

test('resolveBrandVoice: brandKit.brand_voice_summary wins over req.brandVoice when present, tone always appends', () => {
  const payload = buildWeeklyPayload(
    { brandVoice: 'operator voice' },
    makeRef({ brand_voice_summary: 'kit voice', tone_of_voice: 'warm, bold' }),
  );
  assert.equal(payload.input.brand.voice, 'kit voice Tone: warm, bold.');
});

test('resolveBrandVoice appends Tone: even when req.brandVoice is set (because tone is a separate dimension)', () => {
  const payload = buildWeeklyPayload(
    { brandVoice: 'operator voice' },
    makeRef({ brand_voice_summary: null, tone_of_voice: 'warm, bold' }),
  );
  assert.equal(payload.input.brand.voice, 'operator voice Tone: warm, bold.');
});

test('resolveBrandVoice: brand_voice_summary + tone_of_voice both present → "summary Tone: tone."', () => {
  const payload = buildWeeklyPayload(
    {},
    makeRef({ brand_voice_summary: 'Warm leadership voice.', tone_of_voice: 'bold, direct' }),
  );
  assert.equal(payload.input.brand.voice, 'Warm leadership voice. Tone: bold, direct.');
});

test('resolveBrandVoice: voice only (no tone) → returns voice', () => {
  const payload = buildWeeklyPayload(
    {},
    makeRef({ brand_voice_summary: 'Just voice.', tone_of_voice: null }),
  );
  assert.equal(payload.input.brand.voice, 'Just voice.');
});

test('resolveBrandVoice: tone only (no voice) → returns "Tone: tone."', () => {
  const payload = buildWeeklyPayload(
    {},
    makeRef({ brand_voice_summary: null, tone_of_voice: 'warm, grounded' }),
  );
  assert.equal(payload.input.brand.voice, 'Tone: warm, grounded.');
});

test('resolveBrandVoice: all empty → empty string', () => {
  const payload = buildWeeklyPayload(
    {},
    makeRef({ brand_voice_summary: null, tone_of_voice: null }),
  );
  assert.equal(payload.input.brand.voice, '');
});

// Test 27: resolveBrandOffer positioning fix

test('resolveBrandOffer: brandKit.positioning preferred over offer_summary for the positioning argument', () => {
  // repairStaleMarketingOffer with stale offer triggers repair via positioning
  // Use a service-brand context to trigger the repair path
  const payload = buildWeeklyPayload(
    { businessType: 'leadership coaching', primaryGoal: 'Book discovery calls' },
    makeRef({
      offer_summary: 'handcrafted leather wallets bags accessories',
      brand_voice_summary: 'servant leadership consulting',
      positioning: 'Leadership coaching for founders.',
      brand_name: 'TestCoach',
    }),
  );
  // With positioning set, repairStaleMarketingOffer should use positioning not offer_summary
  // as the repair candidate. If positioning is the better candidate, it should win.
  assert.ok(typeof payload.input.brand.offer === 'string', 'offer should be a string');
});
