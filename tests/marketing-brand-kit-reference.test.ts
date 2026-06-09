import assert from 'node:assert/strict';
import test from 'node:test';

import { marketingBrandKitReferenceFromTenantBrandKit } from '../backend/marketing/runtime-state';
import type { TenantBrandKit } from '../backend/marketing/brand-kit';

test('marketingBrandKitReferenceFromTenantBrandKit copies all 16 fields including logo_file_path + 4 enrichment fields with deep-copy semantics', () => {
  const kit: TenantBrandKit = {
    tenant_id: 'tenant1',
    source_url: 'https://example.com',
    canonical_url: 'https://www.example.com',
    brand_name: 'Example Brand',
    logo_urls: ['https://example.com/logo.png'],
    logo_file_path: '/data/generated/validated/tenant1/logo.png',
    colors: { primary: '#111111', secondary: '#222222', accent: '#333333', palette: ['#111111', '#222222'], background: '#050505', mode: 'dark' },
    font_families: ['Georgia', 'Helvetica'],
    external_links: [{ platform: 'instagram', url: 'https://instagram.com/example' }],
    extracted_at: '2025-01-01T00:00:00.000Z',
    brand_voice_summary: 'Warm and direct.',
    offer_summary: 'Leadership coaching programs.',
    positioning: 'For founders who want to lead with clarity.',
    audience: 'Early-stage founders.',
    tone_of_voice: 'warm, direct, bold',
    style_vibe: 'minimalist, modern',
  };

  const filePath = '/data/generated/validated/tenant1/brand-kit.json';
  const ref = marketingBrandKitReferenceFromTenantBrandKit(kit, filePath);

  assert.equal(ref.path, filePath);
  assert.equal(ref.source_url, kit.source_url);
  assert.equal(ref.canonical_url, kit.canonical_url);
  assert.equal(ref.brand_name, kit.brand_name);
  assert.deepEqual(ref.logo_urls, kit.logo_urls);
  assert.equal(ref.logo_file_path, kit.logo_file_path);
  assert.equal(ref.colors.primary, kit.colors.primary);
  assert.equal(ref.colors.secondary, kit.colors.secondary);
  assert.equal(ref.colors.accent, kit.colors.accent);
  assert.deepEqual(ref.colors.palette, kit.colors.palette);
  // Theme signal (dark/light + page background) must survive the copy layer —
  // dropping it loses the "render on a dark background" instruction in the brief.
  assert.equal(ref.colors.background, kit.colors.background);
  assert.equal(ref.colors.mode, kit.colors.mode);
  assert.deepEqual(ref.font_families, kit.font_families);
  assert.deepEqual(ref.external_links, kit.external_links);
  assert.equal(ref.extracted_at, kit.extracted_at);
  assert.equal(ref.brand_voice_summary, kit.brand_voice_summary);
  assert.equal(ref.offer_summary, kit.offer_summary);
  assert.equal(ref.positioning, kit.positioning);
  assert.equal(ref.audience, kit.audience);
  assert.equal(ref.tone_of_voice, kit.tone_of_voice);
  assert.equal(ref.style_vibe, kit.style_vibe);

  // Deep-copy semantics: mutating arrays/objects on ref does not affect original
  ref.logo_urls.push('mutated');
  assert.equal(kit.logo_urls.length, 1, 'logo_urls should be deep-copied');

  ref.colors.palette.push('#999999');
  assert.equal(kit.colors.palette.length, 2, 'palette should be deep-copied');

  ref.external_links.push({ platform: 'x', url: 'https://x.com/example' });
  assert.equal(kit.external_links.length, 1, 'external_links should be deep-copied');
});
