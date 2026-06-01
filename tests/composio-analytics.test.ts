import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ComposioAnalyticsProvider } from '@/backend/integrations/composio/composio-analytics-provider';
import { normalizeMetrics } from '@/backend/integrations/composio/metrics-normalizer';
import { DirectMetaProvider } from '@/backend/integrations/direct/direct-meta-provider';
import { fakeConfig, fakeGateway, fakeDb } from './composio/helpers';

const tenantId = '42';

test('normalizeMetrics maps present fields and leaves missing ones null (never 0)', () => {
  const m = normalizeMetrics({
    platform: 'instagram',
    externalPostId: 'p1',
    raw: { impressions: 1200, likes: 34, comments: 5 },
  });
  assert.equal(m.impressions, 1200);
  assert.equal(m.likes, 34);
  assert.equal(m.comments, 5);
  // Not present in the payload => null, not fabricated zero.
  assert.equal(m.reach, null);
  assert.equal(m.spend, null);
  assert.equal(m.roas, null);
  assert.equal(m.saves, null);
  // Raw payload retained for debugging.
  assert.deepEqual(m.rawMetrics, { impressions: 1200, likes: 34, comments: 5 });
});

test('post insights with no configured slug => all null + explicit unavailableReason', async () => {
  const provider = new ComposioAnalyticsProvider(fakeGateway(), fakeConfig({ actions: {} }), fakeDb());
  const m = await provider.getPostInsights({ tenantId, platform: 'tiktok', externalPostId: 'v1' });
  assert.equal(m.impressions, null);
  assert.equal(m.views, null);
  assert.ok(m.unavailableReason && m.unavailableReason.includes('post_insights'));
});

test('post insights executes when slug configured and connection active', async () => {
  const gateway = fakeGateway({ executeResult: { data: { impressions: 10, reach: 8 }, successful: true, error: null } });
  const provider = new ComposioAnalyticsProvider(gateway, fakeConfig({ actions: { post_insights: 'IG_INSIGHTS' } }), fakeDb());
  const m = await provider.getPostInsights({ tenantId, platform: 'facebook', externalPostId: 'p1' });
  assert.equal(m.impressions, 10);
  assert.equal(m.reach, 8);
  assert.equal(m.clicks, null);
});

test('direct Meta analytics is explicitly unavailable (no insights scopes), never fabricated', async () => {
  const provider = new DirectMetaProvider();
  const m = await provider.getPostInsights({ tenantId, platform: 'facebook', externalPostId: 'p1' });
  assert.equal(m.impressions, null);
  assert.ok(m.unavailableReason && m.unavailableReason.toLowerCase().includes('insights'));
});
