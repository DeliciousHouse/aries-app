import assert from 'node:assert/strict';
import test from 'node:test';

import { applyBrandKitEnrichment } from '../backend/marketing/brand-kit-enrich';
import type { TenantBrandKit } from '../backend/marketing/brand-kit';
import type { BrandKitEnrichment } from '../backend/marketing/brand-kit-enrich';

function baseKit(overrides?: Partial<TenantBrandKit>): TenantBrandKit {
  return {
    tenant_id: 'tenant1',
    source_url: 'https://example.com',
    canonical_url: 'https://example.com',
    brand_name: 'Example',
    logo_urls: [],
    colors: { primary: null, secondary: null, accent: null, palette: [] },
    font_families: [],
    external_links: [],
    extracted_at: '2025-01-01T00:00:00.000Z',
    brand_voice_summary: 'Original voice',
    offer_summary: 'Original offer',
    positioning: null,
    audience: null,
    tone_of_voice: null,
    style_vibe: null,
    ...overrides,
  };
}

function allNullEnrichment(): BrandKitEnrichment {
  return {
    brandVoiceSummary: null,
    offerSummary: null,
    positioning: null,
    audience: null,
    toneOfVoice: null,
    styleVibe: null,
  };
}

test('applyBrandKitEnrichment with all-null enrichment returns base unchanged on 4 enrichment-only fields', () => {
  const base = baseKit({ positioning: null, audience: null, tone_of_voice: null, style_vibe: null });
  const result = applyBrandKitEnrichment(base, allNullEnrichment());
  assert.equal(result.positioning, null);
  assert.equal(result.audience, null);
  assert.equal(result.tone_of_voice, null);
  assert.equal(result.style_vibe, null);
  assert.equal(result.brand_voice_summary, base.brand_voice_summary);
  assert.equal(result.offer_summary, base.offer_summary);
});

test('applyBrandKitEnrichment with partial enrichment wins per-field', () => {
  const base = baseKit({ positioning: 'old pos', audience: 'old audience', tone_of_voice: null, style_vibe: null });
  const enrichment: BrandKitEnrichment = {
    brandVoiceSummary: null,
    offerSummary: null,
    positioning: 'new pos',
    audience: null,
    toneOfVoice: 'warm, direct',
    styleVibe: null,
  };
  const result = applyBrandKitEnrichment(base, enrichment);
  assert.equal(result.positioning, 'new pos');
  assert.equal(result.audience, 'old audience');
  assert.equal(result.tone_of_voice, 'warm, direct');
  assert.equal(result.style_vibe, null);
});

test('applyBrandKitEnrichment with full enrichment overwrites brand_voice_summary and offer_summary', () => {
  const base = baseKit();
  const enrichment: BrandKitEnrichment = {
    brandVoiceSummary: 'New voice',
    offerSummary: 'New offer',
    positioning: 'New pos',
    audience: 'New audience',
    toneOfVoice: 'bold',
    styleVibe: 'minimalist',
  };
  const result = applyBrandKitEnrichment(base, enrichment);
  assert.equal(result.brand_voice_summary, 'New voice');
  assert.equal(result.offer_summary, 'New offer');
  assert.equal(result.positioning, 'New pos');
  assert.equal(result.audience, 'New audience');
  assert.equal(result.tone_of_voice, 'bold');
  assert.equal(result.style_vibe, 'minimalist');
});

test('applyBrandKitEnrichment sanitizes leading dangling article-comma enrichment fragments', () => {
  const base = baseKit({ brand_voice_summary: null, offer_summary: null, positioning: null });
  const enrichment: BrandKitEnrichment = {
    brandVoiceSummary: 'A, approval-safe social content operating system for teams that need reviews before publishing.',
    offerSummary: 'An, automated content review workflow for small teams.',
    positioning: 'The, safest way for teams to approve and publish weekly social posts.',
    audience: null,
    toneOfVoice: null,
    styleVibe: null,
  };

  const result = applyBrandKitEnrichment(base, enrichment);

  assert.equal(
    result.brand_voice_summary,
    'Approval-safe social content operating system for teams that need reviews before publishing.',
  );
  assert.equal(result.offer_summary, 'Automated content review workflow for small teams.');
  assert.equal(result.positioning, 'Safest way for teams to approve and publish weekly social posts.');
});

test('applyBrandKitEnrichment returns a new object — mutating result does not mutate base', () => {
  const base = baseKit();
  const enrichment: BrandKitEnrichment = {
    brandVoiceSummary: 'New voice',
    offerSummary: null,
    positioning: 'New pos',
    audience: null,
    toneOfVoice: null,
    styleVibe: null,
  };
  const result = applyBrandKitEnrichment(base, enrichment);
  assert.notEqual(result, base);
  (result as { brand_name: string }).brand_name = 'MUTATED';
  assert.equal(base.brand_name, 'Example');
});
