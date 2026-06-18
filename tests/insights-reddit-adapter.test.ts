/**
 * tests/insights-reddit-adapter.test.ts
 *
 * Regression coverage for the Reddit insights adapter (#642 analytics,
 * #643 comments).  All tests are self-contained — fake gateway / fake DB /
 * no real Postgres, no network calls.
 *
 * Mirror pattern: tests/insights-x-adapter.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RedditInsightsAdapter } from '@/backend/insights/adapters/reddit/index';
import {
  hasAdapter,
  getAdapter,
  isRedditInsightsEnabled,
} from '@/backend/insights/sync/adapter-factory';
import type {
  ComposioGateway,
  GatewayToolResult,
} from '@/backend/integrations/composio/composio-client';
import type { Queryable } from '@/backend/integrations/composio/connection-store';
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
      return results[slug] ?? { data: { data: [] }, successful: true, error: null };
    },
    async uploadFile(input) {
      return { name: 'staged', mimetype: 'application/octet-stream', s3key: `s3/${input.toolSlug}` };
    },
  };
}

interface RedditPostRow {
  platform_post_id: string;
  published_at: Date | null;
  caption: string | null;
}

interface RecordedDbQuery {
  text: string;
  params: unknown[];
}

/**
 * Fake Queryable whose SELECT on the `posts` table returns the supplied rows.
 * All other statements return empty (no real Postgres needed).
 */
function fakePostsDb(
  rows: RedditPostRow[],
): Queryable & { queries: RecordedDbQuery[] } {
  const queries: RecordedDbQuery[] = [];
  return {
    queries,
    async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
      queries.push({ text, params });
      if (/^\s*select/i.test(text) && /FROM\s+posts/i.test(text)) {
        return { rows: rows as unknown as T[], rowCount: rows.length };
      }
      return { rows: [] as T[], rowCount: 0 };
    },
  };
}

/** Standard adapter context shared across non-dormancy tests. */
const ctx = { connectedAccountId: 'ca_reddit_1', tenantId: 42 };

// ── fetchPostList ─────────────────────────────────────────────────────────────

test('fetchPostList: queries tenant Reddit posts from DB, issues ZERO Composio gateway calls, returns correct RawPost shape', async () => {
  const db = fakePostsDb([
    { platform_post_id: 't3_abc123', published_at: new Date('2026-06-10'), caption: 'My Reddit Post' },
    { platform_post_id: 't3_xyz789', published_at: new Date('2026-06-11'), caption: null },
  ]);
  const gateway = routingGateway({});
  const adapter = new RedditInsightsAdapter(gateway, fakeConfig({ actions: {} }), db, ctx);

  const posts = await adapter.fetchPostList('reddit_user');

  // Reddit has no Composio list-posts action — zero gateway calls.
  assert.equal(gateway.calls.length, 0, 'fetchPostList must issue ZERO Composio gateway calls (DB-only)');

  // DB SELECT must be tenant-scoped and platform-filtered.
  const dbQuery = db.queries[0];
  assert.ok(dbQuery, 'a DB query must have been issued');
  assert.match(dbQuery.text, /FROM\s+posts/i);
  assert.match(dbQuery.text, /platform\s*=\s*'reddit'/i, "SELECT must filter platform='reddit'");
  assert.match(dbQuery.text, /published_status\s*=\s*'published'/i, "SELECT must filter published_status='published'");
  assert.deepEqual(dbQuery.params, [42], 'tenant_id=$1 must be the only query parameter');

  assert.equal(posts.length, 2);

  // externalPostId keeps the full t3_ fullname — only the Composio `article` arg is stripped.
  assert.equal(posts[0].externalPostId, 't3_abc123', 'externalPostId preserves the full t3_ fullname');
  assert.equal(posts[0].caption, 'My Reddit Post');
  assert.equal(posts[0].mediaType, 'image', 'Reddit posts normalised to image mediaType');
  // Permalink uses the STRIPPED (bare base36) id, not the t3_ fullname.
  assert.match(String(posts[0].permalink), /reddit\.com\/comments\/abc123/, 'permalink must use bare base36 id (t3_ stripped)');
  assert.equal(posts[0].title, null);
  assert.equal(posts[0].thumbnailUrl, null);
  assert.equal(posts[0].durationSeconds, null);

  assert.equal(posts[1].externalPostId, 't3_xyz789');
  assert.equal(posts[1].caption, null);
  assert.match(String(posts[1].permalink), /reddit\.com\/comments\/xyz789/);
});

test('fetchPostList: returns [] when no published Reddit posts exist for the tenant', async () => {
  const db = fakePostsDb([]);
  const gateway = routingGateway({});
  const adapter = new RedditInsightsAdapter(gateway, fakeConfig({ actions: {} }), db, ctx);

  const posts = await adapter.fetchPostList('reddit_user');

  assert.deepEqual(posts, []);
  assert.equal(gateway.calls.length, 0, 'still no Composio calls for an empty post list');
});

// ── fetchPostMetrics (analytics #642) ─────────────────────────────────────────

test('fetchPostMetrics: issues REDDIT_RETRIEVE_REDDIT_POST with article stripped of t3_, maps score→likes/num_comments→commentsCount; views=0 placeholder; rawSource documents no-impressions', async () => {
  const db = fakePostsDb([]);
  const gateway = routingGateway({
    REDDIT_RETRIEVE_REDDIT_POST: {
      successful: true,
      error: null,
      data: { score: 128, num_comments: 14, upvote_ratio: 0.92 },
    },
  });
  const adapter = new RedditInsightsAdapter(gateway, fakeConfig({ actions: {} }), db, ctx);

  const metrics = await adapter.fetchPostMetrics('t3_abc123');

  // One Composio call issued.
  assert.equal(gateway.calls.length, 1, 'exactly one Composio call for fetchPostMetrics');
  const call = gateway.calls[0];
  assert.equal(call.slug, 'REDDIT_RETRIEVE_REDDIT_POST');
  assert.equal(call.connectedAccountId, 'ca_reddit_1');
  // The t3_ prefix must be stripped before the call.
  assert.equal(call.arguments?.article, 'abc123', 'article must be the bare base36 id (t3_ stripped)');

  assert.equal(metrics.length, 1);

  // score→likes (positive).
  assert.equal(metrics[0].likes, 128);
  // num_comments→commentsCount.
  assert.equal(metrics[0].commentsCount, 14);
  // shares is always 0 — Reddit exposes no share count.
  assert.equal(metrics[0].shares, 0);
  // views=0 is the FB `views ?? 0` placeholder — NOT a fetched value.
  assert.equal(metrics[0].views, 0, 'views must be the 0 placeholder (Reddit has no impressions metric)');

  // rawSource documents the no-impressions limitation.
  assert.equal(
    metrics[0].rawSource.views_available,
    false,
    'rawSource.views_available must be false — Reddit has no impressions metric',
  );
  assert.ok(
    metrics[0].rawSource.views_unavailable_reason !== null &&
      metrics[0].rawSource.views_unavailable_reason !== undefined,
    'rawSource.views_unavailable_reason must be populated',
  );
  assert.equal(metrics[0].rawSource.views_unavailable_reason, 'reddit_no_impressions_metric');

  // rawSource preserves the raw signal values for provenance.
  assert.equal(metrics[0].rawSource.score, 128);
  assert.equal(metrics[0].rawSource.num_comments, 14);
  assert.equal(metrics[0].rawSource.upvote_ratio, 0.92);
});

test('fetchPostMetrics: NEGATIVE score is passed through un-clamped (honest downvoted-post mapping)', async () => {
  const db = fakePostsDb([]);
  const gateway = routingGateway({
    REDDIT_RETRIEVE_REDDIT_POST: {
      successful: true,
      error: null,
      data: { score: -15, num_comments: 3, upvote_ratio: 0.2 },
    },
  });
  const adapter = new RedditInsightsAdapter(gateway, fakeConfig({ actions: {} }), db, ctx);

  const metrics = await adapter.fetchPostMetrics('t3_neg1');

  assert.equal(metrics.length, 1, 'a row is emitted even for a net-negative post');
  // Must NOT clamp to 0 — score CAN be negative (net downvotes); map it honestly.
  assert.equal(metrics[0].likes, -15, 'negative score must be mapped to likes without clamping');
  assert.equal(metrics[0].commentsCount, 3);
  assert.equal(metrics[0].rawSource.score, -15);
});

test('fetchPostMetrics: no usable data in response → empty array (never fabricate a zero row)', async () => {
  const db = fakePostsDb([]);
  const gateway = routingGateway({
    REDDIT_RETRIEVE_REDDIT_POST: {
      successful: true,
      error: null,
      // No score / num_comments / upvote_ratio — all null after num().
      data: { title: 'some post', url: 'https://reddit.com/r/test' },
    },
  });
  const adapter = new RedditInsightsAdapter(gateway, fakeConfig({ actions: {} }), db, ctx);

  const metrics = await adapter.fetchPostMetrics('t3_nodata');

  assert.deepEqual(metrics, [], 'no usable signal → empty array, never a fabricated zero row');
});

test('fetchPostMetrics: strips t3_ even when the stored id has no prefix (bare id is a no-op)', async () => {
  const db = fakePostsDb([]);
  const gateway = routingGateway({
    REDDIT_RETRIEVE_REDDIT_POST: {
      successful: true,
      error: null,
      data: { score: 5, num_comments: 1, upvote_ratio: 0.8 },
    },
  });
  const adapter = new RedditInsightsAdapter(gateway, fakeConfig({ actions: {} }), db, ctx);

  await adapter.fetchPostMetrics('bare123'); // no t3_ prefix

  // stripFullname on an already-bare id is a no-op.
  assert.equal(gateway.calls[0].arguments?.article, 'bare123', 'bare id passes through unchanged');
});

// ── fetchComments (comments #643) ─────────────────────────────────────────────

test('fetchComments: issues REDDIT_RETRIEVE_POST_COMMENTS with article stripped, maps name/author/body/created_utc (epoch seconds→Date); skips kind:more', async () => {
  const db = fakePostsDb([]);
  // Reddit native response: [postListing, commentsListing].
  // The comments listing carries t1 comment children + a 'more' stub.
  const gateway = routingGateway({
    REDDIT_RETRIEVE_POST_COMMENTS: {
      successful: true,
      error: null,
      data: [
        // First element: post listing (ignored by unwrapToCommentChildren).
        { kind: 'Listing', data: { children: [] } },
        // Second element: comments listing — the adapter takes the LAST element.
        {
          kind: 'Listing',
          data: {
            children: [
              {
                kind: 't1',
                data: {
                  name: 't1_comment1',
                  author: 'redditor_jane',
                  body: 'Great post!',
                  created_utc: 1700000000, // epoch SECONDS — Nov 14/15 2023
                },
              },
              {
                kind: 't1',
                data: {
                  name: 't1_comment2',
                  author: 'redditor_bob',
                  body: 'Agreed, very useful.',
                  created_utc: 1700100000,
                },
              },
              // kind:'more' synthetic stub — must be skipped.
              {
                kind: 'more',
                data: {
                  id: '_',
                  name: 'more_stub_abc',
                  children: [],
                },
              },
            ],
          },
        },
      ],
    },
  });
  const adapter = new RedditInsightsAdapter(gateway, fakeConfig({ actions: {} }), db, ctx);

  const comments = await adapter.fetchComments('t3_abc123', 100);

  // One Composio call.
  assert.equal(gateway.calls.length, 1, 'exactly one Composio call for fetchComments');
  const call = gateway.calls[0];
  assert.equal(call.slug, 'REDDIT_RETRIEVE_POST_COMMENTS');
  assert.equal(call.connectedAccountId, 'ca_reddit_1');
  // t3_ prefix must be stripped from the article argument.
  assert.equal(call.arguments?.article, 'abc123', 'article must be the bare base36 id (t3_ stripped)');

  // kind:'more' is excluded; only 2 real comments returned.
  assert.equal(comments.length, 2, 'kind:more stub must be skipped; only 2 real comments returned');

  assert.equal(comments[0].externalCommentId, 't1_comment1', 'externalCommentId comes from the name fullname (t1_)');
  assert.equal(comments[0].authorHandle, 'redditor_jane');
  assert.equal(comments[0].bodyText, 'Great post!');

  // created_utc=1700000000 epoch SECONDS → Date (NOT milliseconds).
  assert.ok(comments[0].receivedAt instanceof Date, 'receivedAt must be a Date');
  // 1700000000s = 2023-11-14T22:13:20.000Z → year 2023, month November (index 10).
  assert.equal(comments[0].receivedAt.getFullYear(), 2023, 'epoch seconds correctly converted (not ms)');
  assert.equal(comments[0].receivedAt.getMonth(), 10, 'month is November (index 10)');
  assert.equal(comments[0].receivedAt.getDate(), 14, 'day is 14 for epoch 1700000000');

  assert.equal(comments[1].externalCommentId, 't1_comment2');
  assert.equal(comments[1].authorHandle, 'redditor_bob');
  assert.equal(comments[1].bodyText, 'Agreed, very useful.');
  assert.ok(comments[1].receivedAt instanceof Date);
});

test('fetchComments: respects the limit parameter and returns at most limit comments', async () => {
  const db = fakePostsDb([]);
  // Supply 5 comments; limit to 3.
  const children = Array.from({ length: 5 }, (_, i) => ({
    kind: 't1',
    data: {
      name: `t1_cmt${i}`,
      author: `user${i}`,
      body: `Comment ${i}`,
      created_utc: 1700000000 + i * 100,
    },
  }));
  const gateway = routingGateway({
    REDDIT_RETRIEVE_POST_COMMENTS: {
      successful: true,
      error: null,
      data: [
        { kind: 'Listing', data: { children: [] } },
        { kind: 'Listing', data: { children } },
      ],
    },
  });
  const adapter = new RedditInsightsAdapter(gateway, fakeConfig({ actions: {} }), db, ctx);

  const comments = await adapter.fetchComments('t3_limitme', 3);

  assert.equal(comments.length, 3, 'fetchComments must honour the limit parameter');
});

test('fetchComments: falls back to comment.id when name is absent', async () => {
  const db = fakePostsDb([]);
  const gateway = routingGateway({
    REDDIT_RETRIEVE_POST_COMMENTS: {
      successful: true,
      error: null,
      data: [
        { kind: 'Listing', data: { children: [] } },
        {
          kind: 'Listing',
          data: {
            children: [
              {
                kind: 't1',
                data: {
                  // name is absent — adapter falls back to id.
                  id: 'fallback_id',
                  author: 'anon',
                  body: 'Hello',
                  created_utc: 1700000000,
                },
              },
            ],
          },
        },
      ],
    },
  });
  const adapter = new RedditInsightsAdapter(gateway, fakeConfig({ actions: {} }), db, ctx);

  const comments = await adapter.fetchComments('t3_fallback');

  assert.equal(comments.length, 1);
  assert.equal(comments[0].externalCommentId, 'fallback_id', 'falls back to id when name is absent');
});

// ── fetchAccountMetrics ───────────────────────────────────────────────────────

test('fetchAccountMetrics: always returns [] — Reddit has no verified account-insights action', async () => {
  const gateway = routingGateway({});
  const adapter = new RedditInsightsAdapter(
    gateway,
    fakeConfig({ actions: {} }),
    fakePostsDb([]),
    ctx,
  );

  const result = await adapter.fetchAccountMetrics('reddit_user', { from: '2026-06-01', to: '2026-06-18' });

  assert.deepEqual(result, []);
  assert.equal(gateway.calls.length, 0, 'no gateway calls — never fabricate a Reddit account series');
});

// ── Dormancy / off-switch ─────────────────────────────────────────────────────

const REDDIT_COMPOSIO_ENV = {
  ARIES_REDDIT_ENABLED: '1',
  ANALYTICS_PROVIDER: 'composio',
} as unknown as NodeJS.ProcessEnv;

const FLAG_OFF_ENV = {
  ANALYTICS_PROVIDER: 'composio',
} as unknown as NodeJS.ProcessEnv;

const PROVIDER_OFF_ENV = {
  ARIES_REDDIT_ENABLED: '1',
} as unknown as NodeJS.ProcessEnv;

test('dormancy: isRedditInsightsEnabled requires BOTH ARIES_REDDIT_ENABLED=1 AND ANALYTICS_PROVIDER=composio', () => {
  assert.equal(isRedditInsightsEnabled(REDDIT_COMPOSIO_ENV), true, 'both flags on → enabled');
  assert.equal(isRedditInsightsEnabled(FLAG_OFF_ENV), false, 'ARIES_REDDIT_ENABLED absent → disabled');
  assert.equal(isRedditInsightsEnabled(PROVIDER_OFF_ENV), false, 'ANALYTICS_PROVIDER!=composio → disabled');
  assert.equal(
    isRedditInsightsEnabled({} as unknown as NodeJS.ProcessEnv),
    false,
    'no flags → disabled (default OFF)',
  );
});

test('dormancy: hasAdapter("reddit") mirrors isRedditInsightsEnabled for all flag combinations', () => {
  assert.equal(hasAdapter('reddit', REDDIT_COMPOSIO_ENV), true);
  assert.equal(hasAdapter('reddit', FLAG_OFF_ENV), false);
  assert.equal(hasAdapter('reddit', PROVIDER_OFF_ENV), false);
  assert.equal(hasAdapter('reddit', {} as unknown as NodeJS.ProcessEnv), false);
});

test('dormancy: getAdapter("reddit") throws a diagnostic error mentioning ARIES_REDDIT_ENABLED when disabled', () => {
  const prevReddit = process.env.ARIES_REDDIT_ENABLED;
  const prevProvider = process.env.ANALYTICS_PROVIDER;
  // Ensure both axes are off so the REGISTRY guard fires.
  delete process.env.ARIES_REDDIT_ENABLED;
  process.env.ANALYTICS_PROVIDER = 'direct_meta';
  try {
    assert.throws(
      () => getAdapter('reddit', { connectedAccountId: 'ca_reddit', tenantId: 1 }),
      /ARIES_REDDIT_ENABLED/,
      'error message must mention the flag name so operators know what to set',
    );
  } finally {
    if (prevReddit === undefined) delete process.env.ARIES_REDDIT_ENABLED;
    else process.env.ARIES_REDDIT_ENABLED = prevReddit;
    if (prevProvider === undefined) delete process.env.ANALYTICS_PROVIDER;
    else process.env.ANALYTICS_PROVIDER = prevProvider;
  }
});
