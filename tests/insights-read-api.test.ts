/**
 * tests/insights-read-api.test.ts
 *
 * S8-1 / AA-124 (gap E2) — behavioural coverage for backend/insights/read-api.ts,
 * the four handlers behind the routes the shipped screens call:
 *
 *   summary + account-metrics + posts  → frontend/aries-v1/analytics-screen.tsx
 *   comments                           → frontend/aries-v1/comments-screen.tsx
 *
 * tests/insights-route-auth-tenant-isolation.test.ts (AA-108) already pins the
 * REJECTION path for all 14 insights routes and asserts tenant scoping at the
 * source. Nothing, until now, ran one of these handlers to a 200 — so the param
 * binding, the clamps and the string→number coercion were entirely unexercised.
 *
 * The coercion is the reason this file is worth more than it looks: pg returns
 * BIGINT and NUMERIC as STRINGS. A handler that forgot `Number()` would return
 * "12" instead of 12, and any downstream `+` would concatenate rather than add.
 * Every assertion on a numeric field here checks the TYPE, not just the value.
 *
 * Mocked pool (tests/helpers/mock-pool.ts) — no Postgres.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/insights-read-api.test.ts
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';
import {
  withMockPool,
  TIMEZONE_RULE,
  stubTenantLoader,
  type QueryRule,
} from './helpers/mock-pool';

import {
  handleGetInsightsSummary,
  handleGetInsightsPosts,
  handleGetInsightsAccountMetrics,
  handleGetInsightsComments,
} from '../backend/insights/read-api';
import { __resetInsightsMicroCacheForTests } from '../backend/insights/micro-cache';
import type { TenantContextLoader } from '../lib/tenant-context-http';

const TENANT_ID = 7;
const loader = stubTenantLoader(TENANT_ID) as unknown as TenantContextLoader;

/**
 * S7-3/AA-121 landed a process-global 60s micro-cache in front of all four
 * handlers, keyed on (section, tenant, params). Without this reset the second
 * test to use a given key is served from the first test's body and issues NO
 * query — which is not a hypothetical: it silently turned six of the assertions
 * below into vacuous passes the moment that cache merged.
 *
 * Resetting per test is what keeps each one exercising the SQL path it claims
 * to. The cache's own behaviour is asserted deliberately, at the bottom.
 */
test.beforeEach(() => __resetInsightsMicroCacheForTests());

const req = (route: string, qs = '') =>
  new Request(`https://x.test/api/insights/${route}${qs ? `?${qs}` : ''}`);

/** pg hands every aggregate back as a string — fixtures must too, or the test lies. */
const SUMMARY_ROW = {
  total_reach: '1200',
  current_followers: '16000',
  followers_gained: '250',
  total_likes: '90',
  total_comments: '12',
  total_shares: '4',
  total_watch_time_minutes: '340',
  total_engagement: '106',
};

const SUMMARY_RULES: QueryRule[] = [
  TIMEZONE_RULE,
  { match: /AS total_reach/i, rows: [SUMMARY_ROW] },
];

// ── Summary ──────────────────────────────────────────────────────────────────

test('summary returns the aggregate as NUMBERS, not pg strings', async () => {
  const body = await withMockPool(SUMMARY_RULES, async () => {
    const res = await handleGetInsightsSummary(req('summary'), loader);
    assert.equal(res.status, 200);
    return res.json();
  });

  assert.equal(body.totalReach, 1200);
  assert.equal(body.currentFollowers, 16000);
  assert.equal(body.followersGained, 250);
  assert.equal(body.totalEngagement, 106);
  for (const key of [
    'totalReach', 'currentFollowers', 'followersGained', 'totalLikes',
    'totalComments', 'totalShares', 'totalWatchTimeMinutes', 'totalEngagement',
  ]) {
    assert.equal(typeof body[key], 'number', `${key} must be coerced from pg's string`);
  }
});

test('summary binds the tenant id from context as $1, never from the request', async () => {
  // The isolation mechanism. A handler that trusted ?tenantId= would leak.
  const mock = await withMockPool(SUMMARY_RULES, async (m) => {
    await handleGetInsightsSummary(req('summary', 'tenantId=999&platform=instagram'), loader);
    return m;
  });

  const [call] = mock.matching(/AS total_reach/i);
  assert.equal(call.params[0], TENANT_ID, 'tenant id must come from the resolved context');
  assert.equal(call.params[2], 'instagram');
  assert.ok(
    !call.sql.includes('999'),
    'a request-supplied tenant id must never reach the SQL text',
  );
});

test('summary clamps days to 1..90 and falls back on garbage', async () => {
  // Each call is a separate logical request. Two of these clamp to the SAME
  // cache key (days=0 and days=-5 both become 1), so without the reset the
  // second would be answered from the first's body and assert nothing.
  const daysFor = async (qs: string) =>
    withMockPool(SUMMARY_RULES, async () => {
      __resetInsightsMicroCacheForTests();
      const res = await handleGetInsightsSummary(req('summary', qs), loader);
      return (await res.json()).period.days;
    });

  assert.equal(await daysFor('days=7'), 7);
  assert.equal(await daysFor('days=500'), 90, 'an unbounded window would scan the whole table');
  assert.equal(await daysFor('days=0'), 1);
  assert.equal(await daysFor('days=-5'), 1);
  assert.equal(await daysFor('days=abc'), 30, 'unparseable falls back to the default');
  assert.equal(await daysFor(''), 30);
});

test('summary treats a missing platform as all-platforms (null), not the empty string', async () => {
  // `?platform=` binding '' instead of null would filter to a platform named ''
  // and return zeros for every tenant.
  const mock = await withMockPool(SUMMARY_RULES, async (m) => {
    await handleGetInsightsSummary(req('summary', 'platform='), loader);
    return m;
  });
  assert.equal(mock.matching(/AS total_reach/i)[0].params[2], null);
});

test('summary releases its pooled client even when the query throws', async () => {
  // A leak here exhausts DB_POOL_MAX (10 per worker) after ten failures.
  const rules: QueryRule[] = [
    TIMEZONE_RULE,
    { match: /AS total_reach/i, rows: [], throws: new Error('boom') },
  ];
  const mock = await withMockPool(rules, async (m) => {
    await assert.rejects(() => handleGetInsightsSummary(req('summary'), loader));
    return m;
  });
  assert.equal(mock.connectCount, 1);
  assert.equal(mock.releaseCount, 1, 'the client must be released in a finally');
});

// ── Posts ────────────────────────────────────────────────────────────────────

const POST_ROW = {
  id: 41,
  platform: 'instagram',
  external_post_id: 'ig_1',
  title: 'Spring drop',
  media_type: 'image',
  published_at: new Date('2026-07-01T10:00:00Z'),
  permalink: 'https://instagram.com/p/1',
  duration_seconds: null,
  platform_data: { thumbnailUrl: 'https://cdn.test/t.jpg' },
  total_reach: '900',
  total_likes: '45',
  total_comments: '6',
  total_shares: '2',
  avg_view_percentage: '38.5',
};

const POSTS_RULES: QueryRule[] = [{ match: /FROM insights_posts p/i, rows: [POST_ROW] }];

test('posts maps the row to the client shape with numeric metrics', async () => {
  const body = await withMockPool(POSTS_RULES, async () => {
    const res = await handleGetInsightsPosts(req('posts'), loader);
    assert.equal(res.status, 200);
    return res.json();
  });

  assert.equal(body.count, 1);
  const [post] = body.posts;
  assert.equal(post.externalPostId, 'ig_1');
  assert.equal(post.thumbnailUrl, 'https://cdn.test/t.jpg', 'lifted out of platform_data');
  assert.equal(post.metrics.totalReach, 900);
  assert.equal(typeof post.metrics.totalReach, 'number');
  assert.equal(post.metrics.avgViewPercentage, 38.5);
  assert.equal(typeof post.metrics.avgViewPercentage, 'number');
});

test('posts survives a row with no platform_data and no avg_view_percentage', async () => {
  // Both are nullable in the schema; `platform_data?.thumbnailUrl` on null would
  // throw, and `Number(null)` would report a fabricated 0% view-through.
  const rules: QueryRule[] = [
    {
      match: /FROM insights_posts p/i,
      rows: [{ ...POST_ROW, platform_data: null, avg_view_percentage: null }],
    },
  ];
  const body = await withMockPool(rules, async () => {
    const res = await handleGetInsightsPosts(req('posts'), loader);
    return res.json();
  });

  assert.equal(body.posts[0].thumbnailUrl, null);
  assert.equal(
    body.posts[0].metrics.avgViewPercentage,
    null,
    'an unreported view-through must stay null, never become 0',
  );
});

test('posts clamps limit to 1..100 and floors offset at 0', async () => {
  // offset=-3 and '' both clamp to limit 20 / offset 0 — the same cache key —
  // so each call resets, or the later ones are served a cached body and never
  // reach the query whose params they are inspecting.
  const paramsFor = async (qs: string) =>
    withMockPool(POSTS_RULES, async (m) => {
      __resetInsightsMicroCacheForTests();
      await handleGetInsightsPosts(req('posts', qs), loader);
      return m.matching(/FROM insights_posts p/i)[0].params;
    });

  assert.deepEqual((await paramsFor('limit=5&offset=10')).slice(2), [5, 10]);
  assert.equal((await paramsFor('limit=9999'))[2], 100, 'page size must stay bounded');
  assert.equal((await paramsFor('limit=0'))[2], 1);
  assert.equal((await paramsFor('offset=-3'))[3], 0, 'a negative OFFSET is a SQL error');
  assert.deepEqual((await paramsFor('')).slice(2), [20, 0]);
});

test('posts reports an empty page honestly rather than erroring', async () => {
  const body = await withMockPool([{ match: /FROM insights_posts p/i, rows: [] }], async () => {
    const res = await handleGetInsightsPosts(req('posts'), loader);
    assert.equal(res.status, 200);
    return res.json();
  });
  assert.deepEqual(body.posts, []);
  assert.equal(body.count, 0);
});

// ── Account metrics ──────────────────────────────────────────────────────────

const SERIES_RULES: QueryRule[] = [
  TIMEZONE_RULE,
  {
    match: /GROUP BY date, platform/i,
    rows: [
      {
        date: '2026-07-01', platform: 'facebook', reach: '500',
        watch_time_minutes: '20', followers: '10000', followers_delta: '15',
        likes: '30', comments_count: '4', shares: '1',
      },
    ],
  },
];

test('account-metrics returns a numeric series and echoes the resolved window', async () => {
  const body = await withMockPool(SERIES_RULES, async () => {
    const res = await handleGetInsightsAccountMetrics(req('account-metrics', 'days=7'), loader);
    assert.equal(res.status, 200);
    return res.json();
  });

  assert.equal(body.period.days, 7);
  assert.match(body.period.from, /^\d{4}-\d{2}-\d{2}$/, 'the window start is a tenant-tz date key');
  const [point] = body.series;
  assert.equal(point.date, '2026-07-01');
  assert.equal(point.followers, 10000);
  assert.equal(point.followersDelta, 15);
  for (const key of ['reach', 'watchTimeMinutes', 'followers', 'followersDelta', 'likes', 'commentsCount', 'shares']) {
    assert.equal(typeof point[key], 'number', `${key} must be coerced`);
  }
});

test('account-metrics windows on the tenant timezone, not UTC', async () => {
  // S2-3: the handler resolves the tenant zone BEFORE computing the window. If
  // the lookup were dropped, the date key would silently revert to UTC and rows
  // would shift a day near the boundary.
  const mock = await withMockPool(SERIES_RULES, async (m) => {
    await handleGetInsightsAccountMetrics(req('account-metrics'), loader);
    return m;
  });

  assert.equal(mock.matching(/FROM business_profiles/i).length, 1, 'the tenant zone must be resolved');
  assert.equal(
    mock.calls[0].sql.includes('business_profiles'),
    true,
    'and resolved before the windowed query runs',
  );
  assert.equal(mock.matching(/GROUP BY date, platform/i)[0].params[0], TENANT_ID);
});

// ── Comments ─────────────────────────────────────────────────────────────────

const COMMENT_ROW = {
  id: 3, post_id: 41, platform: 'facebook', author_handle: '@ann',
  body_text: 'Do you ship to Canada?', received_at: new Date('2026-07-02T09:00:00Z'),
  is_replied: null, replied_at: null,
  post_title: 'Spring drop', post_permalink: 'https://fb.test/p/1',
};

const COMMENTS_RULES: QueryRule[] = [
  { match: /FROM insights_comments c/i, rows: [COMMENT_ROW] },
];

test('comments joins the post title and coerces a null is_replied to false', async () => {
  // The column is nullable; leaking null to the client makes an unanswered
  // comment render as neither replied nor unreplied in the inbox.
  const body = await withMockPool(COMMENTS_RULES, async () => {
    const res = await handleGetInsightsComments(req('comments'), loader);
    assert.equal(res.status, 200);
    return res.json();
  });

  const [comment] = body.comments;
  assert.equal(comment.postTitle, 'Spring drop');
  assert.equal(comment.isReplied, false);
  assert.equal(typeof comment.isReplied, 'boolean');
  assert.equal(body.count, 1);
});

test('comments clamps limit to 1..200 and passes an absent postId as null', async () => {
  // '' and postId=0 resolve to the same (limit 50, postId null) key.
  const paramsFor = async (qs: string) =>
    withMockPool(COMMENTS_RULES, async (m) => {
      __resetInsightsMicroCacheForTests();
      await handleGetInsightsComments(req('comments', qs), loader);
      return m.matching(/FROM insights_comments c/i)[0].params;
    });

  assert.equal((await paramsFor(''))[3], 50, 'default page size');
  assert.equal((await paramsFor('limit=1000'))[3], 200);
  assert.equal((await paramsFor('limit=0'))[3], 1);
  assert.equal((await paramsFor(''))[2], null, 'no postId means every post, not post 0');
  assert.equal((await paramsFor('postId=41'))[2], 41);
  assert.equal(
    (await paramsFor('postId=0'))[2],
    null,
    'post id 0 is not a real row — it must fall through to null',
  );
});

// ── Micro-cache wiring (S7-3/AA-121) ─────────────────────────────────────────
// tests/insights-micro-cache.test.ts pins the cache MODULE. These pin that each
// handler is wired to it correctly, which is a different thing and the half that
// can leak a tenant's data.

test('a repeat request inside the window is served from cache, costing no DB work', async () => {
  const mock = await withMockPool(SUMMARY_RULES, async (m) => {
    const first = await handleGetInsightsSummary(req('summary', 'days=30'), loader);
    assert.equal(first.status, 200);
    const queriesAfterFirst = m.calls.length;
    assert.ok(queriesAfterFirst > 0, 'the first request must actually query');

    const second = await handleGetInsightsSummary(req('summary', 'days=30'), loader);
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), await first.json(), 'same body');
    assert.equal(m.calls.length, queriesAfterFirst, 'a hit must issue no query');
    assert.equal(m.connectCount, 1, 'and must not check out a pooled client');
    return m;
  });
  assert.equal(mock.releaseCount, 1);
});

test('the cached body is marked private so no CDN can hold per-tenant data', async () => {
  // A shared cache holding this body would serve one tenant's numbers to
  // another — the failure mode that makes `private` non-negotiable here.
  await withMockPool(SUMMARY_RULES, async () => {
    await handleGetInsightsSummary(req('summary'), loader);
    const hit = await handleGetInsightsSummary(req('summary'), loader);
    assert.match(hit.headers.get('Cache-Control') ?? '', /private/);
  });
});

test('a different tenant never reads the first tenant\'s cached body', async () => {
  // The isolation property. On a hit the tenant-scoped SQL never runs, so
  // nothing downstream would catch a leaked entry — this assertion is the only
  // thing standing between a key bug and cross-tenant disclosure.
  const other = stubTenantLoader(99) as unknown as TenantContextLoader;
  const rules: QueryRule[] = [
    TIMEZONE_RULE,
    {
      match: /AS total_reach/i,
      // Answer per bound tenant, so a leak shows up as the wrong number.
      rows: (params) => [{ ...SUMMARY_ROW, total_reach: params[0] === TENANT_ID ? '1200' : '4242' }],
    },
  ];

  await withMockPool(rules, async (m) => {
    const a = await (await handleGetInsightsSummary(req('summary'), loader)).json();
    const b = await (await handleGetInsightsSummary(req('summary'), other)).json();

    assert.equal(a.totalReach, 1200);
    assert.equal(b.totalReach, 4242, 'tenant 99 must not be served tenant 7\'s cached body');
    assert.equal(m.matching(/AS total_reach/i).length, 2, 'each tenant runs its own query');
  });
});

test('a differing query param is a different cache entry, not a stale hit', async () => {
  // days is part of the key; if it were not, changing the window would return
  // the previous window's numbers under the new label.
  await withMockPool(SUMMARY_RULES, async (m) => {
    await handleGetInsightsSummary(req('summary', 'days=7'), loader);
    const other = await handleGetInsightsSummary(req('summary', 'days=90'), loader);
    assert.equal((await other.json()).period.days, 90);
    assert.equal(m.matching(/AS total_reach/i).length, 2, 'a new window must re-query');
  });
});

// ── Coverage guard ───────────────────────────────────────────────────────────

test('every handler exported from read-api.ts is exercised above', () => {
  // Without this, a fifth handler could be added and silently stay untested —
  // which is the exact state this ticket exists to end.
  const source = readFileSync(
    path.join(resolveProjectRoot(import.meta.url), 'backend', 'insights', 'read-api.ts'),
    'utf8',
  );
  const exported = [...source.matchAll(/export async function (handleGet\w+)/g)].map((m) => m[1]);
  const tested = new Set([
    'handleGetInsightsSummary',
    'handleGetInsightsPosts',
    'handleGetInsightsAccountMetrics',
    'handleGetInsightsComments',
  ]);

  assert.ok(exported.length > 0, 'the export scan must actually find handlers');
  for (const name of exported) {
    assert.ok(tested.has(name), `${name} is exported but has no behavioural test here`);
  }
});
