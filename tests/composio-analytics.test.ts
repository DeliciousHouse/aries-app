import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ComposioAnalyticsProvider } from '@/backend/integrations/composio/composio-analytics-provider';
import { DirectMetaProvider } from '@/backend/integrations/direct/direct-meta-provider';
import { fakeConfig, fakeGateway, fakeDb } from './composio/helpers';

const tenantId = '42';

function connRow(platform: string) {
  return {
    id: 1, tenant_id: 42, external_user_id: 'u', platform, provider: 'composio',
    connected_account_id: 'ca_1', auth_config_id: 'ac', external_account_id: 'acct_1',
    external_account_name: 'Acct', status: 'connected', capabilities_json: null,
    last_capability_check_at: null, created_at: new Date(0), updated_at: new Date(0),
  };
}

test('post insights for a platform with no mapper => all null + explicit unavailableReason', async () => {
  const provider = new ComposioAnalyticsProvider(fakeGateway(), fakeConfig({ actions: {} }), fakeDb());
  const m = await provider.getPostInsights({ tenantId, platform: 'tiktok', externalPostId: 'v1' });
  assert.equal(m.impressions, null);
  assert.equal(m.views, null);
  assert.ok(m.unavailableReason && m.unavailableReason.includes('post_insights'));
});

test('FB post insights parses the Graph post_media_view metric via the default mapper', async () => {
  const gateway = fakeGateway({
    executeResult: { data: { data: [{ name: 'post_media_view', values: [{ value: 321 }] }] }, successful: true, error: null },
  });
  const provider = new ComposioAnalyticsProvider(gateway, fakeConfig({ actions: {} }), fakeDb({ connectionRow: connRow('facebook') }));
  const m = await provider.getPostInsights({ tenantId, platform: 'facebook', externalPostId: 'p1' });
  assert.equal(m.views, 321);
  assert.equal(m.impressions, 321);
  assert.equal(m.clicks, null);
  assert.equal(gateway.calls[0].slug, 'FACEBOOK_GET_POST_INSIGHTS');
});

test('no active connection => unavailable, not fabricated', async () => {
  const provider = new ComposioAnalyticsProvider(fakeGateway(), fakeConfig({ actions: {} }), fakeDb({ connectionRow: null }));
  const m = await provider.getPostInsights({ tenantId, platform: 'instagram', externalPostId: 'p1' });
  assert.equal(m.reach, null);
  assert.ok(m.unavailableReason && m.unavailableReason.includes('No active'));
});

test('unsuccessful tool call => unavailable with the tool error, never fabricated', async () => {
  const gateway = fakeGateway({ executeResult: { data: null, successful: false, error: 'rate limited' } });
  const provider = new ComposioAnalyticsProvider(gateway, fakeConfig({ actions: {} }), fakeDb({ connectionRow: connRow('instagram') }));
  const m = await provider.getPostInsights({ tenantId, platform: 'instagram', externalPostId: 'p1' });
  assert.equal(m.likes, null);
  assert.equal(m.unavailableReason, 'rate limited');
});

test('direct Meta analytics is explicitly unavailable (no insights scopes), never fabricated', async () => {
  const provider = new DirectMetaProvider();
  const m = await provider.getPostInsights({ tenantId, platform: 'facebook', externalPostId: 'p1' });
  assert.equal(m.impressions, null);
  assert.ok(m.unavailableReason && m.unavailableReason.toLowerCase().includes('insights'));
});
