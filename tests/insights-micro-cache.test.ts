import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';
import {
  INSIGHTS_MICRO_CACHE_MAX_ENTRIES,
  INSIGHTS_MICRO_CACHE_MAX_TTL_MS,
  __insightsMicroCacheSizeForTests,
  __resetInsightsMicroCacheForTests,
  clampMicroCacheTtlMs,
  insightsMicroCacheKey,
  invalidateInsightsMicroCache,
  microCacheControlHeader,
  readInsightsMicroCache,
  writeInsightsMicroCache,
} from '../backend/insights/micro-cache';

/**
 * S7-3 / AA-121 (gap D3) — short-TTL cache for the previously uncached insights
 * endpoints.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/insights-micro-cache.test.ts
 */

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const read = (...p: string[]) => readFileSync(path.join(PROJECT_ROOT, ...p), 'utf8');

test.beforeEach(() => __resetInsightsMicroCacheForTests());

// ── Tenant isolation: the property that matters most ─────────────────────────

test('SECURITY: two tenants never share a cache entry', () => {
  const a = insightsMicroCacheKey('conversations', 7, { period: 'week', platform: 'all' });
  const b = insightsMicroCacheKey('conversations', 8, { period: 'week', platform: 'all' });
  assert.notEqual(a, b);

  writeInsightsMicroCache(a, { secret: 'tenant-7' });
  assert.equal(readInsightsMicroCache(b), null, 'tenant 8 must not read tenant 7 body');
  assert.deepEqual(readInsightsMicroCache(a), { secret: 'tenant-7' });
});

test('SECURITY: a missing or junk tenant produces NO key, so nothing is cached', () => {
  // Returning a key without a tenant would be the one bug that leaks across
  // tenants, and on a hit the scoped SQL never runs to catch it.
  for (const bad of [null, undefined, '', 'abc', 0, -1, 1.5, Number.NaN]) {
    assert.equal(insightsMicroCacheKey('conversations', bad as never), null, String(bad));
  }
  // A null key is an explicit passthrough, not an empty-string bucket.
  writeInsightsMicroCache(null, { leaked: true });
  assert.equal(readInsightsMicroCache(null), null);
  assert.equal(__insightsMicroCacheSizeForTests(), 0);
});

test('every input that changes the body changes the key', () => {
  const base = insightsMicroCacheKey('posts', 7, { platform: 'instagram', limit: 50, offset: 0 });
  assert.notEqual(base, insightsMicroCacheKey('posts', 7, { platform: 'facebook', limit: 50, offset: 0 }));
  assert.notEqual(base, insightsMicroCacheKey('posts', 7, { platform: 'instagram', limit: 20, offset: 0 }));
  assert.notEqual(base, insightsMicroCacheKey('posts', 7, { platform: 'instagram', limit: 50, offset: 50 }));
  // Different section, same params — different bucket.
  assert.notEqual(base, insightsMicroCacheKey('comments', 7, { platform: 'instagram', limit: 50, offset: 0 }));
});

test('key building is order-independent', () => {
  assert.equal(
    insightsMicroCacheKey('summary', 7, { days: 30, platform: 'all' }),
    insightsMicroCacheKey('summary', 7, { platform: 'all', days: 30 }),
  );
});

// ── TTL ──────────────────────────────────────────────────────────────────────

test('the 60s ceiling is enforced here, not trusted to call sites', () => {
  // Conversations carries reply/unread state; a caller quietly passing 10
  // minutes would make a just-sent reply look unsent for ten minutes.
  assert.equal(clampMicroCacheTtlMs(10 * 60_000), INSIGHTS_MICRO_CACHE_MAX_TTL_MS);
  assert.equal(INSIGHTS_MICRO_CACHE_MAX_TTL_MS, 60_000);
  assert.equal(clampMicroCacheTtlMs(30_000), 30_000);
  // Unusable values fall back rather than disabling the cache silently.
  for (const bad of [0, -1, Number.NaN, undefined]) {
    assert.equal(clampMicroCacheTtlMs(bad as never), 60_000, String(bad));
  }
});

test('an entry expires and is evicted on read', () => {
  const key = insightsMicroCacheKey('aries', 7, { period: 'week' });
  writeInsightsMicroCache(key, { v: 1 }, 60_000, 1_000);
  assert.deepEqual(readInsightsMicroCache(key, 60_000), { v: 1 }, 'still live before expiry');
  assert.equal(readInsightsMicroCache(key, 61_001), null, 'expired');
  assert.equal(__insightsMicroCacheSizeForTests(), 0, 'expired entries do not linger');
});

test('the entry cap bounds memory on a long-lived worker', () => {
  for (let i = 0; i < INSIGHTS_MICRO_CACHE_MAX_ENTRIES + 25; i += 1) {
    writeInsightsMicroCache(insightsMicroCacheKey('posts', 7, { offset: i }), { i });
  }
  assert.ok(
    __insightsMicroCacheSizeForTests() <= INSIGHTS_MICRO_CACHE_MAX_ENTRIES,
    `size ${__insightsMicroCacheSizeForTests()} exceeded the cap`,
  );
});

// ── Invalidation (the conversations freshness contract) ──────────────────────

test('invalidating a tenant+section leaves other sections and tenants intact', () => {
  const convo7 = insightsMicroCacheKey('conversations', 7, { period: 'week' });
  const aries7 = insightsMicroCacheKey('aries', 7, { period: 'week' });
  const convo8 = insightsMicroCacheKey('conversations', 8, { period: 'week' });
  writeInsightsMicroCache(convo7, { a: 1 });
  writeInsightsMicroCache(aries7, { b: 2 });
  writeInsightsMicroCache(convo8, { c: 3 });

  const removed = invalidateInsightsMicroCache(7, 'conversations');
  assert.equal(removed, 1);
  assert.equal(readInsightsMicroCache(convo7), null, 'target cleared');
  assert.deepEqual(readInsightsMicroCache(aries7), { b: 2 }, 'other section untouched');
  assert.deepEqual(readInsightsMicroCache(convo8), { c: 3 }, 'other TENANT untouched');
});

test('invalidating without a section clears only that tenant', () => {
  writeInsightsMicroCache(insightsMicroCacheKey('conversations', 7, {}), { a: 1 });
  writeInsightsMicroCache(insightsMicroCacheKey('aries', 7, {}), { b: 2 });
  writeInsightsMicroCache(insightsMicroCacheKey('aries', 8, {}), { c: 3 });

  assert.equal(invalidateInsightsMicroCache(7), 2);
  assert.deepEqual(readInsightsMicroCache(insightsMicroCacheKey('aries', 8, {})), { c: 3 });
});

test('a section prefix cannot partially match another section', () => {
  // 'comments' must not be cleared by invalidating 'comment'.
  writeInsightsMicroCache(insightsMicroCacheKey('comments', 7, {}), { a: 1 });
  assert.equal(invalidateInsightsMicroCache(7, 'comment'), 0);
  assert.deepEqual(readInsightsMicroCache(insightsMicroCacheKey('comments', 7, {})), { a: 1 });
});

test('an invalid tenant invalidates nothing rather than everything', () => {
  writeInsightsMicroCache(insightsMicroCacheKey('conversations', 7, {}), { a: 1 });
  assert.equal(invalidateInsightsMicroCache(null), 0);
  assert.equal(invalidateInsightsMicroCache('nonsense'), 0);
  assert.deepEqual(readInsightsMicroCache(insightsMicroCacheKey('conversations', 7, {})), { a: 1 });
});

// ── Cache-Control ────────────────────────────────────────────────────────────

test('SECURITY: the header is private — a shared cache must never hold these', () => {
  // These bodies are per-tenant and the URL carries no tenant, so a CDN or
  // corporate proxy caching one publicly would serve it to the next tenant.
  const header = microCacheControlHeader(60_000);
  assert.match(header, /^private,/);
  assert.doesNotMatch(header, /public/);
  assert.match(header, /max-age=60/);
  assert.match(header, /must-revalidate/);
  // The ceiling applies to the advertised age too.
  assert.match(microCacheControlHeader(10 * 60_000), /max-age=60\b/);
});

// ── Wiring ───────────────────────────────────────────────────────────────────

const SECTION_HANDLERS: Array<[string, string]> = [
  ['conversations', 'backend/insights/conversations/handler.ts'],
  ['aries', 'backend/insights/aries/handler.ts'],
  ['audience', 'backend/insights/audience/handler.ts'],
];

for (const [section, file] of SECTION_HANDLERS) {
  test(`${section} reads the cache BEFORE doing any work, and sets Cache-Control`, () => {
    const source = read(...file.split('/'));
    assert.match(source, new RegExp(`insightsMicroCacheKey\\('${section}'`));
    assert.match(source, /readInsightsMicroCache/);
    assert.match(source, /writeInsightsMicroCache/);
    assert.match(source, /microCacheControlHeader/);

    // A cache consulted after the expensive call saves nothing.
    const cacheAt = source.indexOf('readInsightsMicroCache');
    const buildAt = source.search(/await build[A-Z]/);
    assert.ok(cacheAt > 0 && buildAt > 0);
    assert.ok(cacheAt < buildAt, `${section}: cache read must precede the builder`);
  });

  test(`${section} documents its freshness semantics`, () => {
    // The card requires per-endpoint freshness semantics to be written down —
    // a cached endpoint whose staleness nobody stated is a bug waiting to be
    // argued about.
    const source = read(...file.split('/'));
    assert.match(source, /FRESHNESS:/, `${section} must state its freshness contract`);
  });
}

test('all four read-api endpoints check the cache before taking a pooled client', () => {
  // This is the pool win: a hit must cost no client at all, exactly as the
  // force throttle gates before pool.connect().
  const source = read('backend', 'insights', 'read-api.ts');
  for (const section of ['summary', 'posts', 'account-metrics', 'comments']) {
    assert.match(source, new RegExp(`insightsMicroCacheKey\\('${section}'`), `${section} not cached`);
  }
  // Count CALL SITES, not the identifier — the import line contains it too.
  assert.equal((source.match(/readInsightsMicroCache</g) ?? []).length, 4);
  assert.equal((source.match(/writeInsightsMicroCache\(cacheKey/g) ?? []).length, 4);

  // Every cache read must come before the pool.connect() that follows it.
  const segments = source.split('const cached = readInsightsMicroCache').slice(1);
  assert.equal(segments.length, 4);
  for (const [i, segment] of segments.entries()) {
    const connectAt = segment.indexOf('await pool.connect()');
    assert.ok(connectAt > 0, `handler ${i}: expected a pool.connect() after the cache read`);
    const returnAt = segment.indexOf('return NextResponse.json(cached');
    assert.ok(returnAt > 0 && returnAt < connectAt, `handler ${i}: hit must return before connecting`);
  }
});

test('a confirmed reply invalidates the conversations cache', () => {
  // Without this the operator watches their OWN reply not appear for up to 60s
  // and reasonably concludes it failed. Invalidating on the write is what makes
  // caching this section defensible at all.
  const source = read('app', 'api', 'insights', 'comments', '[commentId]', 'reply', 'handler.ts');
  assert.match(source, /invalidateInsightsMicroCache\(tenantId, 'conversations'\)/);
  assert.match(source, /invalidateInsightsMicroCache\(tenantId, 'comments'\)/);

  // It must sit on the CONFIRMED path — after the reply is live — not before.
  const stampAt = source.indexOf("SET platform_reply_id");
  const invalidateAt = source.indexOf('invalidateInsightsMicroCache(tenantId');
  assert.ok(stampAt > 0 && invalidateAt > stampAt, 'invalidate only once the reply is live');

  // And it must never break a reply that already succeeded.
  const around = source.slice(invalidateAt - 200, invalidateAt + 200);
  assert.match(around, /try \{/, 'the invalidation must be wrapped');
});

test('the freshness stamp stays uncached', () => {
  // It exists to report staleness; caching it would make it lie.
  const source = read('backend', 'insights', 'freshness', 'handler.ts');
  assert.match(source, /'Cache-Control': 'no-store'/);
  assert.doesNotMatch(source, /readInsightsMicroCache/);
});
