import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

async function withDraftEnv<T>(run: () => Promise<T>): Promise<T> {
  const previousCodeRoot = process.env.CODE_ROOT;
  const previousDataRoot = process.env.DATA_ROOT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-onboarding-draft-'));

  process.env.CODE_ROOT = PROJECT_ROOT;
  process.env.DATA_ROOT = dataRoot;

  try {
    return await run();
  } finally {
    if (previousCodeRoot === undefined) delete process.env.CODE_ROOT;
    else process.env.CODE_ROOT = previousCodeRoot;
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

test('onboarding draft store persists customer intake fields and materialization metadata', async () => {
  await withDraftEnv(async () => {
    const store = await import('../backend/onboarding/draft-store');

    const created = await store.createOnboardingDraft({
      websiteUrl: 'https://theframex.com',
      businessName: 'The FrameX',
    });
    const updated = await store.updateOnboardingDraft(created.draftId, {
      businessType: 'Custom framing studio',
      approverName: 'Avery Frame',
      channels: ['meta-ads', 'instagram'],
      goal: 'Book more design consultations',
      offer: 'Museum-grade framing',
      competitorUrl: 'https://competitor.example',
      status: 'ready_for_auth',
      materializedTenantId: '42',
      materializedJobId: 'mkt_123',
    });
    const reloaded = await store.getOnboardingDraft(created.draftId);

    assert.equal(updated.status, 'ready_for_auth');
    assert.equal(updated.businessType, 'Custom framing studio');
    assert.equal(updated.approverName, 'Avery Frame');
    assert.deepEqual(updated.channels, ['meta-ads', 'instagram']);
    assert.equal(updated.goal, 'Book more design consultations');
    assert.equal(updated.offer, 'Museum-grade framing');
    assert.equal(updated.competitorUrl, 'https://competitor.example/');
    assert.equal(updated.materializedTenantId, '42');
    assert.equal(updated.materializedJobId, 'mkt_123');
    assert.equal(reloaded?.businessName, 'The FrameX');
    assert.equal(store.draftTenantId(created.draftId).startsWith('draft_'), true);
  });
});

test('changing the draft source clears stale derived preview state', async () => {
  await withDraftEnv(async () => {
    const store = await import('../backend/onboarding/draft-store');

    const created = await store.createOnboardingDraft({
      websiteUrl: 'https://theframex.com',
      preview: {
        title: 'The FrameX',
        favicon: '',
        domain: 'theframex.com',
        description: 'Custom framing studio',
        canonicalUrl: 'https://theframex.com/',
        brandKitPreview: null,
      },
      provenance: {
        source_url: 'https://theframex.com/',
        canonical_url: 'https://theframex.com/',
        source_fingerprint: 'https://theframex.com/',
      },
    });

    const updated = await store.updateOnboardingDraft(created.draftId, {
      websiteUrl: 'https://newsite.example',
    });

    assert.equal(updated.websiteUrl, 'https://newsite.example/');
    assert.equal(updated.preview, null);
    assert.equal(updated.provenance.source_url, 'https://newsite.example/');
    assert.equal(updated.provenance.canonical_url, null);
    assert.equal(updated.provenance.source_fingerprint, 'https://newsite.example/');
  });
});
