import assert from 'node:assert/strict';
import test from 'node:test';

import type { BusinessProfileView } from '@/backend/tenant/business-profile';
import { buildOnboardingCandidatesFromProfile } from '@/backend/memory/build-onboarding-candidates';

function baseProfile(over: Partial<BusinessProfileView> = {}): BusinessProfileView {
  return {
    tenantId: '1',
    businessName: 'Acme Co',
    tenantSlug: 'acme',
    websiteUrl: 'https://acme.example',
    businessType: null,
    primaryGoal: null,
    launchApproverUserId: null,
    launchApproverName: null,
    offer: null,
    brandVoice: null,
    styleVibe: null,
    notes: null,
    competitorUrl: null,
    channels: [],
    brandIdentity: null,
    brandKit: null,
    incomplete: false,
    ...over,
  };
}

test('buildOnboardingCandidatesFromProfile includes website and business name', () => {
  const candidates = buildOnboardingCandidatesFromProfile(baseProfile());
  assert.ok(candidates.length >= 2);
  assert.ok(candidates.some(c => c.claim.includes('Official website')));
  assert.ok(candidates.some(c => c.claim.includes('business name')));
  assert.ok(candidates.every(c => c.sources.length > 0));
  assert.ok(candidates.every(c => c.sources[0].url.startsWith('https://')));
});

test('buildOnboardingCandidatesFromProfile maps brand kit external links', () => {
  const candidates = buildOnboardingCandidatesFromProfile(
    baseProfile({
      brandKit: {
        tenant_id: '1',
        source_url: 'https://acme.example',
        canonical_url: 'https://acme.example',
        brand_name: 'Acme',
        logo_urls: [],
        colors: { primary: null, secondary: null, accent: null, palette: [] },
        font_families: [],
        external_links: [{ platform: 'instagram', url: 'https://instagram.com/acme' }],
        extracted_at: new Date().toISOString(),
        brand_voice_summary: null,
        offer_summary: null,
      },
    }),
  );
  assert.ok(candidates.some(c => c.claim.includes('instagram')));
});
