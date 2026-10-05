import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { updateBusinessProfileWithDiagnostics, marketingPayloadDefaultsFromBusinessProfile } from '../backend/tenant/business-profile';
import { triggerWeeklyJobForTenant } from '../backend/marketing/weekly-trigger';
import { buildBrandKitPayload } from '../backend/social-content/brand-kit-payload';
import { createSocialContentJobRuntimeDocument } from '../backend/marketing/runtime-state';
import { loadTenantTimezoneOrFallback } from '../backend/tenant/business-profile';
import { businessProfileMemoryContent, updateBusinessProfileMemory } from '../backend/memory/business-profile-memory';

test('profile edits and clears reach new weekly jobs and Hermes without stale kit or snapshot values', async () => {
  const previous = process.env.DATA_ROOT;
  const previousHoncho = process.env.HONCHO_ENABLED;
  process.env.HONCHO_ENABLED = 'false';
  const dataRoot = mkdtempSync(path.join(os.tmpdir(), 'aries-profile-edits-'));
  process.env.DATA_ROOT = dataRoot;
  const dir = path.join(dataRoot, 'generated', 'validated', '75');
  mkdirSync(dir, { recursive: true });
  const kit = {
    tenant_id: '75', source_url: 'https://wine.example/', canonical_url: 'https://wine.example/',
    brand_name: 'Old Name', brand_voice_summary: 'Old voice', tone_of_voice: 'Old tone',
    offer_summary: 'Old offer', style_vibe: 'Old vibe', logo_urls: [],
    colors: { primary: null, secondary: null, accent: null, palette: [] },
    font_families: [], external_links: [], extracted_at: new Date().toISOString(),
  };
  writeFileSync(path.join(dir, 'brand-kit.json'), JSON.stringify(kit));
  writeFileSync(path.join(dir, 'brand-profile.json'), JSON.stringify({
    business_name: 'Old Name', website_url: 'https://wine.example/', business_type: 'Old type',
    primary_goal: 'Old goal', offer: 'Old offer', competitor_url: 'https://old.example/',
    brand_voice: ['Old voice'], channels: ['instagram'],
  }));
  const writes: unknown[][] = [];
  const client = { async query(sql: string, params: unknown[]) {
    if (sql.includes('INSERT INTO business_profiles')) writes.push(params);
    return { rowCount: 1, rows: [{ id: 75, name: 'Wine', slug: 'wine' }] };
  } };
  try {
    // An untouched enrichment must not become an operator value on partial save.
    await updateBusinessProfileWithDiagnostics(client as never, { tenantId: '75', businessName: 'Wine' });
    let stored = JSON.parse(readFileSync(path.join(dir, 'business-profile.json'), 'utf8'));
    assert.equal(stored.brand_voice, null);
    assert.equal(stored.offer, null);
    assert.equal(stored.style_vibe, null);
    const edited = await updateBusinessProfileWithDiagnostics(client as never, {
      tenantId: '75', businessName: 'New Wine', websiteUrl: 'https://wine.example/',
      businessType: 'Wine shop', primaryGoal: 'Grow our audience', offer: 'New tasting offer',
      brandVoice: 'Friendly wine expertise without jargon', styleVibe: 'Clean vineyard photography',
      notes: 'Never imply alcohol improves health', competitorUrl: 'https://competitor.example/',
      channels: ['linkedin'], timezone: 'America/Los_Angeles', reelAudioMode: 'voiceover',
    });
    assert.equal(edited.profile.businessName, 'New Wine');
    assert.equal(edited.profile.offer, 'New tasting offer');
    assert.equal(edited.profile.businessType, 'Wine shop');
    assert.deepEqual(edited.profile.channels, ['linkedin']);
    assert.equal(loadTenantTimezoneOrFallback('75'), 'America/Los_Angeles');
    const updatedKit = JSON.parse(readFileSync(path.join(dir, 'brand-kit.json'), 'utf8'));
    assert.equal(updatedKit.brand_voice_summary, edited.profile.brandVoice);
    assert.equal(updatedKit.style_vibe, edited.profile.styleVibe);
    assert.equal(updatedKit.offer_summary, edited.profile.offer);
    const observations: Array<{ content: string }> = [];
    process.env.HONCHO_ENABLED = 'true';
    await updateBusinessProfileMemory(edited.profile, {
      ensureWorkspace: async () => undefined,
      appendObservation: async (input: { content: string }) => { observations.push(input); },
    } as never);
    process.env.HONCHO_ENABLED = 'false';
    assert.match(observations[0].content, /Brand voice: Friendly wine expertise without jargon/);
    assert.match(observations[0].content, /Notes: Never imply alcohol improves health/);
    const defaults = await marketingPayloadDefaultsFromBusinessProfile('75');
    let payload: Record<string, unknown> = {};
    const result = await triggerWeeklyJobForTenant('75', {
      loadPayloadDefaults: async () => defaults, findRecentJobId: async () => null,
      startJob: async (input) => {
        payload = input.payload;
        return { status: 'ok', jobId: 'test-profile-job' } as never;
      },
    });
    assert.equal(result.status, 'started');
    assert.equal(payload.notes, 'Never imply alcohol improves health');
    const doc = createSocialContentJobRuntimeDocument({ jobId: 'test-profile-job', tenantId: '75', payload, brandKit: { ...kit, path: '' } as never });
    const brand = buildBrandKitPayload(doc, { ...kit, path: '' } as never, payload).brand;
    assert.equal(brand.voice, 'Friendly wine expertise without jargon');
    assert.equal(brand.style_vibe, 'Clean vineyard photography');
    assert.equal(brand.offer, 'New tasting offer');
    assert.equal(brand.notes, payload.notes);
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[1].slice(11, 19), [
      'Friendly wine expertise without jargon', 'Clean vineyard photography',
      'Never imply alcohol improves health', 'https://competitor.example/',
      ['linkedin'], 'America/Los_Angeles', 'voiceover', true,
    ]);
    await updateBusinessProfileWithDiagnostics(client as never, {
      tenantId: '75', brandVoice: '', styleVibe: null, notes: '', offer: '',
      competitorUrl: '', channels: [], launchApproverUserId: null,
    });
    const cleared = await marketingPayloadDefaultsFromBusinessProfile('75');
    assert.equal(cleared.brandVoice, '');
    assert.equal(cleared.notes, '');
    assert.equal(cleared.offer, '');
    assert.deepEqual(cleared.channels, []);
    const clearBrand = buildBrandKitPayload(doc, { ...kit, path: '' } as never, cleared).brand;
    assert.equal(clearBrand.voice, '');
    assert.equal(clearBrand.style_vibe, '');
    assert.equal(clearBrand.offer, '');
    assert.equal(clearBrand.notes, '');
    stored = JSON.parse(readFileSync(path.join(dir, 'business-profile.json'), 'utf8'));
    assert.equal(stored.timezone, 'America/Los_Angeles');
    const clearedProfile = await updateBusinessProfileWithDiagnostics(client as never, {
      tenantId: '75', websiteUrl: '', businessType: '', primaryGoal: '', timezone: null,
    });
    assert.equal(clearedProfile.profile.websiteUrl, null);
    assert.equal(clearedProfile.profile.businessType, null);
    assert.equal(clearedProfile.profile.incomplete, true);
    assert.equal(loadTenantTimezoneOrFallback('75'), 'America/New_York');
    assert.match(businessProfileMemoryContent(clearedProfile.profile), /Brand voice: \(unset\)/);
  } finally {
    if (previousHoncho === undefined) delete process.env.HONCHO_ENABLED;
    else process.env.HONCHO_ENABLED = previousHoncho;
    if (previous === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previous;
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
