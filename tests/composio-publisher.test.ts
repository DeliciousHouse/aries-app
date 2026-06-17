import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ComposioPublisherProvider } from '@/backend/integrations/composio/composio-publisher-provider';
import { PublishGuardError } from '@/backend/integrations/providers/errors';
import {
  ComposioCapabilityMissingError,
  ComposioConnectionMissingError,
} from '@/backend/integrations/composio/errors';
import type { ComposioGateway, GatewayToolResult } from '@/backend/integrations/composio/composio-client';
import { fakeConfig, fakeGateway, fakeDb } from './composio/helpers';

const tenantId = '42';

/** Gateway that routes a canned result per slug (for the page-id resolution test). */
function routingGateway(results: Record<string, GatewayToolResult>): ComposioGateway & {
  calls: Array<{ slug: string; connectedAccountId?: string; arguments?: Record<string, unknown> }>;
} {
  const calls: Array<{ slug: string; connectedAccountId?: string; arguments?: Record<string, unknown> }> = [];
  return {
    calls,
    async findOrCreateManagedAuthConfig(s: string) { return `ac_${s}`; },
    async initiateConnection() { return { connectionRequestId: 'cr', redirectUrl: null }; },
    async listConnections() { return []; },
    async getConnection() { return null; },
    async deleteConnection() {},
    async executeTool(slug, options) {
      calls.push({ slug, connectedAccountId: options.connectedAccountId, arguments: options.arguments });
      return results[slug] ?? { data: {}, successful: true, error: null };
    },
  };
}

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

test('instagram publishPost with no action slug still throws capability-missing', async () => {
  // FB now defaults its slugs (so publishing works unconfigured); IG keeps the
  // configured-slug-required guard.
  const provider = new ComposioPublisherProvider(fakeGateway(), fakeConfig({ actions: {} }), fakeDb());
  await assert.rejects(
    () => provider.publishPost({ tenantId, platform: 'instagram', content: 'hi', mediaUrls: ['u'], approved: true }),
    ComposioCapabilityMissingError,
  );
});

test('#624 FB image post sends message + page_id + url (NOT text/caption/media_urls), photo action', async () => {
  const gateway = fakeGateway({ executeResult: { data: { id: 'post_999', permalink: 'https://fb/p/999' }, successful: true, error: null } });
  const provider = new ComposioPublisherProvider(
    gateway,
    fakeConfig({ actions: { upload_media: 'FB_PHOTO', publish_post: 'FB_POST' } }),
    fakeDb(), // default connection row has external_account_id 'ext_1'
  );
  const result = await provider.publishPost({ tenantId, platform: 'facebook', content: 'hello world', mediaUrls: ['https://img/x.jpg'], approved: true });

  assert.equal(result.status, 'published');
  assert.equal(result.externalPostId, 'post_999');
  assert.equal(result.url, 'https://fb/p/999');

  // Image post routes to the photo action, NOT the text publish_post slug.
  assert.equal(gateway.calls[0].slug, 'FB_PHOTO');
  const args = gateway.calls[0].options.arguments as Record<string, unknown>;
  assert.equal(args.page_id, 'ext_1');
  assert.equal(args.message, 'hello world');
  assert.equal(args.url, 'https://img/x.jpg');
  // The broken generic shape must be gone.
  assert.equal(args.text, undefined);
  assert.equal(args.caption, undefined);
  assert.equal(args.media_urls, undefined);
});

test('#624 FB image post works with NO configured slugs (verified photo-post default)', async () => {
  const gateway = fakeGateway({ executeResult: { data: { id: 'p1' }, successful: true, error: null } });
  const provider = new ComposioPublisherProvider(gateway, fakeConfig({ actions: {} }), fakeDb());
  await provider.publishPost({ tenantId, platform: 'facebook', content: 'c', mediaUrls: ['u'], approved: true });
  assert.equal(gateway.calls[0].slug, 'FACEBOOK_CREATE_PHOTO_POST');
  const args = gateway.calls[0].options.arguments as Record<string, unknown>;
  assert.equal(args.page_id, 'ext_1');
  assert.equal(args.message, 'c');
  assert.equal(args.url, 'u');
});

test('#624 FB text-only post sends message + page_id (no url), text action', async () => {
  const gateway = fakeGateway({ executeResult: { data: { id: 'post_text' }, successful: true, error: null } });
  const provider = new ComposioPublisherProvider(gateway, fakeConfig({ actions: { publish_post: 'FB_POST' } }), fakeDb());
  await provider.publishPost({ tenantId, platform: 'facebook', content: 'just text', mediaUrls: [], approved: true });

  assert.equal(gateway.calls[0].slug, 'FB_POST');
  const args = gateway.calls[0].options.arguments as Record<string, unknown>;
  assert.equal(args.page_id, 'ext_1');
  assert.equal(args.message, 'just text');
  assert.equal(args.url, undefined);
});

test('#624 FB publish resolves + persists page_id via FACEBOOK_LIST_MANAGED_PAGES when external_account_id is null', async () => {
  const gateway = routingGateway({
    FACEBOOK_LIST_MANAGED_PAGES: { successful: true, error: null, data: { data: [{ id: 'PAGE777', name: 'Aries Page' }] } },
    FACEBOOK_CREATE_PHOTO_POST: { successful: true, error: null, data: { id: 'post_42' } },
  });
  const db = fakeDb({
    connectionRow: {
      id: 9, tenant_id: 42, external_user_id: 'u', platform: 'facebook', provider: 'composio',
      connected_account_id: 'ca_live', auth_config_id: 'ac', external_account_id: null,
      external_account_name: null, status: 'connected', capabilities_json: null,
      last_capability_check_at: null, created_at: new Date(0), updated_at: new Date(0),
    },
  });
  const provider = new ComposioPublisherProvider(gateway, fakeConfig({ actions: {} }), db);

  const result = await provider.publishPost({ tenantId, platform: 'facebook', content: 'c', mediaUrls: ['u'], approved: true });

  // Resolved the page id from Composio, then posted with it.
  assert.equal(gateway.calls[0].slug, 'FACEBOOK_LIST_MANAGED_PAGES');
  assert.equal(gateway.calls[1].slug, 'FACEBOOK_CREATE_PHOTO_POST');
  assert.equal((gateway.calls[1].arguments as Record<string, unknown>).page_id, 'PAGE777');
  assert.equal(result.externalPostId, 'post_42');
  // Back-healed connected_accounts.
  const update = db.queries.find((q) => /UPDATE connected_accounts/i.test(q.text));
  assert.ok(update, 'persists the resolved page id back to connected_accounts');
  assert.equal(update!.params[0], 'PAGE777');
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

test('#624 uploadMedia for FB sends page_id + url (not media_url) when a slug is configured', async () => {
  const gateway = fakeGateway({ executeResult: { data: { id: 'm1' }, successful: true, error: null } });
  const provider = new ComposioPublisherProvider(gateway, fakeConfig({ actions: { upload_media: 'FB_PHOTO' } }), fakeDb());
  await provider.uploadMedia({ tenantId, platform: 'facebook', mediaUrl: 'https://img/y.jpg', mediaType: 'image' });
  const args = gateway.calls[0].options.arguments as Record<string, unknown>;
  assert.equal(args.page_id, 'ext_1');
  assert.equal(args.url, 'https://img/y.jpg');
  assert.equal(args.media_url, undefined);
});
