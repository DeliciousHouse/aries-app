/**
 * tests/insights-youtube-adapter.test.ts
 *
 * Regression coverage for the YouTube insights adapter (#637 analytics,
 * #638 comments). All tests are self-contained — fake gateway / no DB / no
 * real Postgres, no network calls.
 *
 * Mirror pattern: tests/insights-x-adapter.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { YouTubeInsightsAdapter } from '@/backend/insights/adapters/youtube/index';
import {
  hasAdapter,
  getAdapter,
  isYouTubeInsightsEnabled,
} from '@/backend/insights/sync/adapter-factory';
import type {
  ComposioGateway,
  GatewayToolResult,
} from '@/backend/integrations/composio/composio-client';
import { fakeConfig } from './composio/helpers';

// ── Test doubles ──────────────────────────────────────────────────────────────

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
      calls.push({
        slug,
        connectedAccountId: options.connectedAccountId,
        arguments: options.arguments,
      });
      // Default: YouTube-shaped empty list (not Graph's .data[] shape).
      return results[slug] ?? { data: { items: [] }, successful: true, error: null };
    },
    async uploadFile(input) {
      return { name: 'staged', mimetype: 'application/octet-stream', s3key: `s3/${input.toolSlug}` };
    },
  };
}

/** Standard adapter context shared across non-dormancy tests. */
const ctx = { connectedAccountId: 'ca_yt_1', tenantId: 42 };

// ── fetchPostList ─────────────────────────────────────────────────────────────

test('fetchPostList: issues YOUTUBE_LIST_CHANNEL_VIDEOS with mine:true, maps items[].snippet.resourceId.videoId → RawPost, then ONE batch call for statistics', async () => {
  const gateway = routingGateway({
    YOUTUBE_LIST_CHANNEL_VIDEOS: {
      successful: true,
      error: null,
      data: {
        items: [
          {
            snippet: {
              resourceId: { videoId: 'vid1' },
              title: 'First Video',
              description: 'A description',
              publishedAt: '2026-06-10T12:00:00Z',
              thumbnails: { high: { url: 'https://img/thumb1.jpg' } },
            },
          },
          {
            snippet: {
              resourceId: { videoId: 'vid2' },
              title: 'Second Video',
              description: 'Another description',
              publishedAt: '2026-06-11T14:00:00Z',
              thumbnails: { high: { url: 'https://img/thumb2.jpg' } },
            },
          },
        ],
      },
    },
    YOUTUBE_GET_VIDEO_DETAILS_BATCH: {
      successful: true,
      error: null,
      data: {
        items: [
          { id: 'vid1', statistics: { viewCount: '1000', likeCount: '50', commentCount: '10' } },
          { id: 'vid2', statistics: { viewCount: '500', likeCount: '20', commentCount: '5' } },
        ],
      },
    },
  });

  const adapter = new YouTubeInsightsAdapter(gateway, fakeConfig({ actions: {} }), ctx);
  const posts = await adapter.fetchPostList('yt_channel_1');

  // 2 calls: list + ONE batch stats — not N per-video fan-out calls.
  assert.equal(gateway.calls.length, 2, 'list call + ONE batch stats call, no per-video fan-out');

  const listCall = gateway.calls[0];
  assert.equal(listCall.slug, 'YOUTUBE_LIST_CHANNEL_VIDEOS');
  assert.equal(listCall.connectedAccountId, 'ca_yt_1');
  assert.equal(listCall.arguments?.mine, true, 'mine:true — authenticated channel listing, no channelId needed');
  assert.equal(listCall.arguments?.part, 'snippet');
  assert.equal(listCall.arguments?.maxResults, 50);

  const batchCall = gateway.calls[1];
  assert.equal(batchCall.slug, 'YOUTUBE_GET_VIDEO_DETAILS_BATCH');
  // id is the full array of video ids from the listing.
  assert.deepEqual(batchCall.arguments?.id, ['vid1', 'vid2'], 'batch call carries all listed video ids');
  assert.deepEqual(batchCall.arguments?.parts, ['statistics']);

  // RawPost field mapping.
  assert.equal(posts.length, 2);
  assert.equal(posts[0].externalPostId, 'vid1');
  assert.equal(posts[0].mediaType, 'video', 'YouTube uploads are videos');
  assert.equal(posts[0].title, 'First Video');
  assert.equal(posts[0].caption, 'A description');
  assert.match(String(posts[0].permalink), /vid1/, 'permalink embeds the video id');
  assert.equal(posts[0].thumbnailUrl, 'https://img/thumb1.jpg');
  assert.equal(posts[1].externalPostId, 'vid2');
});

test('fetchPostList: empty channel → returns [] and issues NO batch stats call', async () => {
  const gateway = routingGateway({
    YOUTUBE_LIST_CHANNEL_VIDEOS: {
      successful: true,
      error: null,
      data: { items: [] },
    },
  });

  const adapter = new YouTubeInsightsAdapter(gateway, fakeConfig({ actions: {} }), ctx);
  const posts = await adapter.fetchPostList('yt_channel_1');

  assert.deepEqual(posts, []);
  // Only the list call — no batch stats call when there are no video ids.
  assert.equal(gateway.calls.length, 1, 'only list call; no batch call for empty channel');
  assert.equal(gateway.calls[0].slug, 'YOUTUBE_LIST_CHANNEL_VIDEOS');
});

// ── fetchPostMetrics ──────────────────────────────────────────────────────────

test('fetchPostMetrics: reads from cache (no extra gateway call), maps viewCount/likeCount/commentCount strings to numbers', async () => {
  const gateway = routingGateway({
    YOUTUBE_LIST_CHANNEL_VIDEOS: {
      successful: true,
      error: null,
      data: {
        items: [
          {
            snippet: {
              resourceId: { videoId: 'vid1' },
              title: 'My Video',
              description: null,
              publishedAt: '2026-06-10T00:00:00Z',
              thumbnails: {},
            },
          },
        ],
      },
    },
    YOUTUBE_GET_VIDEO_DETAILS_BATCH: {
      successful: true,
      error: null,
      data: {
        items: [
          {
            id: 'vid1',
            statistics: {
              viewCount: '12345',
              likeCount: '678',
              commentCount: '90',
            },
          },
        ],
      },
    },
  });

  const adapter = new YouTubeInsightsAdapter(gateway, fakeConfig({ actions: {} }), ctx);

  // Prime the cache (dispatcher always calls fetchPostList before fetchPostMetrics).
  await adapter.fetchPostList('yt_channel_1');
  const callsBefore = gateway.calls.length; // 2 (list + batch)

  const metrics = await adapter.fetchPostMetrics('vid1');

  // No additional gateway call — reads from the engagementCache.
  assert.equal(gateway.calls.length, callsBefore, 'no extra gateway call; metrics read from cache');

  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].views, 12345, 'viewCount string coerced to number');
  assert.equal(metrics[0].likes, 678, 'likeCount string coerced to number');
  assert.equal(metrics[0].commentsCount, 90, 'commentCount string coerced to number');
  assert.equal(metrics[0].shares, 0, 'YouTube has no share count — always 0, not fabricated');

  // rawSource must identify the batch action for provenance.
  assert.equal(metrics[0].rawSource.source, 'YOUTUBE_GET_VIDEO_DETAILS_BATCH');
});

test('fetchPostMetrics: empty cache → returns [] (no fabricated zero row for unknown video)', async () => {
  const adapter = new YouTubeInsightsAdapter(
    routingGateway({}),
    fakeConfig({ actions: {} }),
    ctx,
  );
  // Cache was never populated — simulates a video whose stats were never fetched.
  const metrics = await adapter.fetchPostMetrics('vid_unknown');
  assert.deepEqual(metrics, [], 'no cached stats → empty, never a fabricated zero row');
});

// ── fetchComments ─────────────────────────────────────────────────────────────

test('fetchComments: issues YOUTUBE_LIST_COMMENT_THREADS2 keyed on videoId, maps topLevelComment id/authorDisplayName/textOriginal/publishedAt → RawComment', async () => {
  const gateway = routingGateway({
    YOUTUBE_LIST_COMMENT_THREADS2: {
      successful: true,
      error: null,
      data: {
        items: [
          {
            snippet: {
              topLevelComment: {
                id: 'comment1',
                snippet: {
                  authorDisplayName: 'Jane Doe',
                  textOriginal: 'Great video!',
                  publishedAt: '2026-06-11T08:00:00Z',
                },
              },
            },
          },
          {
            snippet: {
              topLevelComment: {
                id: 'comment2',
                snippet: {
                  authorDisplayName: 'John Smith',
                  textOriginal: 'Very informative.',
                  publishedAt: '2026-06-11T09:00:00Z',
                },
              },
            },
          },
        ],
      },
    },
  });

  const adapter = new YouTubeInsightsAdapter(gateway, fakeConfig({ actions: {} }), ctx);
  const comments = await adapter.fetchComments('vid1', 50);

  const commentCall = gateway.calls[0];
  assert.equal(commentCall.slug, 'YOUTUBE_LIST_COMMENT_THREADS2');
  assert.equal(commentCall.connectedAccountId, 'ca_yt_1');
  assert.equal(commentCall.arguments?.videoId, 'vid1', 'call is keyed on the video id');
  assert.equal(commentCall.arguments?.maxResults, 50);

  assert.equal(comments.length, 2);
  assert.equal(comments[0].externalCommentId, 'comment1');
  assert.equal(comments[0].authorHandle, 'Jane Doe', 'authorHandle from authorDisplayName');
  assert.equal(comments[0].bodyText, 'Great video!', 'bodyText from textOriginal');
  assert.ok(comments[0].receivedAt instanceof Date, 'receivedAt is a Date');
  assert.equal(comments[0].receivedAt.getFullYear(), 2026);

  assert.equal(comments[1].externalCommentId, 'comment2');
  assert.equal(comments[1].authorHandle, 'John Smith');
  assert.equal(comments[1].bodyText, 'Very informative.');
});

test('fetchComments: falls back to textDisplay when textOriginal is absent', async () => {
  const gateway = routingGateway({
    YOUTUBE_LIST_COMMENT_THREADS2: {
      successful: true,
      error: null,
      data: {
        items: [
          {
            snippet: {
              topLevelComment: {
                id: 'comment_display',
                snippet: {
                  authorDisplayName: 'Anonymous',
                  // textOriginal absent — should fall back to textDisplay.
                  textDisplay: 'Hello from display text',
                  publishedAt: '2026-06-12T00:00:00Z',
                },
              },
            },
          },
        ],
      },
    },
  });

  const adapter = new YouTubeInsightsAdapter(gateway, fakeConfig({ actions: {} }), ctx);
  const comments = await adapter.fetchComments('vid1');

  assert.equal(comments.length, 1);
  assert.equal(comments[0].bodyText, 'Hello from display text', 'textDisplay fallback when textOriginal is absent');
});

// ── fetchAccountMetrics ───────────────────────────────────────────────────────

test('fetchAccountMetrics: always returns [] — no verified per-day YouTube channel series', async () => {
  const gateway = routingGateway({});
  const adapter = new YouTubeInsightsAdapter(gateway, fakeConfig({ actions: {} }), ctx);

  const result = await adapter.fetchAccountMetrics('yt_channel_1', { from: '2026-06-01', to: '2026-06-18' });

  assert.deepEqual(result, []);
  assert.equal(gateway.calls.length, 0, 'no gateway calls — never fabricate an account series');
});

// ── .items unwrap (YouTube nesting vs Graph .data[]) ─────────────────────────

test('.items unwrap: adapter reads row array from {data:{items:[...]}} (YouTube double-envelope nesting), not .data[]', async () => {
  // Composio wraps the YouTube response in { data: <toolPayload> }.
  // YouTube's toolPayload is itself { items: [...] }.
  // Together the executeTool result.data is { data: { items: [...] } }
  // so exec() receives { data: { items: [...] } } and unwrapToItems must peel
  // the inner .data layer before reading .items.
  // If the adapter mistakenly used Graph's .data[] it would return 0 posts.
  const gateway = routingGateway({
    YOUTUBE_LIST_CHANNEL_VIDEOS: {
      successful: true,
      error: null,
      data: {
        // Inner data layer (Composio envelope) wrapping YouTube's items payload.
        data: {
          items: [
            {
              snippet: {
                resourceId: { videoId: 'vid_double_wrapped' },
                title: 'Double-Wrapped Video',
                description: 'desc',
                publishedAt: '2026-06-10T00:00:00Z',
                thumbnails: {},
              },
            },
          ],
        },
      },
    },
    YOUTUBE_GET_VIDEO_DETAILS_BATCH: {
      successful: true,
      error: null,
      data: {
        data: {
          items: [
            { id: 'vid_double_wrapped', statistics: { viewCount: '100', likeCount: '10', commentCount: '1' } },
          ],
        },
      },
    },
  });

  const adapter = new YouTubeInsightsAdapter(gateway, fakeConfig({ actions: {} }), ctx);
  const posts = await adapter.fetchPostList('yt_channel_1');

  // The adapter must correctly unwrap through the double envelope to .items.
  assert.equal(posts.length, 1, 'reads one video from double-envelope {data:{items:[...]}} nesting');
  assert.equal(posts[0].externalPostId, 'vid_double_wrapped');

  // Cache was also populated from the double-envelope batch response.
  const metrics = await adapter.fetchPostMetrics('vid_double_wrapped');
  assert.equal(metrics.length, 1, 'batch stats double-envelope also unwrapped correctly');
  assert.equal(metrics[0].views, 100);
});

// ── Dormancy / off-switch ─────────────────────────────────────────────────────

const YT_COMPOSIO_ENV = {
  ARIES_YOUTUBE_ENABLED: '1',
  ANALYTICS_PROVIDER: 'composio',
} as unknown as NodeJS.ProcessEnv;

const FLAG_OFF_ENV = {
  ANALYTICS_PROVIDER: 'composio',
} as unknown as NodeJS.ProcessEnv;

const PROVIDER_OFF_ENV = {
  ARIES_YOUTUBE_ENABLED: '1',
} as unknown as NodeJS.ProcessEnv;

test('dormancy: isYouTubeInsightsEnabled requires BOTH ARIES_YOUTUBE_ENABLED=1 AND ANALYTICS_PROVIDER=composio', () => {
  assert.equal(isYouTubeInsightsEnabled(YT_COMPOSIO_ENV), true, 'both flags on → enabled');
  assert.equal(isYouTubeInsightsEnabled(FLAG_OFF_ENV), false, 'ARIES_YOUTUBE_ENABLED absent → disabled');
  assert.equal(isYouTubeInsightsEnabled(PROVIDER_OFF_ENV), false, 'ANALYTICS_PROVIDER!=composio → disabled');
  assert.equal(
    isYouTubeInsightsEnabled({} as unknown as NodeJS.ProcessEnv),
    false,
    'no flags → disabled (default OFF)',
  );
});

test('dormancy: hasAdapter("youtube") mirrors isYouTubeInsightsEnabled for all flag combinations', () => {
  assert.equal(hasAdapter('youtube', YT_COMPOSIO_ENV), true);
  assert.equal(hasAdapter('youtube', FLAG_OFF_ENV), false);
  assert.equal(hasAdapter('youtube', PROVIDER_OFF_ENV), false);
  assert.equal(hasAdapter('youtube', {} as unknown as NodeJS.ProcessEnv), false);
});

test('dormancy: getAdapter("youtube") throws a diagnostic error mentioning ARIES_YOUTUBE_ENABLED when disabled', () => {
  const prevYt = process.env.ARIES_YOUTUBE_ENABLED;
  const prevProvider = process.env.ANALYTICS_PROVIDER;
  // Ensure both axes are off so the REGISTRY guard fires.
  delete process.env.ARIES_YOUTUBE_ENABLED;
  process.env.ANALYTICS_PROVIDER = 'direct_meta';
  try {
    assert.throws(
      () => getAdapter('youtube', { connectedAccountId: 'ca_yt', tenantId: 1 }),
      /ARIES_YOUTUBE_ENABLED/,
      'error message must mention the flag name so operators know what to set',
    );
  } finally {
    if (prevYt === undefined) delete process.env.ARIES_YOUTUBE_ENABLED;
    else process.env.ARIES_YOUTUBE_ENABLED = prevYt;
    if (prevProvider === undefined) delete process.env.ANALYTICS_PROVIDER;
    else process.env.ANALYTICS_PROVIDER = prevProvider;
  }
});
