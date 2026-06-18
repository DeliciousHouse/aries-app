/**
 * tests/insights-x-adapter.test.ts
 *
 * Regression coverage for the X (Twitter) insights adapter (#632 analytics,
 * #633 comment replies).  All tests are self-contained — fake gateway / fake
 * DB / no real Postgres, no network calls.
 *
 * Mirror pattern: tests/insights-facebook-adapter.test.ts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { XInsightsAdapter } from '@/backend/insights/adapters/x/index';
import {
  hasAdapter,
  getAdapter,
  isXInsightsEnabled,
  isComposioOnlyAnalyticsPlatform,
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

interface XPostRow {
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
  rows: XPostRow[],
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
const ctx = { connectedAccountId: 'ca_x_1', pageId: 'xuser123', tenantId: 42 };

// ── fetchPostList ─────────────────────────────────────────────────────────────

test('fetchPostList: queries tenant X posts from DB and issues ONE TWITTER_POST_LOOKUP_BY_POST_IDS batch call with tweet_fields', async () => {
  const db = fakePostsDb([
    { platform_post_id: 'tweet1', published_at: new Date('2026-06-10'), caption: 'Hello X' },
    { platform_post_id: 'tweet2', published_at: new Date('2026-06-11'), caption: 'Follow-up' },
  ]);
  const gateway = routingGateway({
    TWITTER_POST_LOOKUP_BY_POST_IDS: {
      successful: true,
      error: null,
      data: {
        data: [
          {
            id: 'tweet1',
            public_metrics: { like_count: 5, reply_count: 2, retweet_count: 1, impression_count: 100 },
            conversation_id: 'tweet1',
          },
          {
            id: 'tweet2',
            public_metrics: { like_count: 8, reply_count: 0, retweet_count: 3, impression_count: 150 },
            conversation_id: 'tweet2',
          },
        ],
      },
    },
  });
  const adapter = new XInsightsAdapter(gateway, fakeConfig({ actions: {} }), db, ctx);

  const posts = await adapter.fetchPostList('xuser123');

  // Only ONE batch call — not N per-post fan-out calls.
  assert.equal(gateway.calls.length, 1, 'exactly one batch call');
  const call = gateway.calls[0];
  assert.equal(call.slug, 'TWITTER_POST_LOOKUP_BY_POST_IDS');
  assert.equal(call.connectedAccountId, 'ca_x_1');
  // tweet_fields must include both public_metrics and conversation_id.
  assert.match(String(call.arguments?.tweet_fields), /public_metrics/);
  assert.match(String(call.arguments?.tweet_fields), /conversation_id/);
  // ids is a comma-joined list containing both post ids.
  const ids = String(call.arguments?.ids);
  assert.ok(ids.includes('tweet1') && ids.includes('tweet2'), 'both post ids in batch call');

  // DB SELECT must be tenant-scoped and platform-filtered.
  const dbQuery = db.queries[0];
  assert.match(dbQuery.text, /FROM\s+posts/i);
  assert.match(dbQuery.text, /platform\s*=\s*'x'/i);
  assert.match(dbQuery.text, /published_status\s*=\s*'published'/i);
  assert.deepEqual(dbQuery.params, [42]); // tenant_id=$1

  assert.equal(posts.length, 2);
  assert.equal(posts[0].externalPostId, 'tweet1');
  assert.equal(posts[0].caption, 'Hello X');
  assert.equal(posts[0].mediaType, 'image');
  assert.match(String(posts[0].permalink), /tweet1/);
  assert.equal(posts[1].externalPostId, 'tweet2');
});

// ── fetchPostMetrics ──────────────────────────────────────────────────────────

test('fetchPostMetrics (impressions PRESENT): views=impression_count, likes/commentsCount/shares correctly mapped', async () => {
  const db = fakePostsDb([
    { platform_post_id: 'tweet1', published_at: new Date('2026-06-10'), caption: null },
  ]);
  const gateway = routingGateway({
    TWITTER_POST_LOOKUP_BY_POST_IDS: {
      successful: true,
      error: null,
      data: {
        data: [
          {
            id: 'tweet1',
            public_metrics: {
              like_count: 42,
              reply_count: 7,
              retweet_count: 3,
              impression_count: 500,
            },
            conversation_id: 'tweet1',
          },
        ],
      },
    },
  });
  const adapter = new XInsightsAdapter(gateway, fakeConfig({ actions: {} }), db, ctx);

  // Prime the engagement cache (the dispatcher always calls fetchPostList first).
  await adapter.fetchPostList('xuser123');
  const metrics = await adapter.fetchPostMetrics('tweet1');

  // fetchPostMetrics reads from cache — no additional gateway call.
  assert.equal(gateway.calls.length, 1, 'no extra gateway call; metrics are read from cache');
  assert.equal(metrics.length, 1);

  assert.equal(metrics[0].views, 500);        // real impression_count
  assert.equal(metrics[0].likes, 42);
  assert.equal(metrics[0].commentsCount, 7);  // reply_count → commentsCount
  assert.equal(metrics[0].shares, 3);         // retweet_count → shares

  assert.equal(metrics[0].rawSource.impressions_available, true);
  assert.equal(metrics[0].rawSource.impression_count, 500);
  assert.equal(metrics[0].rawSource.impressions_unavailable_reason, null);
});

test('fetchPostMetrics (impressions ABSENT — fail-soft): views=0 placeholder, rawSource.impressions_available===false, real engagement counts preserved', async () => {
  const db = fakePostsDb([
    { platform_post_id: 'tweet_free_tier', published_at: new Date('2026-06-10'), caption: null },
  ]);
  const gateway = routingGateway({
    TWITTER_POST_LOOKUP_BY_POST_IDS: {
      successful: true,
      error: null,
      data: {
        data: [
          {
            id: 'tweet_free_tier',
            // impression_count deliberately absent — simulates an unpaid/free API tier.
            public_metrics: { like_count: 15, reply_count: 4, retweet_count: 2 },
            conversation_id: 'tweet_free_tier',
          },
        ],
      },
    },
  });
  const adapter = new XInsightsAdapter(gateway, fakeConfig({ actions: {} }), db, ctx);

  await adapter.fetchPostList('xuser123');
  const metrics = await adapter.fetchPostMetrics('tweet_free_tier');

  assert.equal(metrics.length, 1, 'row is still emitted even without impressions');

  // views=0 is an explicit placeholder — NEVER an invented impressions count.
  assert.equal(metrics[0].views, 0, 'views is the 0 placeholder when impression_count is absent');

  // The truth is documented in rawSource so consumers can distinguish
  // "genuinely zero impressions" from "impressions unavailable on this tier".
  assert.equal(
    metrics[0].rawSource.impressions_available,
    false,
    'rawSource.impressions_available must be false when impression_count is absent',
  );
  assert.ok(
    metrics[0].rawSource.impressions_unavailable_reason !== null &&
      metrics[0].rawSource.impressions_unavailable_reason !== undefined,
    'rawSource.impressions_unavailable_reason must be populated',
  );

  // Real engagement metrics are still mapped correctly regardless of impressions.
  assert.equal(metrics[0].likes, 15);
  assert.equal(metrics[0].commentsCount, 4);
  assert.equal(metrics[0].shares, 2);
});

test('fetchPostMetrics: no public_metrics in cache → no fabricated row (empty array)', async () => {
  const db = fakePostsDb([]);
  const adapter = new XInsightsAdapter(
    routingGateway({}),
    fakeConfig({ actions: {} }),
    db,
    ctx,
  );
  // Cache never populated — simulates a tweet Aries has no engagement data for.
  const metrics = await adapter.fetchPostMetrics('tweet_unknown');
  assert.deepEqual(metrics, [], 'no data → empty, never a fabricated zero row');
});

// ── fetchComments ─────────────────────────────────────────────────────────────

test('fetchComments: issues TWITTER_RECENT_SEARCH with conversation_id query, resolves authorHandle from includes.users, excludes owner via -from:', async () => {
  const db = fakePostsDb([
    { platform_post_id: 'tweet1', published_at: new Date('2026-06-10'), caption: null },
  ]);
  const gateway = routingGateway({
    TWITTER_POST_LOOKUP_BY_POST_IDS: {
      successful: true,
      error: null,
      data: {
        data: [
          {
            id: 'tweet1',
            public_metrics: { like_count: 1, reply_count: 2, retweet_count: 0 },
            // conversation_id differs from post id to verify it is extracted correctly.
            conversation_id: 'conv_root_abc',
          },
        ],
      },
    },
    TWITTER_RECENT_SEARCH: {
      successful: true,
      error: null,
      data: {
        data: [
          { id: 'reply1', author_id: 'u1', text: 'Nice thread!', created_at: '2026-06-18T10:00:00Z' },
          { id: 'reply2', author_id: 'u2', text: 'Agreed.', created_at: '2026-06-18T11:00:00Z' },
        ],
        includes: {
          users: [
            { id: 'u1', username: 'janedoe' },
            { id: 'u2', username: 'johndoe' },
          ],
        },
      },
    },
  });
  const adapter = new XInsightsAdapter(gateway, fakeConfig({ actions: {} }), db, ctx);

  // Prime cache via fetchPostList so conversation_id is resolved from the batch.
  await adapter.fetchPostList('xuser123');
  const comments = await adapter.fetchComments('tweet1', 50);

  const searchCall = gateway.calls.find((c) => c.slug === 'TWITTER_RECENT_SEARCH');
  assert.ok(searchCall, 'calls TWITTER_RECENT_SEARCH');

  const query = String(searchCall!.arguments?.query);
  // Thread anchor — uses the conversation_id from the cached tweet, NOT just the post id.
  assert.match(query, /conversation_id:conv_root_abc/);
  // Owner tweets are excluded.
  assert.match(query, /-from:xuser123/);

  assert.equal(comments.length, 2);
  assert.equal(comments[0].externalCommentId, 'reply1');
  assert.equal(comments[0].authorHandle, 'janedoe');
  assert.equal(comments[0].bodyText, 'Nice thread!');
  assert.equal(comments[1].externalCommentId, 'reply2');
  assert.equal(comments[1].authorHandle, 'johndoe');
  assert.equal(comments[1].bodyText, 'Agreed.');
});

// ── fetchAccountMetrics ───────────────────────────────────────────────────────

test('fetchAccountMetrics: always returns [] — no verified X account-insights action exists', async () => {
  const gateway = routingGateway({});
  const adapter = new XInsightsAdapter(
    gateway,
    fakeConfig({ actions: {} }),
    fakePostsDb([]),
    ctx,
  );

  const result = await adapter.fetchAccountMetrics('xuser123', { from: '2026-06-01', to: '2026-06-18' });

  assert.deepEqual(result, []);
  assert.equal(gateway.calls.length, 0, 'no gateway calls — never fabricate an account series');
});

// ── Dormancy / off-switch ─────────────────────────────────────────────────────

// #679: X gates on ARIES_X_ENABLED + COMPOSIO_ENABLED (not ANALYTICS_PROVIDER).
const X_ENABLED_ENV = {
  ARIES_X_ENABLED: '1',
  COMPOSIO_ENABLED: '1',
} as unknown as NodeJS.ProcessEnv;

// ARIES_X_ENABLED absent — flag off.
const FLAG_OFF_ENV = {
  COMPOSIO_ENABLED: '1',
} as unknown as NodeJS.ProcessEnv;

// ARIES_X_ENABLED on but COMPOSIO_ENABLED absent — composio infrastructure off.
const COMPOSIO_OFF_ENV = {
  ARIES_X_ENABLED: '1',
} as unknown as NodeJS.ProcessEnv;

test('dormancy: isXInsightsEnabled requires BOTH ARIES_X_ENABLED=1 AND COMPOSIO_ENABLED=1 (ANALYTICS_PROVIDER is irrelevant for X)', () => {
  assert.equal(isXInsightsEnabled(X_ENABLED_ENV), true, 'both flags on → enabled');
  assert.equal(isXInsightsEnabled(FLAG_OFF_ENV), false, 'ARIES_X_ENABLED absent → disabled');
  assert.equal(isXInsightsEnabled(COMPOSIO_OFF_ENV), false, 'COMPOSIO_ENABLED absent → disabled');
  assert.equal(
    isXInsightsEnabled({} as unknown as NodeJS.ProcessEnv),
    false,
    'no flags → disabled (default OFF)',
  );
  // #679 (c) proof at adapter level: ANALYTICS_PROVIDER=direct_meta does NOT block X.
  assert.equal(
    isXInsightsEnabled({ ARIES_X_ENABLED: '1', COMPOSIO_ENABLED: '1', ANALYTICS_PROVIDER: 'direct_meta' } as unknown as NodeJS.ProcessEnv),
    true,
    '#679 (c): X enabled even when ANALYTICS_PROVIDER=direct_meta',
  );
});

test('dormancy: hasAdapter("x") mirrors isXInsightsEnabled for all flag combinations', () => {
  assert.equal(hasAdapter('x', X_ENABLED_ENV), true);
  assert.equal(hasAdapter('x', FLAG_OFF_ENV), false);
  assert.equal(hasAdapter('x', COMPOSIO_OFF_ENV), false);
  assert.equal(hasAdapter('x', {} as unknown as NodeJS.ProcessEnv), false);
  // #679 (c): hasAdapter mirrors the same new-behavior case.
  assert.equal(
    hasAdapter('x', { ARIES_X_ENABLED: '1', COMPOSIO_ENABLED: '1', ANALYTICS_PROVIDER: 'direct_meta' } as unknown as NodeJS.ProcessEnv),
    true,
    '#679 (c): hasAdapter("x") true when ARIES_X_ENABLED+COMPOSIO_ENABLED regardless of ANALYTICS_PROVIDER',
  );
});

test('dormancy: getAdapter("x") throws a diagnostic error when ARIES_X_ENABLED is off', () => {
  const prevX = process.env.ARIES_X_ENABLED;
  const prevComposio = process.env.COMPOSIO_ENABLED;
  // Ensure both axes are off so the REGISTRY guard fires.
  delete process.env.ARIES_X_ENABLED;
  delete process.env.COMPOSIO_ENABLED;
  try {
    assert.throws(
      () => getAdapter('x', { connectedAccountId: 'ca_x', tenantId: 1 }),
      /ARIES_X_ENABLED/,
    );
  } finally {
    if (prevX === undefined) delete process.env.ARIES_X_ENABLED;
    else process.env.ARIES_X_ENABLED = prevX;
    if (prevComposio === undefined) delete process.env.COMPOSIO_ENABLED;
    else process.env.COMPOSIO_ENABLED = prevComposio;
  }
});

test('#679 isComposioOnlyAnalyticsPlatform: x is in the composio-only set', () => {
  assert.equal(isComposioOnlyAnalyticsPlatform('x'), true);
  assert.equal(isComposioOnlyAnalyticsPlatform('facebook'), false, 'facebook uses ANALYTICS_PROVIDER gate');
});
