import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DirectMetaProvider } from '@/backend/integrations/direct/direct-meta-provider';
import { PublishGuardError } from '@/backend/integrations/providers/errors';

const tenantId = '42';

test('direct Meta dry-run previews with no side effect', async () => {
  const provider = new DirectMetaProvider();
  const result = await provider.publishPost({ tenantId, platform: 'facebook', content: 'hi', mediaUrls: ['u'], dryRun: true });
  assert.equal(result.status, 'preview');
  assert.equal(result.provider, 'direct_meta');
  assert.equal(result.externalPostId, null);
});

test('direct Meta refuses a live post without approval', async () => {
  const provider = new DirectMetaProvider();
  await assert.rejects(
    () => provider.publishPost({ tenantId, platform: 'facebook', content: 'hi', mediaUrls: ['u'], approved: false }),
    PublishGuardError,
  );
});

test('direct Meta does not create live ads (returns a no-op draft)', async () => {
  const provider = new DirectMetaProvider();
  const result = await provider.publishAd({ tenantId, platform: 'meta_ads', name: 'X' });
  assert.equal(result.status, 'draft');
  assert.equal(result.externalAdId, null);
});

test('direct Meta supports only organic facebook/instagram', () => {
  const provider = new DirectMetaProvider();
  assert.equal(provider.supports('facebook'), true);
  assert.equal(provider.supports('instagram'), true);
  assert.equal(provider.supports('tiktok'), false);
  assert.equal(provider.supports('meta_ads'), false);
});

test('direct Meta capabilities reflect env config and never claim insights', async () => {
  const prevToken = process.env.META_ACCESS_TOKEN;
  const prevPage = process.env.META_PAGE_ID;
  process.env.META_ACCESS_TOKEN = 'tok';
  process.env.META_PAGE_ID = 'page';
  try {
    const caps = await new DirectMetaProvider().checkCapabilities('aries-tenant-42', 'facebook');
    assert.equal(caps.canPublishOrganic, true);
    assert.equal(caps.canReadPostInsights, false);
    assert.equal(caps.canPublishAds, false);
    assert.ok(caps.missingPermissions.includes('read_insights'));
  } finally {
    if (prevToken === undefined) delete process.env.META_ACCESS_TOKEN; else process.env.META_ACCESS_TOKEN = prevToken;
    if (prevPage === undefined) delete process.env.META_PAGE_ID; else process.env.META_PAGE_ID = prevPage;
  }
});
