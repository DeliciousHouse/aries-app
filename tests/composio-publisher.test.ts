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
  // Text-only (no media) so the publish_post slug is used — the image-post path is
  // covered by the #627 regression tests below.
  const gateway = fakeGateway({ executeResult: { data: { id: 'post_999', permalink: 'https://fb/p/999' }, successful: true, error: null } });
  const provider = new ComposioPublisherProvider(gateway, fakeConfig({ actions: { publish_post: 'FB_POST' } }), fakeDb());
  const result = await provider.publishPost({ tenantId, platform: 'facebook', content: 'hi', mediaUrls: [], approved: true });
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

// ── Regression tests for #624: correct FB field names + page_id injection ───

test('#624 FB publishPost sends `message` + `page_id` from stored external_account_id — NOT `text`/`caption`', async () => {
  // fakeDb default has external_account_id='ext_1' — that is the page_id
  // that must now be injected as page_id into the tool arguments.
  const gateway = fakeGateway({ executeResult: { data: { id: 'post_1' }, successful: true, error: null } });
  const provider = new ComposioPublisherProvider(gateway, fakeConfig({ actions: { publish_post: 'FB_POST' } }), fakeDb());
  await provider.publishPost({ tenantId, platform: 'facebook', content: 'Hello World', mediaUrls: [], approved: true });

  assert.equal(gateway.calls.length, 1, 'exactly one executeTool call');
  const args = gateway.calls[0].options.arguments as Record<string, unknown>;

  // Must use `message` (the FB Graph / FACEBOOK_CREATE_POST field)
  assert.equal(args.message, 'Hello World', 'content must be in `message` field');
  // Must inject the page_id from the stored external_account_id
  assert.equal(args.page_id, 'ext_1', 'page_id must equal the stored external_account_id');
  // Must NOT use the old wrong field names
  assert.equal(args.text,    undefined, '`text` must not be sent to the Facebook tool');
  assert.equal(args.caption, undefined, '`caption` must not be sent to the Facebook tool');
});

test('#624 FB publishPost with null external_account_id falls back to resolveFacebookManagedPage', async () => {
  // Simulate a connect-time race where external_account_id was not yet populated.
  // The gateway is called twice: once for list_pages (FACEBOOK_LIST_MANAGED_PAGES)
  // and once for publish_post. Both return the same executeResult here; the
  // list_pages call is stateless and we only need it to return a valid page array.
  const pageListResponse = {
    data: { data: [{ id: 'page_from_api', name: 'API Page' }] },
    successful: true,
    error: null,
  };
  const publishResponse = { data: { id: 'post_999' }, successful: true, error: null };

  // Sequence: call[0]=list_pages, call[1]=publish_post
  const results = [pageListResponse, publishResponse];
  const gateway = fakeGateway({
    onExecute: () => {/* track only */},
  });
  // Override executeTool to return sequenced results
  let callIdx = 0;
  const origExecute = gateway.executeTool.bind(gateway);
  gateway.executeTool = async (slug, opts) => {
    const result = results[callIdx] ?? publishResponse;
    callIdx++;
    gateway.calls.push({ slug, options: opts });
    return result;
  };

  // A row with null external_account_id
  const nullPageRow = {
    id: 1,
    tenant_id: 42,
    external_user_id: 'aries-tenant-42',
    platform: 'facebook',
    provider: 'composio',
    connected_account_id: 'ca_123',
    auth_config_id: 'auth_cfg_test',
    external_account_id: null,
    external_account_name: null,
    status: 'connected',
    capabilities_json: null,
    last_capability_check_at: null,
    created_at: new Date(0),
    updated_at: new Date(0),
  };
  const provider = new ComposioPublisherProvider(
    gateway,
    fakeConfig({ actions: { publish_post: 'FB_POST' } }),
    fakeDb({ connectionRow: nullPageRow }),
  );
  const result = await provider.publishPost({ tenantId, platform: 'facebook', content: 'hi', mediaUrls: [], approved: true });

  assert.equal(result.externalPostId, 'post_999', 'publish must succeed using the API-resolved page_id');
  // Second call is the publish; its args must carry the page_id from the API response
  const publishCall = gateway.calls.find((c) => c.slug === 'FB_POST');
  assert.ok(publishCall, 'FB_POST must have been called');
  const publishArgs = publishCall!.options.arguments as Record<string, unknown>;
  assert.equal(publishArgs.page_id, 'page_from_api', 'page_id must come from resolveFacebookManagedPage fallback');
  assert.equal(publishArgs.message, 'hi', 'content must still be in `message`');
});

test('#624 FB publishPost with null external_account_id and no page returned throws capability-missing', async () => {
  // Simulate: no page is returned at all (e.g. pages_show_list scope missing)
  const noPageGateway = fakeGateway({
    executeResult: { data: null, successful: false, error: 'access denied' },
  });

  const nullPageRow = {
    id: 1,
    tenant_id: 42,
    external_user_id: 'aries-tenant-42',
    platform: 'facebook',
    provider: 'composio',
    connected_account_id: 'ca_123',
    auth_config_id: 'auth_cfg_test',
    external_account_id: null,
    external_account_name: null,
    status: 'connected',
    capabilities_json: null,
    last_capability_check_at: null,
    created_at: new Date(0),
    updated_at: new Date(0),
  };
  const provider = new ComposioPublisherProvider(
    noPageGateway,
    fakeConfig({ actions: { publish_post: 'FB_POST' } }),
    fakeDb({ connectionRow: nullPageRow }),
  );
  await assert.rejects(
    () => provider.publishPost({ tenantId, platform: 'facebook', content: 'hi', mediaUrls: [], approved: true }),
    ComposioCapabilityMissingError,
    'must throw capability-missing when no page can be identified',
  );
});

test('#624 IG publishPost sends `caption` (not `message`) and no `page_id`', async () => {
  const gateway = fakeGateway({ executeResult: { data: { id: 'ig_post_42' }, successful: true, error: null } });
  const provider = new ComposioPublisherProvider(gateway, fakeConfig({ actions: { publish_post: 'IG_POST' } }), fakeDb());
  await provider.publishPost({ tenantId, platform: 'instagram', content: 'Hello IG', mediaUrls: ['img.jpg'], approved: true });

  const args = gateway.calls[0].options.arguments as Record<string, unknown>;
  assert.equal(args.caption, 'Hello IG', 'Instagram must still use `caption`');
  assert.equal(args.message,  undefined, '`message` must not be set for Instagram');
  assert.equal(args.page_id,  undefined, '`page_id` must not be set for Instagram');
});

// ── Regression tests for #627: FB image posts use FACEBOOK_CREATE_PHOTO_POST ─

test('#627 FB image post routes to upload_media slug (FACEBOOK_CREATE_PHOTO_POST) with url+message+page_id', async () => {
  // When mediaUrls is non-empty, publishPost must use the `upload_media` slug
  // (FACEBOOK_CREATE_PHOTO_POST) with `url` (not `media_urls`) + `message` + `page_id`.
  // Using FACEBOOK_CREATE_POST (the publish_post slug) ignores the image entirely.
  const gateway = fakeGateway({ executeResult: { data: { id: '123', post_id: '1002997576221948_456' }, successful: true, error: null } });
  const provider = new ComposioPublisherProvider(
    gateway,
    fakeConfig({ actions: { publish_post: 'FB_POST', upload_media: 'FB_PHOTO_POST' } }),
    fakeDb(),
  );
  await provider.publishPost({
    tenantId,
    platform: 'facebook',
    content: 'Look at this image!',
    mediaUrls: ['https://aries.example.com/api/public/media/token123/image.png'],
    approved: true,
  });

  assert.equal(gateway.calls.length, 1, 'exactly one executeTool call');
  const call = gateway.calls[0];

  // Must route to the photo slug, NOT the text slug
  assert.equal(call.slug, 'FB_PHOTO_POST', 'image post must use upload_media slug (FACEBOOK_CREATE_PHOTO_POST)');
  assert.notEqual(call.slug, 'FB_POST', 'image post must NOT use publish_post slug (FACEBOOK_CREATE_POST)');

  const args = call.options.arguments as Record<string, unknown>;
  // url must be the first (and only) mediaUrl
  assert.equal(args.url, 'https://aries.example.com/api/public/media/token123/image.png', 'url must be the signed image URL');
  // message (not caption or text) carries the post text
  assert.equal(args.message, 'Look at this image!', 'message must carry the post text');
  // page_id must be injected from the stored external_account_id
  assert.equal(args.page_id, 'ext_1', 'page_id must equal the stored external_account_id');
  // must NOT use media_urls (which FACEBOOK_CREATE_POST / FACEBOOK_CREATE_PHOTO_POST ignores / mishandles)
  assert.equal(args.media_urls, undefined, 'media_urls must NOT be passed to FACEBOOK_CREATE_PHOTO_POST');
  assert.equal(args.caption,    undefined, 'caption must NOT be set for Facebook photo posts');
  assert.equal(args.text,       undefined, 'text must NOT be set (old wrong field)');
});

test('#627 FB text-only post still uses publish_post slug (FACEBOOK_CREATE_POST) with message+page_id', async () => {
  const gateway = fakeGateway({ executeResult: { data: { id: 'post_text_1' }, successful: true, error: null } });
  const provider = new ComposioPublisherProvider(
    gateway,
    fakeConfig({ actions: { publish_post: 'FB_POST', upload_media: 'FB_PHOTO_POST' } }),
    fakeDb(),
  );
  await provider.publishPost({
    tenantId,
    platform: 'facebook',
    content: 'Text only, no image.',
    mediaUrls: [],
    approved: true,
  });

  assert.equal(gateway.calls.length, 1, 'exactly one executeTool call');
  const call = gateway.calls[0];
  assert.equal(call.slug, 'FB_POST', 'text-only post must still use publish_post slug');
  const args = call.options.arguments as Record<string, unknown>;
  assert.equal(args.message, 'Text only, no image.', 'text-only post must carry message');
  assert.equal(args.page_id, 'ext_1', 'text-only post must carry page_id');
  assert.equal(args.url,        undefined, 'url must NOT be set for text-only post');
  assert.equal(args.media_urls, undefined, 'media_urls must NOT be set for text-only post');
});

test('#627 FB image post with no upload_media slug throws capability-missing', async () => {
  // No upload_media slug configured → should throw ComposioCapabilityMissingError
  const provider = new ComposioPublisherProvider(
    fakeGateway(),
    fakeConfig({ actions: { publish_post: 'FB_POST' /* no upload_media */ } }),
    fakeDb(),
  );
  await assert.rejects(
    () => provider.publishPost({ tenantId, platform: 'facebook', content: 'hi', mediaUrls: ['img.png'], approved: true }),
    ComposioCapabilityMissingError,
    'missing upload_media slug must throw capability-missing',
  );
});
