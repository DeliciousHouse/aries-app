import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ComposioPublisherProvider } from '@/backend/integrations/composio/composio-publisher-provider';
import { PublishGuardError } from '@/backend/integrations/providers/errors';
import {
  ComposioCapabilityMissingError,
  ComposioConnectionMissingError,
} from '@/backend/integrations/composio/errors';
import { fakeConfig, fakeGateway, fakeDb } from './composio/helpers';

const tenantId = '42';

test('publishPost dry-run returns preview and never calls the gateway', async () => {
  const gateway = fakeGateway();
  const provider = new ComposioPublisherProvider(gateway, fakeConfig({ actions: { publish_post: 'FB_POST' } }), fakeDb());
  const result = await provider.publishPost({
    tenantId,
    platform: 'facebook',
    content: 'hi',
    mediaUrls: [],
    dryRun: true,
  });
  assert.equal(result.status, 'preview');
  assert.equal(gateway.calls.length, 0);
});

test('publishPost without approval is refused (no live post)', async () => {
  const provider = new ComposioPublisherProvider(fakeGateway(), fakeConfig({ actions: { publish_post: 'FB_POST' } }), fakeDb());
  await assert.rejects(
    () => provider.publishPost({ tenantId, platform: 'facebook', content: 'hi', mediaUrls: [], approved: false }),
    PublishGuardError,
  );
});

test('publishPost approved but no active connection throws connection-missing', async () => {
  const provider = new ComposioPublisherProvider(
    fakeGateway(),
    fakeConfig({ actions: { publish_post: 'FB_POST' } }),
    fakeDb({ connectionRow: null }),
  );
  await assert.rejects(
    () => provider.publishPost({ tenantId, platform: 'facebook', content: 'hi', mediaUrls: ['u'], approved: true }),
    ComposioConnectionMissingError,
  );
});

test('publishPost approved + active connection but no action slug throws capability-missing', async () => {
  const provider = new ComposioPublisherProvider(fakeGateway(), fakeConfig({ actions: {} }), fakeDb());
  await assert.rejects(
    () => provider.publishPost({ tenantId, platform: 'facebook', content: 'hi', mediaUrls: ['u'], approved: true }),
    ComposioCapabilityMissingError,
  );
});

test('publishPost approved + slug executes and normalizes the post id', async () => {
  const gateway = fakeGateway({ executeResult: { data: { id: 'post_999', permalink: 'https://fb/p/999' }, successful: true, error: null } });
  const provider = new ComposioPublisherProvider(gateway, fakeConfig({ actions: { publish_post: 'FB_POST' } }), fakeDb());
  const result = await provider.publishPost({ tenantId, platform: 'facebook', content: 'hi', mediaUrls: ['u'], approved: true });
  assert.equal(result.status, 'published');
  assert.equal(result.externalPostId, 'post_999');
  assert.equal(result.url, 'https://fb/p/999');
  assert.equal(gateway.calls[0].slug, 'FB_POST');
});

test('publishAd ALWAYS creates PAUSED and forces PAUSED status args', async () => {
  const gateway = fakeGateway({ executeResult: { data: { campaign_id: 'c1', ad_id: 'a1' }, successful: true, error: null } });
  const provider = new ComposioPublisherProvider(gateway, fakeConfig({ actions: { create_ad: 'META_CREATE_AD' } }), fakeDb());
  const result = await provider.publishAd({ tenantId, platform: 'meta_ads', name: 'Promo' });
  assert.equal(result.status, 'paused');
  assert.equal(result.externalCampaignId, 'c1');
  assert.equal(result.externalAdId, 'a1');
  const args = gateway.calls[0].options.arguments as Record<string, unknown>;
  assert.equal(args.status, 'PAUSED');
  assert.equal(args.campaign_status, 'PAUSED');
  assert.equal(args.adset_status, 'PAUSED');
});

test('uploadMedia with no configured slug is a documented no-op preview', async () => {
  const gateway = fakeGateway();
  const provider = new ComposioPublisherProvider(gateway, fakeConfig({ actions: {} }), fakeDb());
  const result = await provider.uploadMedia({ tenantId, platform: 'facebook', mediaUrl: 'u', mediaType: 'image' });
  assert.equal(result.status, 'preview');
  assert.equal(gateway.calls.length, 0);
});
