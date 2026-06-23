/**
 * Unit tests for the Instagram insights adapter (#692 analytics, #693 comments).
 *
 * Covers the full InsightsAdapter surface:
 *   fetchPostList       → INSTAGRAM_GET_IG_USER_MEDIA
 *   fetchPostMetrics    → INSTAGRAM_GET_IG_MEDIA_INSIGHTS (fail-soft + honesty bar)
 *   fetchAccountMetrics → INSTAGRAM_GET_USER_INSIGHTS + INSTAGRAM_GET_USER_INFO
 *   fetchComments       → INSTAGRAM_GET_IG_MEDIA_COMMENTS
 *
 * Uses a fake routing gateway and injected fakeConfig — no network, no database.
 * Mirrors the structure of tests/insights-facebook-adapter.test.ts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InstagramInsightsAdapter } from '@/backend/insights/adapters/instagram/index';
import type {
  ComposioGateway,
  GatewayToolResult,
} from '@/backend/integrations/composio/composio-client';
import { fakeConfig } from './composio/helpers';

interface RecordedCall {
  slug: string;
  connectedAccountId?: string;
  arguments?: Record<string, unknown>;
}

/** Gateway that routes a canned result per action slug and records every call. */
function routingGateway(
  results: Record<string, GatewayToolResult>,
): ComposioGateway & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    async findOrCreateManagedAuthConfig(s: string) { return `ac_${s}`; },
    async initiateConnection() { return { connectionRequestId: 'cr', redirectUrl: null }; },
    async listConnections() { return []; },
    async getConnection() { return null; },
    async deleteConnection() {},
    async executeTool(slug, options) {
      calls.push({ slug, connectedAccountId: options.connectedAccountId, arguments: options.arguments });
      return results[slug] ?? { data: { data: [] }, successful: true, error: null };
    },
    async uploadFile(input) {
      return { name: 'staged', mimetype: 'application/octet-stream', s3key: `s3/${input.toolSlug}` };
    },
  };
}

const ctx = { connectedAccountId: 'ca_ig_1' };
const IG_USER_ID = 'ig_123456789';
const IG_POST_ID = 'ig_post_111';

// ── fetchPostList ─────────────────────────────────────────────────────────────

test('fetchPostList: builds INSTAGRAM_GET_IG_USER_MEDIA with ig_user_id, maps IMAGE→image, captures like_count/comments_count', async () => {
  const gateway = routingGateway({
    INSTAGRAM_GET_IG_USER_MEDIA: {
      successful: true,
      error: null,
      data: {
        data: [
          {
            id: IG_POST_ID,
            caption: 'Hello IG world',
            permalink: 'https://www.instagram.com/p/abc123/',
            media_type: 'IMAGE',
            media_url: 'https://img/photo.jpg',
            thumbnail_url: 'https://img/thumb.jpg',
            timestamp: '2026-06-10T12:00:00+0000',
            like_count: 55,
            comments_count: 8,
          },
        ],
      },
    },
  });
  const adapter = new InstagramInsightsAdapter(gateway, fakeConfig({ actions: {} }), ctx);

  const posts = await adapter.fetchPostList(IG_USER_ID);

  assert.equal(gateway.calls[0].slug, 'INSTAGRAM_GET_IG_USER_MEDIA');
  assert.equal(gateway.calls[0].connectedAccountId, 'ca_ig_1');
  assert.equal(gateway.calls[0].arguments?.ig_user_id, IG_USER_ID);
  // Fields must include the engagement columns so the cache can be primed
  assert.match(String(gateway.calls[0].arguments?.fields), /like_count/);
  assert.match(String(gateway.calls[0].arguments?.fields), /comments_count/);

  assert.equal(posts.length, 1);
  assert.equal(posts[0].externalPostId, IG_POST_ID);
  assert.equal(posts[0].mediaType, 'image');
  assert.equal(posts[0].caption, 'Hello IG world');
  assert.equal(posts[0].permalink, 'https://www.instagram.com/p/abc123/');
  // thumbnail_url takes priority over media_url
  assert.equal(posts[0].thumbnailUrl, 'https://img/thumb.jpg');
});

test('fetchPostList: maps VIDEO→video, CAROUSEL_ALBUM→carousel, REELS→reel; falls back to media_url for thumbnail when thumbnail_url absent', async () => {
  const gateway = routingGateway({
    INSTAGRAM_GET_IG_USER_MEDIA: {
      successful: true,
      error: null,
      data: {
        data: [
          { id: 'vid1',      media_type: 'VIDEO',         media_url: 'https://img/v.mp4', timestamp: '2026-06-10T10:00:00+0000', like_count: 0, comments_count: 0 },
          { id: 'carousel1', media_type: 'CAROUSEL_ALBUM', media_url: 'https://img/c.jpg', timestamp: '2026-06-10T10:00:00+0000', like_count: 0, comments_count: 0 },
          { id: 'reel1',     media_type: 'REELS',          media_url: 'https://img/r.mp4', timestamp: '2026-06-10T10:00:00+0000', like_count: 0, comments_count: 0 },
        ],
      },
    },
  });
  const adapter = new InstagramInsightsAdapter(gateway, fakeConfig({ actions: {} }), ctx);

  const posts = await adapter.fetchPostList(IG_USER_ID);
  assert.equal(posts.length, 3);

  const vid = posts.find((p) => p.externalPostId === 'vid1');
  assert.equal(vid?.mediaType, 'video');
  // Falls back to media_url when thumbnail_url absent
  assert.equal(vid?.thumbnailUrl, 'https://img/v.mp4');

  const carousel = posts.find((p) => p.externalPostId === 'carousel1');
  assert.equal(carousel?.mediaType, 'carousel');

  const reel = posts.find((p) => p.externalPostId === 'reel1');
  assert.equal(reel?.mediaType, 'reel');
});

// ── fetchPostMetrics ──────────────────────────────────────────────────────────

test('fetchPostMetrics: views/reach/saved from INSTAGRAM_GET_IG_MEDIA_INSIGHTS; likes/comments from insights when available', async () => {
  const gateway = routingGateway({
    INSTAGRAM_GET_IG_USER_MEDIA: {
      successful: true,
      error: null,
      data: {
        data: [
          { id: IG_POST_ID, timestamp: '2026-06-10T10:00:00+0000', like_count: 100, comments_count: 15 },
        ],
      },
    },
    INSTAGRAM_GET_IG_MEDIA_INSIGHTS: {
      successful: true,
      error: null,
      data: {
        data: [
          { name: 'views',    values: [{ value: 4200 }] },
          { name: 'reach',    values: [{ value: 3900 }] },
          { name: 'saved',    values: [{ value: 60 }] },
          { name: 'likes',    values: [{ value: 88 }] },
          { name: 'comments', values: [{ value: 12 }] },
          { name: 'shares',   values: [{ value: 5 }] },
        ],
      },
    },
  });
  const adapter = new InstagramInsightsAdapter(gateway, fakeConfig({ actions: {} }), ctx);

  // Prime the engagement cache so fetchPostMetrics can fall back to it for this post.
  await adapter.fetchPostList(IG_USER_ID);
  const metrics = await adapter.fetchPostMetrics(IG_POST_ID);

  const insightsCall = gateway.calls.find((c) => c.slug === 'INSTAGRAM_GET_IG_MEDIA_INSIGHTS');
  assert.ok(insightsCall, 'calls INSTAGRAM_GET_IG_MEDIA_INSIGHTS');
  assert.equal(insightsCall?.arguments?.ig_media_id, IG_POST_ID);
  assert.equal(insightsCall?.connectedAccountId, 'ca_ig_1');

  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].views, 4200);          // from MEDIA_INSIGHTS
  assert.equal(metrics[0].likes, 88);            // from MEDIA_INSIGHTS (not list cache)
  assert.equal(metrics[0].commentsCount, 12);    // from MEDIA_INSIGHTS
  assert.equal(metrics[0].shares, 5);
  // saved is in rawSource (no dedicated DB column)
  assert.equal(metrics[0].rawSource.saved, 60);
  assert.equal(metrics[0].rawSource.reach, 3900);
});

test('fetchPostMetrics: likes/comments fall back to cached list engagement when insights return no breakdown', async () => {
  const gateway = routingGateway({
    INSTAGRAM_GET_IG_USER_MEDIA: {
      successful: true,
      error: null,
      data: {
        data: [
          { id: IG_POST_ID, timestamp: '2026-06-10T10:00:00+0000', like_count: 77, comments_count: 9 },
        ],
      },
    },
    // Insights only return views — no likes/comments breakdown.
    INSTAGRAM_GET_IG_MEDIA_INSIGHTS: {
      successful: true,
      error: null,
      data: {
        data: [
          { name: 'views', values: [{ value: 1500 }] },
        ],
      },
    },
  });
  const adapter = new InstagramInsightsAdapter(gateway, fakeConfig({ actions: {} }), ctx);

  await adapter.fetchPostList(IG_USER_ID);
  const metrics = await adapter.fetchPostMetrics(IG_POST_ID);

  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].views, 1500);   // from MEDIA_INSIGHTS
  assert.equal(metrics[0].likes, 77);    // from engagement cache (fetchPostList captured like_count)
  assert.equal(metrics[0].commentsCount, 9); // from engagement cache
});

test('HONESTY BAR: restricted insights (<1000 followers) with no engagement cache → [], never a fabricated 0-view row', async () => {
  // Simulates an account under the 1000-follower threshold where the IG API denies
  // per-post insights. The adapter must NOT fabricate { views: 0, likes: 0, ... }.
  const gateway = routingGateway({
    INSTAGRAM_GET_IG_MEDIA_INSIGHTS: {
      successful: false,
      error: 'This media object is not accessible.',
      data: null,
    },
  });
  const adapter = new InstagramInsightsAdapter(gateway, fakeConfig({ actions: {} }), ctx);
  // No fetchPostList call → engagement cache is empty.
  const metrics = await adapter.fetchPostMetrics('ig_post_restricted');
  assert.deepEqual(metrics, [], 'restricted account with no cache → [], never a fabricated 0-view row');
  // Also verify with empty data response (the API returns 200 but no metrics).
  const gateway2 = routingGateway({
    INSTAGRAM_GET_IG_MEDIA_INSIGHTS: { successful: true, error: null, data: { data: [] } },
  });
  const adapter2 = new InstagramInsightsAdapter(gateway2, fakeConfig({ actions: {} }), ctx);
  const metrics2 = await adapter2.fetchPostMetrics('ig_post_empty');
  assert.deepEqual(metrics2, [], 'empty insights data and no cache → [], never a 0-view row');
});

test('fetchPostMetrics: fail-soft on unsuccessful insights call → falls back to engagement cache when available', async () => {
  const gateway = routingGateway({
    INSTAGRAM_GET_IG_USER_MEDIA: {
      successful: true,
      error: null,
      data: {
        data: [
          { id: IG_POST_ID, timestamp: '2026-06-10T10:00:00+0000', like_count: 44, comments_count: 6 },
        ],
      },
    },
    // Insights call fails (restricted/rate-limited).
    INSTAGRAM_GET_IG_MEDIA_INSIGHTS: {
      successful: false,
      error: 'rate limited (code 32)',
      data: null,
    },
  });
  const adapter = new InstagramInsightsAdapter(gateway, fakeConfig({ actions: {} }), ctx);

  // Prime the cache first.
  await adapter.fetchPostList(IG_USER_ID);
  // Must not throw — fail-soft path uses cache.
  const metrics = await adapter.fetchPostMetrics(IG_POST_ID);

  assert.equal(metrics.length, 1, 'emits a row because engagement cache has data');
  // views is null → coerced to 0 (API had no data; NOT fabricated — we have engagement signal)
  assert.equal(metrics[0].views, 0);
  assert.equal(metrics[0].likes, 44);        // from engagement cache
  assert.equal(metrics[0].commentsCount, 6); // from engagement cache
});

// ── fetchAccountMetrics ───────────────────────────────────────────────────────

test('fetchAccountMetrics: pivots INSTAGRAM_GET_USER_INSIGHTS per day + folds INSTAGRAM_GET_USER_INFO followers', async () => {
  const gateway = routingGateway({
    INSTAGRAM_GET_USER_INSIGHTS: {
      successful: true,
      error: null,
      data: {
        data: [
          { name: 'views',          values: [{ value: 800, end_time: '2026-06-09T07:00:00+0000' }, { value: 950, end_time: '2026-06-10T07:00:00+0000' }] },
          { name: 'reach',          values: [{ value: 700, end_time: '2026-06-09T07:00:00+0000' }, { value: 820, end_time: '2026-06-10T07:00:00+0000' }] },
          { name: 'follower_count', values: [{ value: 1100, end_time: '2026-06-09T07:00:00+0000' }, { value: 1110, end_time: '2026-06-10T07:00:00+0000' }] },
        ],
      },
    },
    INSTAGRAM_GET_USER_INFO: {
      successful: true,
      error: null,
      // USER_INFO provides the authoritative current follower count
      data: { data: { id: IG_USER_ID, followers_count: 1234 } },
    },
  });
  const adapter = new InstagramInsightsAdapter(gateway, fakeConfig({ actions: {} }), ctx);

  const days = await adapter.fetchAccountMetrics(IG_USER_ID, { from: '2026-06-09', to: '2026-06-10' });

  const insightsCall = gateway.calls.find((c) => c.slug === 'INSTAGRAM_GET_USER_INSIGHTS');
  assert.ok(insightsCall, 'calls INSTAGRAM_GET_USER_INSIGHTS');
  assert.equal(insightsCall?.arguments?.ig_user_id, IG_USER_ID);
  assert.equal(insightsCall?.arguments?.since, '2026-06-09');
  assert.equal(insightsCall?.arguments?.until, '2026-06-10');
  assert.equal(insightsCall?.arguments?.period, 'day');

  const infoCall = gateway.calls.find((c) => c.slug === 'INSTAGRAM_GET_USER_INFO');
  assert.ok(infoCall, 'fetches followers via INSTAGRAM_GET_USER_INFO');
  assert.equal(infoCall?.arguments?.ig_user_id, IG_USER_ID);
  assert.match(String(infoCall?.arguments?.fields), /followers_count/);

  const d9 = days.find((d) => d.date === '2026-06-09');
  const d10 = days.find((d) => d.date === '2026-06-10');
  assert.ok(d9, 'June 9 is present');
  assert.ok(d10, 'June 10 is present');

  assert.equal(d9?.views, 800);
  // On the non-latest day the daily follower_count metric is used
  assert.equal(d9?.followers, 1100);

  assert.equal(d10?.views, 950);
  // On the latest day (range.to), the authoritative USER_INFO followers_count overrides
  assert.equal(d10?.followers, 1234, 'USER_INFO followers_count stamped on the latest day');
});

test('fetchAccountMetrics: INSTAGRAM_GET_USER_INFO failure → day series still emitted, follower_count from daily metric', async () => {
  const gateway = routingGateway({
    INSTAGRAM_GET_USER_INSIGHTS: {
      successful: true,
      error: null,
      data: {
        data: [
          { name: 'views',          values: [{ value: 500, end_time: '2026-06-10T07:00:00+0000' }] },
          { name: 'follower_count', values: [{ value: 1000, end_time: '2026-06-10T07:00:00+0000' }] },
        ],
      },
    },
    // USER_INFO fails — must not drop the day series.
    INSTAGRAM_GET_USER_INFO: { successful: false, error: 'unauthorized', data: null },
  });
  const adapter = new InstagramInsightsAdapter(gateway, fakeConfig({ actions: {} }), ctx);

  const days = await adapter.fetchAccountMetrics(IG_USER_ID, { from: '2026-06-10', to: '2026-06-10' });

  assert.equal(days.length, 1, 'day series still emitted when USER_INFO fails');
  assert.equal(days[0].views, 500);
  // Falls back to daily follower_count metric from USER_INSIGHTS
  assert.equal(days[0].followers, 1000, 'followers from daily follower_count metric when USER_INFO fails');
});

// ── fetchComments ─────────────────────────────────────────────────────────────

test('fetchComments: maps INSTAGRAM_GET_IG_MEDIA_COMMENTS (username→authorHandle, text→bodyText, timestamp→receivedAt)', async () => {
  const gateway = routingGateway({
    INSTAGRAM_GET_IG_MEDIA_COMMENTS: {
      successful: true,
      error: null,
      data: {
        data: [
          { id: 'ig_cmt_888', text: 'lovely!', username: 'jane_doe', timestamp: '2026-06-11T09:00:00+0000' },
          { id: 'ig_cmt_889', text: 'where to buy?', username: 'john_roe', timestamp: '2026-06-11T10:00:00+0000' },
        ],
      },
    },
  });
  const adapter = new InstagramInsightsAdapter(gateway, fakeConfig({ actions: {} }), ctx);

  const comments = await adapter.fetchComments(IG_POST_ID, 50);
  const call = gateway.calls[0];
  assert.equal(call.slug, 'INSTAGRAM_GET_IG_MEDIA_COMMENTS');
  assert.equal(call.arguments?.ig_media_id, IG_POST_ID);
  assert.equal(call.arguments?.limit, 50);
  assert.match(String(call.arguments?.fields), /username/);
  assert.match(String(call.arguments?.fields), /text/);

  assert.equal(comments.length, 2);
  assert.equal(comments[0].externalCommentId, 'ig_cmt_888');
  assert.equal(comments[0].authorHandle, 'jane_doe');   // username → authorHandle
  assert.equal(comments[0].bodyText, 'lovely!');         // text → bodyText
  assert.ok(comments[0].receivedAt instanceof Date, 'receivedAt is a Date');
  assert.equal(comments[1].externalCommentId, 'ig_cmt_889');
  assert.equal(comments[1].authorHandle, 'john_roe');
});

// ── Slug overrides, error paths, auth guard ───────────────────────────────────

test('an env override replaces the default action slug', async () => {
  const gateway = routingGateway({
    CUSTOM_IG_LIST_POSTS: { successful: true, error: null, data: { data: [] } },
  });
  const adapter = new InstagramInsightsAdapter(
    gateway,
    fakeConfig({ actions: { list_posts: 'CUSTOM_IG_LIST_POSTS' } }),
    ctx,
  );
  await adapter.fetchPostList(IG_USER_ID);
  assert.equal(gateway.calls[0].slug, 'CUSTOM_IG_LIST_POSTS');
});

test('an unsuccessful tool call throws (so the sync run is marked failed, partial rows preserved)', async () => {
  const gateway = routingGateway({
    INSTAGRAM_GET_IG_MEDIA_COMMENTS: { successful: false, error: 'instagram api error (code 10)', data: null },
  });
  const adapter = new InstagramInsightsAdapter(gateway, fakeConfig({ actions: {} }), ctx);
  await assert.rejects(() => adapter.fetchComments(IG_POST_ID), /instagram api error/);
});

test('a missing connectedAccountId is a clear error, never a silent unauthenticated call', async () => {
  const gateway = routingGateway({});
  // No connectedAccountId in context
  const adapter = new InstagramInsightsAdapter(gateway, fakeConfig({ actions: {} }), {});
  await assert.rejects(() => adapter.fetchPostList(IG_USER_ID), /connectedAccountId/);
  assert.equal(gateway.calls.length, 0, 'no tool call without a connected account');
});
