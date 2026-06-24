import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ComposioPublisherProvider } from '@/backend/integrations/composio/composio-publisher-provider';
import { PublishGuardError } from '@/backend/integrations/providers/errors';
import {
  ComposioCapabilityMissingError,
  ComposioConnectionMissingError,
  ComposioToolError,
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

// ── IG two-step publish (container → publish) ───────────────────────────────
//
// The legacy single-call IG branch (one executeTool with media_urls+placement)
// matched no real Composio action and never published live, so it was rewritten
// to the real two-step: INSTAGRAM_POST_IG_USER_MEDIA (container → creation_id)
// then INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH (creation_id → ig_media_id).

test('IG feed image publishPost is a two-step container→publish (caption on container, ig_user_id, no page_id)', async () => {
  const gateway = fakeGateway({ executeResult: { data: { id: 'ig_42' }, successful: true, error: null } });
  const provider = new ComposioPublisherProvider(
    gateway,
    // Both slots configured; fakeDb default external_account_id='ext_1' is the IG
    // user id, so the INSTAGRAM_GET_USER_INFO resolver is skipped entirely.
    fakeConfig({ actions: { upload_media: 'IG_CONTAINER', publish_post: 'IG_PUBLISH' } }),
    fakeDb(),
  );
  const result = await provider.publishPost({
    tenantId,
    platform: 'instagram',
    content: 'Hello IG',
    mediaUrls: ['https://cdn.example.com/img.jpg'],
    approved: true,
  });

  assert.equal(gateway.calls.length, 2, 'two-step: container then publish');

  const container = gateway.calls[0];
  assert.equal(container.slug, 'IG_CONTAINER', 'step 1 uses the upload_media (container) slug');
  const cArgs = container.options.arguments as Record<string, unknown>;
  assert.equal(cArgs.caption, 'Hello IG', 'caption rides the container');
  assert.equal(cArgs.image_url, 'https://cdn.example.com/img.jpg', 'feed image uses image_url');
  assert.equal(cArgs.ig_user_id, 'ext_1', 'ig_user_id from stored external_account_id');
  assert.equal(cArgs.video_url,  undefined, 'no video_url for an image');
  assert.equal(cArgs.media_type, undefined, 'no media_type for a single feed image (IG defaults to IMAGE)');
  assert.equal(cArgs.page_id,    undefined, 'no page_id for Instagram');
  assert.equal(cArgs.message,    undefined, 'no message for Instagram');
  assert.equal(cArgs.media_urls, undefined, 'the broken media_urls array shape is gone');

  const publish = gateway.calls[1];
  assert.equal(publish.slug, 'IG_PUBLISH', 'step 2 uses the publish_post slug');
  const pArgs = publish.options.arguments as Record<string, unknown>;
  assert.equal(pArgs.creation_id, 'ig_42', 'publish references the container creation id');
  assert.equal(pArgs.ig_user_id, 'ext_1', 'publish carries ig_user_id');

  assert.equal(result.externalPostId, 'ig_42', 'externalPostId is the published media id');
  assert.equal(result.status, 'published');
});

test('IG reel video container uses video_url + media_type=REELS', async () => {
  const gateway = fakeGateway({ executeResult: { data: { id: 'ig_reel_1' }, successful: true, error: null } });
  const provider = new ComposioPublisherProvider(
    gateway,
    fakeConfig({ actions: { upload_media: 'IG_CONTAINER', publish_post: 'IG_PUBLISH' } }),
    fakeDb(),
  );
  await provider.publishPost({
    tenantId,
    platform: 'instagram',
    content: 'reel caption',
    mediaUrls: ['https://cdn.example.com/reel.mp4'],
    placement: 'reel',
    mediaType: 'video',
    mediaMetadata: [{ widthPx: 1080, heightPx: 1920, durationSeconds: 30 }],
    approved: true,
  });

  const cArgs = gateway.calls[0].options.arguments as Record<string, unknown>;
  assert.equal(cArgs.video_url, 'https://cdn.example.com/reel.mp4', 'reel uses video_url');
  assert.equal(cArgs.media_type, 'REELS', 'reel container media_type=REELS');
  assert.equal(cArgs.share_to_feed, undefined, 'a pure reel does not force share_to_feed');
  assert.equal(cArgs.image_url, undefined, 'no image_url for a video');
});

test('IG feed video → REELS + share_to_feed=true; story video → STORIES', async () => {
  const meta = [{ widthPx: 1080, heightPx: 1920, durationSeconds: 20 }];

  const feedGw = fakeGateway({ executeResult: { data: { id: 'x' }, successful: true, error: null } });
  await new ComposioPublisherProvider(
    feedGw,
    fakeConfig({ actions: { upload_media: 'IG_CONTAINER', publish_post: 'IG_PUBLISH' } }),
    fakeDb(),
  ).publishPost({
    tenantId, platform: 'instagram', content: 'feed vid',
    mediaUrls: ['https://cdn.example.com/v.mp4'], placement: 'feed', mediaType: 'video',
    mediaMetadata: meta, approved: true,
  });
  const feedArgs = feedGw.calls[0].options.arguments as Record<string, unknown>;
  assert.equal(feedArgs.media_type, 'REELS', 'feed video posts as a Reel');
  assert.equal(feedArgs.share_to_feed, true, 'feed video also lands in the feed');

  const storyGw = fakeGateway({ executeResult: { data: { id: 'x' }, successful: true, error: null } });
  await new ComposioPublisherProvider(
    storyGw,
    fakeConfig({ actions: { upload_media: 'IG_CONTAINER', publish_post: 'IG_PUBLISH' } }),
    fakeDb(),
  ).publishPost({
    tenantId, platform: 'instagram', content: 'story vid',
    mediaUrls: ['https://cdn.example.com/v.mp4'], placement: 'story', mediaType: 'video',
    mediaMetadata: meta, approved: true,
  });
  const storyArgs = storyGw.calls[0].options.arguments as Record<string, unknown>;
  assert.equal(storyArgs.media_type, 'STORIES', 'story video container media_type=STORIES');
  assert.equal(storyArgs.share_to_feed, undefined, 'story video never forces share_to_feed');
});

test('IG video with invalid media (bad aspect ratio) is rethrown as ComposioToolError (definitely-never-posted), no executeTool', async () => {
  const gateway = fakeGateway({ executeResult: { data: { id: 'should_not_be_used' }, successful: true, error: null } });
  const provider = new ComposioPublisherProvider(
    gateway,
    fakeConfig({ actions: { upload_media: 'IG_CONTAINER', publish_post: 'IG_PUBLISH' } }),
    fakeDb(),
  );
  await assert.rejects(
    () =>
      provider.publishPost({
        tenantId,
        platform: 'instagram',
        content: 'bad reel',
        mediaUrls: ['https://cdn.example.com/wide.mp4'],
        placement: 'reel',
        mediaType: 'video',
        // 16:9 — a reel requires 9:16. The validator throws MetaPublishError;
        // the provider MUST rethrow it as a recognized never-posted error so
        // dispatchPublish does NOT mis-wrap it as outcome-unknown.
        mediaMetadata: [{ widthPx: 1920, heightPx: 1080, durationSeconds: 30 }],
        approved: true,
      }),
    ComposioToolError,
    'a fail-closed media validation error must surface as ComposioToolError (never-posted)',
  );
  assert.equal(gateway.calls.length, 0, 'no Graph/Composio call may be made when validation fails closed');
});

test('IG feed-video is validated as a Reel (9:16): a 16:9 feed clip fails closed (never-posted), no executeTool', async () => {
  // IG feed video publishes as a REELS container (share_to_feed), which Meta
  // requires to be vertical 9:16. A 16:9 "feed" video must be rejected at Aries
  // (against reel constraints), not pass the laxer feed rules then 400 at Meta.
  const gateway = fakeGateway({ executeResult: { data: { id: 'should_not_be_used' }, successful: true, error: null } });
  const provider = new ComposioPublisherProvider(
    gateway,
    fakeConfig({ actions: { upload_media: 'IG_CONTAINER', publish_post: 'IG_PUBLISH' } }),
    fakeDb(),
  );
  await assert.rejects(
    () =>
      provider.publishPost({
        tenantId,
        platform: 'instagram',
        content: 'wide feed video',
        mediaUrls: ['https://cdn.example.com/wide-feed.mp4'],
        placement: 'feed',
        mediaType: 'video',
        mediaMetadata: [{ widthPx: 1920, heightPx: 1080, durationSeconds: 30 }],
        approved: true,
      }),
    ComposioToolError,
    'a non-9:16 IG feed video must fail closed against reel constraints (never-posted)',
  );
  assert.equal(gateway.calls.length, 0, 'no container is created when feed-video validation fails closed');
});

test('FB video uses FACEBOOK_CREATE_VIDEO_POST (publish_video slot) with file_url + published=true', async () => {
  const gateway = fakeGateway({ executeResult: { data: { id: 'fb_vid_1' }, successful: true, error: null } });
  const provider = new ComposioPublisherProvider(
    gateway,
    fakeConfig({ actions: { publish_video: 'FB_VIDEO', publish_post: 'FB_POST', upload_media: 'FB_PHOTO' } }),
    fakeDb(),
  );
  const result = await provider.publishPost({
    tenantId,
    platform: 'facebook',
    content: 'fb video caption',
    mediaUrls: ['https://cdn.example.com/clip.mp4'],
    placement: 'feed',
    mediaType: 'video',
    mediaMetadata: [{ widthPx: 1080, heightPx: 1080, durationSeconds: 20 }],
    approved: true,
  });

  assert.equal(gateway.calls.length, 1, 'FB video is a single Page-video call (no pre-stage)');
  const call = gateway.calls[0];
  assert.equal(call.slug, 'FB_VIDEO', 'video routes to the publish_video slug');
  const args = call.options.arguments as Record<string, unknown>;
  assert.equal(args.file_url, 'https://cdn.example.com/clip.mp4', 'raw mp4 file_url, posted directly');
  assert.equal(args.description, 'fb video caption', 'caption rides description');
  assert.equal(args.page_id, 'ext_1', 'page_id from stored external_account_id');
  assert.equal(args.published, true, 'an unscheduled FB video publishes immediately');
  assert.equal(args.scheduled_publish_time, undefined, 'no schedule time on a live publish');
  assert.equal(result.externalPostId, 'fb_vid_1');
});

test('FB scheduled video sets published=false AND scheduled_publish_time together', async () => {
  const gateway = fakeGateway({ executeResult: { data: { id: 'fb_vid_sched' }, successful: true, error: null } });
  const provider = new ComposioPublisherProvider(
    gateway,
    fakeConfig({ actions: { publish_video: 'FB_VIDEO' } }),
    fakeDb(),
  );
  const result = await provider.publishPost({
    tenantId,
    platform: 'facebook',
    content: 'scheduled fb video',
    mediaUrls: ['https://cdn.example.com/clip.mp4'],
    placement: 'feed',
    mediaType: 'video',
    mediaMetadata: [{ widthPx: 1080, heightPx: 1080, durationSeconds: 20 }],
    scheduledFor: '1999999999',
    approved: true,
  });
  const args = gateway.calls[0].options.arguments as Record<string, unknown>;
  assert.equal(args.published, false, 'a scheduled FB video must NOT publish immediately');
  assert.equal(args.scheduled_publish_time, '1999999999', 'schedule time is passed through');
  assert.equal(result.status, 'scheduled');
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

// ── Regression tests for #667: unhandled-platform refusal ─────────────────
//
// Before the fix, the publishPost dispatch had a bare `else` that silently
// built an Instagram `caption`/`media_urls` payload for any platform that
// wasn't facebook, x, reddit, or linkedin — including tiktok, youtube, and
// meta_ads. The fix made Instagram an explicit `else if` branch and added a
// final `else` that throws ComposioToolError immediately.
//
// The explicit Instagram branch is already exercised by the '#624 IG
// publishPost sends `caption`...' test above. These two tests guard the new
// refusal path.

test('#667 publishPost with an unhandled IntegrationPlatform throws ComposioToolError naming the platform', async () => {
  // 'tiktok' is a valid IntegrationPlatform but has no dispatch branch in
  // publishPost. Before the fix it silently built an Instagram payload for the
  // wrong account; after the fix the final else throws before any gateway call.
  const provider = new ComposioPublisherProvider(
    fakeGateway(),
    fakeConfig({ actions: { publish_post: 'TIKTOK_POST' } }),
    fakeDb(),
  );
  await assert.rejects(
    () =>
      provider.publishPost({
        tenantId,
        platform: 'tiktok',
        content: 'hello tiktok',
        mediaUrls: [],
        approved: true,
      }),
    (err: unknown) => {
      assert.ok(err instanceof ComposioToolError, `expected ComposioToolError, got ${(err as Error)?.name}`);
      assert.match(
        (err as Error).message,
        /tiktok/,
        'error message must name the unhandled platform',
      );
      assert.match(
        (err as Error).message,
        /not a supported publish target/,
        'error message must include "not a supported publish target"',
      );
      return true;
    },
  );
});

test('#667 unhandled-platform publishPost makes zero gateway calls (no silent publish to wrong network)', async () => {
  // Safety property: the refusal must happen BEFORE any executeTool call.
  // On the pre-fix code this assertion would also fail because the Instagram
  // payload would be constructed and the gateway called.
  const gateway = fakeGateway();
  const provider = new ComposioPublisherProvider(
    gateway,
    fakeConfig({ actions: { publish_post: 'YOUTUBE_POST' } }),
    fakeDb(),
  );
  await assert.rejects(
    () =>
      provider.publishPost({
        tenantId,
        platform: 'youtube',
        content: 'hello youtube',
        mediaUrls: ['https://aries.example.com/api/public/media/tok/img.png'],
        approved: true,
      }),
    ComposioToolError,
  );
  assert.equal(gateway.calls.length, 0, 'no gateway call must be made for an unhandled platform');
});
