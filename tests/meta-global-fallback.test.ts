import { test } from 'node:test';
import assert from 'node:assert/strict';
import pool from '@/lib/db';
import { getPublisherProviderForPlatform } from '@/backend/integrations/providers/provider-factory';
import { DirectMetaProvider } from '@/backend/integrations/direct/direct-meta-provider';
import { oauthStatus, oauthStatusAsync } from '@/backend/integrations/status';

test('global Meta credentials never connect or publish for a tenant with Composio disabled', async (t) => {
  const keys = ['COMPOSIO_ENABLED', 'META_PAGE_ID', 'META_ACCESS_TOKEN'];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.COMPOSIO_ENABLED = 'false';
  process.env.META_PAGE_ID = '1002997576221948';
  process.env.META_ACCESS_TOKEN = 'synthetic-test-token';
  t.mock.method(pool, 'query', async () => ({ rows: [] }));
  let graphCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    graphCalls++;
    throw new Error('Graph must not be called');
  });
  try {
    for (const tenantId of ['15', '75', '999']) {
      for (const selector of ['direct_meta', 'auto', 'composio']) {
        for (const platform of ['facebook', 'instagram'] as const) {
          assert.throws(() => getPublisherProviderForPlatform(platform, {
            NODE_ENV: 'test', COMPOSIO_ENABLED: 'false', PUBLISH_PROVIDER: selector,
          }), /direct_meta_unscoped/);
        }
      }
      const syncStatus = oauthStatus('instagram', tenantId);
      const asyncStatus = await oauthStatusAsync('instagram', tenantId);
      for (const status of [syncStatus, asyncStatus]) {
        assert.ok(!('broker_status' in status));
        assert.equal(status.connection_status, 'misconfigured');
        assert.equal(status.external_account_id, undefined);
      }
      const caps = await new DirectMetaProvider().checkCapabilities(`aries-tenant-${tenantId}`, 'facebook');
      assert.equal(caps.canPublishOrganic, false);
      // Even callers bypassing the factory must resolve this tenant's own OAuth row.
      await assert.rejects(new DirectMetaProvider().publishPost({
        tenantId, platform: 'facebook', content: 'test', mediaUrls: [], approved: true,
      }), /token/i);
    }
    assert.equal(graphCalls, 0);
    for (const selector of ['direct_meta', 'auto']) {
      assert.throws(() => getPublisherProviderForPlatform('facebook', {
        NODE_ENV: 'test', COMPOSIO_ENABLED: 'true', PUBLISH_PROVIDER: selector,
      }), /direct_meta_unscoped/);
    }
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
