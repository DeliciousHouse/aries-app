import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getAnalyticsMapper } from '@/backend/integrations/composio/analytics-mappers';
import { ComposioAnalyticsProvider } from '@/backend/integrations/composio/composio-analytics-provider';
import { fakeConfig, fakeGateway, fakeDb } from './composio/helpers';

const tenantId = '42';

// --- arg builders (real per-tool argument shapes) --------------------------

test('IG post mapper builds ig_media_id + metric[] (not generic post_id)', () => {
  const m = getAnalyticsMapper('instagram', 'post_insights');
  assert.ok(m);
  assert.equal(m!.slug, 'INSTAGRAM_GET_IG_MEDIA_INSIGHTS');
  const args = m!.buildArgs({ externalAccountId: 'igacct', externalPostId: 'media_1' });
  assert.equal(args.ig_media_id, 'media_1');
  assert.ok(Array.isArray(args.metric) && (args.metric as string[]).includes('reach'));
  assert.equal('post_id' in args, false);
});

test('FB account mapper requires page_id from the connected account', () => {
  const m = getAnalyticsMapper('facebook', 'account_insights')!;
  const args = m.buildArgs({ externalAccountId: 'page_99' });
  assert.equal(args.page_id, 'page_99');
});

test('YouTube post mapper sends id as an array', () => {
  const m = getAnalyticsMapper('youtube', 'post_insights')!;
  const args = m.buildArgs({ externalAccountId: null, externalPostId: 'vid1' });
  assert.deepEqual(args.id, ['vid1']);
});

test('LinkedIn builds an organization URN', () => {
  const m = getAnalyticsMapper('linkedin', 'account_insights')!;
  assert.equal(m.buildArgs({ externalAccountId: '2414183' }).organizational_entity, 'urn:li:organization:2414183');
  assert.equal(m.buildArgs({ externalAccountId: 'urn:li:organization:7' }).organizational_entity, 'urn:li:organization:7');
});

test('Meta Ads mapper picks level from the id provided', () => {
  const m = getAnalyticsMapper('meta_ads', 'ad_insights')!;
  assert.equal(m.buildArgs({ externalAccountId: 'act_1', externalAdId: 'ad_9' }).level, 'ad');
  assert.equal(m.buildArgs({ externalAccountId: 'act_1', externalCampaignId: 'c_9' }).level, 'campaign');
  assert.equal(m.buildArgs({ externalAccountId: 'act_1' }).level, 'account');
});

test('unsupported platform/op has no mapper (reddit, tiktok post)', () => {
  assert.equal(getAnalyticsMapper('reddit', 'post_insights'), null);
  assert.equal(getAnalyticsMapper('reddit', 'account_insights'), null);
  assert.equal(getAnalyticsMapper('tiktok', 'post_insights'), null);
});

// --- response parsers (real Graph/YouTube/LinkedIn/MetaAds shapes) ---------

test('IG media parser maps Graph data[].values[].value and leaves missing null', () => {
  const m = getAnalyticsMapper('instagram', 'post_insights')!;
  const parsed = m.parse({
    data: {
      data: [
        { name: 'reach', values: [{ value: 500 }] },
        { name: 'likes', values: [{ value: 42 }] },
        { name: 'saved', values: [{ value: 7 }] },
      ],
    },
  });
  assert.equal(parsed.reach, 500);
  assert.equal(parsed.likes, 42);
  assert.equal(parsed.saves, 7);
  assert.equal(parsed.comments, null); // not in the response → null, not 0
});

test('YouTube parser coerces string statistics to numbers', () => {
  const m = getAnalyticsMapper('youtube', 'post_insights')!;
  const parsed = m.parse({ data: { items: [{ statistics: { viewCount: '1234', likeCount: '56', commentCount: '7' } }] } });
  assert.equal(parsed.views, 1234);
  assert.equal(parsed.likes, 56);
  assert.equal(parsed.comments, 7);
});

test('LinkedIn parser reads totalShareStatistics', () => {
  const m = getAnalyticsMapper('linkedin', 'account_insights')!;
  const parsed = m.parse({ data: { elements: [{ totalShareStatistics: { impressionCount: 900, clickCount: 30, likeCount: 12, commentCount: 3, shareCount: 4, uniqueImpressionsCount: 800 } }] } });
  assert.equal(parsed.impressions, 900);
  assert.equal(parsed.reach, 800);
  assert.equal(parsed.clicks, 30);
  assert.equal(parsed.likes, 12);
});

test('Meta Ads parser computes roas + costPerResult and sums actions', () => {
  const m = getAnalyticsMapper('meta_ads', 'ad_insights')!;
  const parsed = m.parse({ data: { data: [{ impressions: '1000', clicks: '50', spend: '20', reach: '900', cpc: '0.4', cpm: '20', ctr: '5', actions: [{ action_type: 'purchase', value: '4' }], action_values: [{ action_type: 'purchase', value: '80' }] }] } });
  assert.equal(parsed.impressions, 1000);
  assert.equal(parsed.spend, 20);
  assert.equal(parsed.conversions, 4);
  assert.equal(parsed.revenue, 80);
  assert.equal(parsed.roas, 4); // 80/20
  assert.equal(parsed.costPerResult, 5); // 20/4
});

// --- provider end-to-end with the mappers ----------------------------------

test('provider returns normalized metrics for IG using the default mapper slug (no env slug needed)', async () => {
  const gateway = fakeGateway({
    executeResult: { data: { data: [{ name: 'reach', values: [{ value: 300 }] }, { name: 'views', values: [{ value: 1000 }] }] }, successful: true, error: null },
  });
  // No action slug configured → provider must fall back to the verified mapper slug.
  const provider = new ComposioAnalyticsProvider(gateway, fakeConfig({ actions: {} }), fakeDb({ connectionRow: { id: 1, tenant_id: 42, external_user_id: 'u', platform: 'instagram', provider: 'composio', connected_account_id: 'ca_1', auth_config_id: 'ac', external_account_id: 'ig_1', external_account_name: 'IG', status: 'connected', capabilities_json: null, last_capability_check_at: null, created_at: new Date(0), updated_at: new Date(0) } }));
  const m = await provider.getPostInsights({ tenantId, platform: 'instagram', externalPostId: 'media_1' });
  assert.equal(m.reach, 300);
  assert.equal(m.views, 1000);
  assert.equal(m.likes, null);
  assert.equal(gateway.calls[0].slug, 'INSTAGRAM_GET_IG_MEDIA_INSIGHTS');
  assert.equal((gateway.calls[0].options.arguments as Record<string, unknown>).ig_media_id, 'media_1');
});

test('provider returns explicit unavailable for a platform with no mapper (reddit)', async () => {
  const provider = new ComposioAnalyticsProvider(fakeGateway(), fakeConfig({ actions: {} }), fakeDb());
  const m = await provider.getPostInsights({ tenantId, platform: 'reddit', externalPostId: 'p1' });
  assert.equal(m.impressions, null);
  assert.ok(m.unavailableReason && m.unavailableReason.includes('does not expose'));
});
