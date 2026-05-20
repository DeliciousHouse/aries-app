/**
 * Tests for brand-kit enrichment operator precedence (Fix for Regression 2).
 *
 * Verifies that:
 *   1. Operator-supplied styleVibe survives enrichment — enrichment MUST NOT override it.
 *   2. Operator-supplied brandVoice survives enrichment — enrichment MUST NOT override tone_of_voice.
 *   3. Fields the operator did NOT supply are correctly filled by enrichment.
 *   4. When no operator overrides are provided, enrichment behaves as before.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { applyBrandKitEnrichment } from '../../backend/marketing/brand-kit-enrich';
import type { TenantBrandKit } from '../../backend/marketing/brand-kit';
import type { BrandKitEnrichment } from '../../backend/marketing/brand-kit-enrich';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBaseBrandKit(overrides: Partial<TenantBrandKit> = {}): TenantBrandKit {
  return {
    tenant_id: 'test-tenant',
    source_url: 'https://example.com',
    canonical_url: 'https://example.com',
    brand_name: 'Test Brand',
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

function makeEnrichment(overrides: Partial<BrandKitEnrichment> = {}): BrandKitEnrichment {
  return {
    brandVoiceSummary: 'LLM-generated brand voice summary',
    offerSummary: 'LLM-generated offer summary',
    positioning: 'LLM-generated positioning',
    audience: 'LLM-generated audience',
    toneOfVoice: 'bright, clean, modern, minimal',
    styleVibe: 'bright, clean, modern, minimal, organized',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests — operator styleVibe preservation
// ---------------------------------------------------------------------------

test('applyBrandKitEnrichment: operator styleVibe is NOT overwritten by enrichment', () => {
  const base = makeBaseBrandKit({ style_vibe: null });
  const enrichment = makeEnrichment({ styleVibe: 'bright, clean, modern' });
  const operatorOverrides = { styleVibe: 'Dark minimal builder aesthetic with subtle purple accents' };

  const result = applyBrandKitEnrichment(base, enrichment, operatorOverrides);

  assert.strictEqual(
    result.style_vibe,
    'Dark minimal builder aesthetic with subtle purple accents',
    'Operator styleVibe must be preserved — enrichment must not override it',
  );
});

test('applyBrandKitEnrichment: operator styleVibe wins over existing base style_vibe too', () => {
  const base = makeBaseBrandKit({ style_vibe: 'existing base style vibe' });
  const enrichment = makeEnrichment({ styleVibe: 'LLM style vibe' });
  const operatorOverrides = { styleVibe: 'Dark minimal builder aesthetic' };

  const result = applyBrandKitEnrichment(base, enrichment, operatorOverrides);

  assert.strictEqual(
    result.style_vibe,
    'Dark minimal builder aesthetic',
    'Operator styleVibe must win over both base and enrichment',
  );
});

// ---------------------------------------------------------------------------
// Tests — operator brandVoice preservation
// ---------------------------------------------------------------------------

test('applyBrandKitEnrichment: operator brandVoice prevents enrichment from overwriting tone_of_voice', () => {
  const base = makeBaseBrandKit({ tone_of_voice: null });
  const enrichment = makeEnrichment({ toneOfVoice: 'casual, friendly, bright' });
  const operatorOverrides = { brandVoice: 'Dark, minimal, authoritative' };

  const result = applyBrandKitEnrichment(base, enrichment, operatorOverrides);

  // When operator set brandVoice, tone_of_voice should NOT be set from enrichment
  // (it will be null since base is null; enrichment is blocked)
  assert.strictEqual(
    result.tone_of_voice,
    null,
    'When operator provided brandVoice, enrichment must not overwrite tone_of_voice with different adjectives',
  );
});

test('applyBrandKitEnrichment: operator brandVoice preserves existing base tone_of_voice', () => {
  const base = makeBaseBrandKit({ tone_of_voice: 'Dark minimal tone from prior scrape' });
  const enrichment = makeEnrichment({ toneOfVoice: 'casual, friendly, bright' });
  const operatorOverrides = { brandVoice: 'Dark minimal, authoritative' };

  const result = applyBrandKitEnrichment(base, enrichment, operatorOverrides);

  assert.strictEqual(
    result.tone_of_voice,
    'Dark minimal tone from prior scrape',
    'When operator provided brandVoice, existing base tone_of_voice must be preserved over enrichment',
  );
});

// ---------------------------------------------------------------------------
// Tests — fields without operator overrides are still filled by enrichment
// ---------------------------------------------------------------------------

test('applyBrandKitEnrichment: fields operator did NOT supply are filled by enrichment', () => {
  const base = makeBaseBrandKit({ positioning: null, audience: null });
  const enrichment = makeEnrichment({
    positioning: 'LLM positioning',
    audience: 'LLM audience',
    styleVibe: 'LLM style vibe',
  });
  // Operator only provided styleVibe — audience and positioning should come from enrichment
  const operatorOverrides = { styleVibe: 'Dark minimal builder aesthetic' };

  const result = applyBrandKitEnrichment(base, enrichment, operatorOverrides);

  assert.strictEqual(result.positioning, 'LLM positioning', 'Positioning not supplied by operator — enrichment should fill it');
  assert.strictEqual(result.audience, 'LLM audience', 'Audience not supplied by operator — enrichment should fill it');
  assert.strictEqual(result.style_vibe, 'Dark minimal builder aesthetic', 'Operator styleVibe must win');
});

test('applyBrandKitEnrichment: offer_summary filled by enrichment when operator has no override for it', () => {
  const base = makeBaseBrandKit({ offer_summary: null });
  const enrichment = makeEnrichment({ offerSummary: 'LLM-generated offer summary' });
  const operatorOverrides = { styleVibe: 'Dark minimal' };

  const result = applyBrandKitEnrichment(base, enrichment, operatorOverrides);

  assert.strictEqual(
    result.offer_summary,
    'LLM-generated offer summary',
    'offer_summary not covered by operator — enrichment should fill it',
  );
});

// ---------------------------------------------------------------------------
// Tests — no operator overrides: legacy behavior unchanged
// ---------------------------------------------------------------------------

test('applyBrandKitEnrichment: without operatorOverrides, enrichment overwrites style_vibe as before', () => {
  const base = makeBaseBrandKit({ style_vibe: null });
  const enrichment = makeEnrichment({ styleVibe: 'bright, clean, modern' });

  // No operator overrides — behave exactly as before this fix
  const result = applyBrandKitEnrichment(base, enrichment);

  assert.strictEqual(
    result.style_vibe,
    'bright, clean, modern',
    'Without operator overrides, enrichment should fill style_vibe as normal',
  );
});

test('applyBrandKitEnrichment: without operatorOverrides, enrichment fills tone_of_voice as before', () => {
  const base = makeBaseBrandKit({ tone_of_voice: null });
  const enrichment = makeEnrichment({ toneOfVoice: 'casual, friendly' });

  const result = applyBrandKitEnrichment(base, enrichment);

  assert.strictEqual(
    result.tone_of_voice,
    'casual, friendly',
    'Without operator overrides, enrichment should fill tone_of_voice as normal',
  );
});

// ---------------------------------------------------------------------------
// Tests — empty/whitespace operator override treated as absent
// ---------------------------------------------------------------------------

test('applyBrandKitEnrichment: empty string styleVibe override is treated as absent', () => {
  const base = makeBaseBrandKit({ style_vibe: null });
  const enrichment = makeEnrichment({ styleVibe: 'bright, clean, modern' });
  const operatorOverrides = { styleVibe: '   ' }; // whitespace-only

  const result = applyBrandKitEnrichment(base, enrichment, operatorOverrides);

  // Whitespace-only override should not be treated as authoritative
  assert.strictEqual(
    result.style_vibe,
    'bright, clean, modern',
    'Whitespace-only styleVibe override must not block enrichment from filling the gap',
  );
});
