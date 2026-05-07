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
  const previousDbHost = process.env.DB_HOST;
  const previousDbUser = process.env.DB_USER;
  const previousDbPassword = process.env.DB_PASSWORD;
  const previousDbName = process.env.DB_NAME;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-onboarding-draft-'));

  process.env.CODE_ROOT = PROJECT_ROOT;
  process.env.DATA_ROOT = dataRoot;
  delete process.env.DB_HOST;
  delete process.env.DB_USER;
  delete process.env.DB_PASSWORD;
  delete process.env.DB_NAME;

  try {
    return await run();
  } finally {
    if (previousCodeRoot === undefined) delete process.env.CODE_ROOT;
    else process.env.CODE_ROOT = previousCodeRoot;
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    if (previousDbHost === undefined) delete process.env.DB_HOST;
    else process.env.DB_HOST = previousDbHost;
    if (previousDbUser === undefined) delete process.env.DB_USER;
    else process.env.DB_USER = previousDbUser;
    if (previousDbPassword === undefined) delete process.env.DB_PASSWORD;
    else process.env.DB_PASSWORD = previousDbPassword;
    if (previousDbName === undefined) delete process.env.DB_NAME;
    else process.env.DB_NAME = previousDbName;
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

test('fallback onboarding draft store supports the full pre-auth to materialized lifecycle', async () => {
  await withDraftEnv(async () => {
    const store = await import('../backend/onboarding/draft-store');

    const created = await store.createOnboardingDraft();
    assert.equal(created.status, 'draft');

    const ready = await store.updateOnboardingDraft(created.draftId, {
      businessName: 'QA Synthetic Brand',
      websiteUrl: 'https://synthetic-brand.example',
      businessType: 'QA test business',
      approverName: 'QA Tester',
      channels: ['instagram', 'linkedin'],
      goal: 'Verify onboarding end to end',
      offer: 'Synthetic QA offer',
      competitorUrl: 'https://synthetic-competitor.example',
      preview: {
        title: 'QA Synthetic Brand',
        favicon: '',
        domain: 'synthetic-brand.example',
        description: 'Synthetic preview used by onboarding QA',
        canonicalUrl: 'https://synthetic-brand.example/',
        brandKitPreview: null,
      },
      provenance: {
        source_url: 'https://synthetic-brand.example/',
        canonical_url: 'https://synthetic-brand.example/',
        source_fingerprint: 'https://synthetic-brand.example/',
      },
      status: 'ready_for_auth',
    });
    assert.equal(ready.status, 'ready_for_auth');

    const firstClaim = await store.claimOnboardingDraftMaterialization(created.draftId);
    assert.equal(firstClaim.claimed, true);
    assert.equal(firstClaim.draft.status, 'materializing');

    const duplicateClaim = await store.claimOnboardingDraftMaterialization(created.draftId);
    assert.equal(duplicateClaim.claimed, false);
    assert.equal(duplicateClaim.draft.status, 'materializing');

    const materialized = await store.updateOnboardingDraft(created.draftId, {
      status: 'materialized',
      materializedTenantId: 'tenant_qa_synthetic',
      materializedJobId: 'mkt_qa_synthetic',
    });
    assert.equal(materialized.status, 'materialized');
    assert.equal(materialized.materializedTenantId, 'tenant_qa_synthetic');
    assert.equal(materialized.materializedJobId, 'mkt_qa_synthetic');

    const reloaded = await store.getOnboardingDraft(created.draftId);
    assert.equal(reloaded?.status, 'materialized');
    assert.equal(reloaded?.businessName, 'QA Synthetic Brand');
    assert.equal(reloaded?.materializedJobId, 'mkt_qa_synthetic');
  });
});
