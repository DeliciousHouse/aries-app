import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FacebookInsightsAdapter } from '@/backend/insights/adapters/facebook/index';
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
  };
}

const ctx = { connectedAccountId: 'ca_fb_1', pageId: 'PAGE123' };

test('fetchPostList: builds GET_PAGE_POSTS, stores full pageId_postId, captures engagement summary', async () => {
  const gateway = routingGateway({
    FACEBOOK_GET_PAGE_POSTS: {
      successful: true,
      error: null,
      data: {
        data: [
          {
            id: 'PAGE123_777',
            message: 'Hello world',
            created_time: '2026-06-10T12:00:00+0000',
            permalink_url: 'https://facebook.com/PAGE123_777',
            full_picture: 'https://img/x.jpg',
            status_type: 'added_photos',
            attachments: { data: [{ media_type: 'photo', type: 'photo' }] },
            reactions: { summary: { total_count: 42 } },
            comments: { summary: { total_count: 7 } },
            shares: { count: 3 },
          },
        ],
      },
    },
  });
  const adapter = new FacebookInsightsAdapter(gateway, fakeConfig({ actions: {} }), ctx);

  const posts = await adapter.fetchPostList('PAGE123');
  assert.equal(gateway.calls[0].slug, 'FACEBOOK_GET_PAGE_POSTS');
  assert.equal(gateway.calls[0].connectedAccountId, 'ca_fb_1');
  assert.equal(gateway.calls[0].arguments?.page_id, 'PAGE123');
  assert.match(String(gateway.calls[0].arguments?.fields), /reactions\.summary\(true\)/);
  assert.match(String(gateway.calls[0].arguments?.fields), /comments\.summary\(true\)/);

  assert.equal(posts.length, 1);
  assert.equal(posts[0].externalPostId, 'PAGE123_777'); // full graph id
  assert.equal(posts[0].mediaType, 'image');
  assert.equal(posts[0].caption, 'Hello world');
  assert.equal(posts[0].permalink, 'https://facebook.com/PAGE123_777');
  assert.equal(posts[0].thumbnailUrl, 'https://img/x.jpg');
});

test('fetchPostMetrics: deprecated path — views from POST_INSIGHTS, engagement from cached post-list summary', async () => {
  const gateway = routingGateway({
    FACEBOOK_GET_PAGE_POSTS: {
      successful: true,
      error: null,
      data: {
        data: [
          {
            id: 'PAGE123_777',
            created_time: '2026-06-10T12:00:00+0000',
            reactions: { summary: { total_count: 42 } },
            comments: { summary: { total_count: 7 } },
            shares: { count: 3 },
          },
        ],
      },
    },
    FACEBOOK_GET_POST_INSIGHTS: {
      successful: true,
      error: null,
      // Post-2025-11-15: only post_media_view survives.
      data: { data: [{ name: 'post_media_view', values: [{ value: 555 }] }] },
    },
  });
  const adapter = new FacebookInsightsAdapter(gateway, fakeConfig({ actions: {} }), ctx);

  // Prime the engagement cache via the list call (the dispatcher always runs
  // fetchPostList before fetchPostMetrics on the same adapter instance).
  await adapter.fetchPostList('PAGE123');
  const metrics = await adapter.fetchPostMetrics('PAGE123_777');

  const insightsCall = gateway.calls.find((c) => c.slug === 'FACEBOOK_GET_POST_INSIGHTS');
  assert.ok(insightsCall, 'calls FACEBOOK_GET_POST_INSIGHTS');
  assert.equal(insightsCall?.arguments?.post_id, 'PAGE123_777');
  assert.equal(insightsCall?.connectedAccountId, 'ca_fb_1');

  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].views, 555); // from POST_INSIGHTS
  assert.equal(metrics[0].likes, 42); // from cached post-list summary
  assert.equal(metrics[0].commentsCount, 7);
  assert.equal(metrics[0].shares, 3);
});

test('fetchPostMetrics: a post with no insights and no cached engagement yields no fabricated row', async () => {
  const gateway = routingGateway({
    FACEBOOK_GET_POST_INSIGHTS: { successful: true, error: null, data: { data: [] } },
  });
  const adapter = new FacebookInsightsAdapter(gateway, fakeConfig({ actions: {} }), ctx);
  const metrics = await adapter.fetchPostMetrics('PAGE123_999');
  assert.deepEqual(metrics, [], 'no data → empty, never a zero row');
});

test('fetchAccountMetrics: pivots PAGE_INSIGHTS per day + folds in PAGE_DETAILS followers', async () => {
  const gateway = routingGateway({
    FACEBOOK_GET_PAGE_INSIGHTS: {
      successful: true,
      error: null,
      data: {
        data: [
          { name: 'page_media_view', values: [{ value: 100, end_time: '2026-06-09T07:00:00+0000' }, { value: 120, end_time: '2026-06-10T07:00:00+0000' }] },
          { name: 'page_follows', values: [{ value: 900, end_time: '2026-06-09T07:00:00+0000' }] },
        ],
      },
    },
    FACEBOOK_GET_PAGE_DETAILS: {
      successful: true,
      error: null,
      data: { data: { followers_count: 1234, fan_count: 1000 } },
    },
  });
  const adapter = new FacebookInsightsAdapter(gateway, fakeConfig({ actions: {} }), ctx);

  const days = await adapter.fetchAccountMetrics('PAGE123', { from: '2026-06-09', to: '2026-06-10' });

  const insightsCall = gateway.calls.find((c) => c.slug === 'FACEBOOK_GET_PAGE_INSIGHTS');
  assert.equal(insightsCall?.arguments?.page_id, 'PAGE123');
  assert.equal(insightsCall?.arguments?.since, '2026-06-09');
  assert.equal(insightsCall?.arguments?.until, '2026-06-10');

  const detailsCall = gateway.calls.find((c) => c.slug === 'FACEBOOK_GET_PAGE_DETAILS');
  assert.ok(detailsCall, 'fetches followers via PAGE_DETAILS');

  const d9 = days.find((d) => d.date === '2026-06-09');
  const d10 = days.find((d) => d.date === '2026-06-10');
  assert.equal(d9?.views, 100);
  assert.equal(d9?.followers, 900); // from page_follows series
  assert.equal(d10?.views, 120);
  assert.equal(d10?.followers, 1234); // PAGE_DETAILS stamped on the most recent day
});

test('fetchComments: maps GET_COMMENTS rows, stores full graph comment id for the reply endpoint', async () => {
  const gateway = routingGateway({
    FACEBOOK_GET_COMMENTS: {
      successful: true,
      error: null,
      data: {
        data: [
          { id: 'PAGE123_777_888', message: 'nice!', created_time: '2026-06-11T09:00:00+0000', from: { id: 'u1', name: 'Jane Doe' } },
          { id: 'PAGE123_777_889', message: 'where to buy?', created_time: '2026-06-11T10:00:00+0000', from: { id: 'u2', name: 'John Roe' } },
        ],
      },
    },
  });
  const adapter = new FacebookInsightsAdapter(gateway, fakeConfig({ actions: {} }), ctx);

  const comments = await adapter.fetchComments('PAGE123_777', 50);
  const call = gateway.calls[0];
  assert.equal(call.slug, 'FACEBOOK_GET_COMMENTS');
  assert.equal(call.arguments?.object_id, 'PAGE123_777'); // full pageId_postId
  assert.equal(call.arguments?.limit, 50);

  assert.equal(comments.length, 2);
  assert.equal(comments[0].externalCommentId, 'PAGE123_777_888'); // full graph id
  assert.equal(comments[0].authorHandle, 'Jane Doe');
  assert.equal(comments[0].bodyText, 'nice!');
});

test('an env override replaces the default action slug', async () => {
  const gateway = routingGateway({
    CUSTOM_LIST_POSTS: { successful: true, error: null, data: { data: [] } },
  });
  const adapter = new FacebookInsightsAdapter(
    gateway,
    fakeConfig({ actions: { list_posts: 'CUSTOM_LIST_POSTS' } }),
    ctx,
  );
  await adapter.fetchPostList('PAGE123');
  assert.equal(gateway.calls[0].slug, 'CUSTOM_LIST_POSTS');
});

test('an unsuccessful tool call throws (so the sync run is marked failed, partial rows preserved)', async () => {
  const gateway = routingGateway({
    FACEBOOK_GET_COMMENTS: { successful: false, error: 'rate limited (code 4)', data: null },
  });
  const adapter = new FacebookInsightsAdapter(gateway, fakeConfig({ actions: {} }), ctx);
  await assert.rejects(() => adapter.fetchComments('PAGE123_777'), /rate limited/);
});

test('a missing connectedAccountId is a clear error, never a silent unauthenticated call', async () => {
  const gateway = routingGateway({});
  const adapter = new FacebookInsightsAdapter(gateway, fakeConfig({ actions: {} }), { pageId: 'PAGE123' });
  await assert.rejects(() => adapter.fetchPostList('PAGE123'), /connectedAccountId/);
  assert.equal(gateway.calls.length, 0, 'no tool call without a connected account');
});
