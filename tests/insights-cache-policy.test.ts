/**
 * tests/insights-cache-policy.test.ts
 *
 * S7-4 / AA-122 (gaps D4/D5) — the shared expiry + stampede policy for the six
 * cached insights sections, plus the source-level guarantee that a cache-miss
 * request no longer holds two pooled connections.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/insights-cache-policy.test.ts
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';
import {
  INSIGHTS_CACHE_TTL_MS,
  INSIGHTS_CACHE_MAX_JITTER_MS,
  insightsCacheJitterMs,
  insightsCacheTtlMs,
  buildInsightsSectionOnce,
  __resetInsightsInflightForTests,
  __inflightCountForTests,
} from '../backend/insights/cache-policy';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const read = (...segments: string[]): string =>
  readFileSync(path.join(PROJECT_ROOT, ...segments), 'utf8');

const SECTIONS = ['narrative', 'goal', 'attention', 'activity', 'trends', 'top'] as const;

const BUILDERS: Array<[string, string]> = [
  ['activity', 'activity/activity-snapshot-builder.ts'],
  ['top', 'top/top-snapshot-builder.ts'],
  ['trends', 'trends/trends-snapshot-builder.ts'],
  ['attention', 'attention/attention-snapshot-builder.ts'],
  ['narrative', 'narrative/snapshot-builder.ts'],
  ['goal', 'goal/goal-snapshot-builder.ts'],
];

// ── D5: one pooled connection per cache-miss request ──────────────────────────

test('no cached-section builder acquires its own pool connection', () => {
  // The bug: the handler held a client for the cache read + upsert while the
  // builder acquired a second one for the whole build, so every cache miss
  // occupied two of DB_POOL_MAX (guardrail #1). Each builder now runs on the
  // client its handler already holds.
  for (const [name, rel] of BUILDERS) {
    const source = read('backend', 'insights', ...rel.split('/'));
    assert.doesNotMatch(
      source,
      /pool\.connect\(\)/,
      `${name} builder must run on the handler's client, not a second connection`,
    );
    assert.doesNotMatch(
      source,
      /client\.release\(\)/,
      `${name} builder must not release a client it does not own`,
    );
    assert.match(
      source,
      /client:\s*PoolClient/,
      `${name} builder must take the caller's client`,
    );
  }
});

test('each cached handler still owns exactly one connect/release pair', () => {
  for (const section of SECTIONS) {
    const source = read('backend', 'insights', section, 'handler.ts');
    const connects = source.match(/pool\.connect\(\)/g) ?? [];
    const releases = source.match(/client\.release\(\)/g) ?? [];
    assert.equal(connects.length, 1, `${section} handler should connect exactly once`);
    assert.equal(releases.length, 1, `${section} handler should release exactly once`);
  }
});

// ── D4a: jitter spreads expiries across keys ──────────────────────────────────

test('jitter is a fraction of the section TTL, capped', () => {
  // A flat window would be a 67% swing on the 15-minute attention section.
  assert.equal(insightsCacheJitterMs(60 * 60 * 1000), 6 * 60 * 1000);
  assert.equal(insightsCacheJitterMs(15 * 60 * 1000), 90 * 1000);
  // Cap holds for an implausibly long TTL.
  assert.equal(insightsCacheJitterMs(24 * 60 * 60 * 1000), INSIGHTS_CACHE_MAX_JITTER_MS);
  // Degenerate bases produce no jitter rather than a negative or NaN TTL.
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(insightsCacheJitterMs(bad), 0, `jitter for base ${bad}`);
  }
});

test('a jittered TTL never dips below the section TTL', () => {
  // Jitter may only delay an expiry. Bringing one forward would make a section
  // fresher than the freshness contract it documents.
  for (let i = 0; i < 500; i++) {
    const ttl = insightsCacheTtlMs(`tenant-${i}|week|all|activity-v7`);
    assert.ok(ttl >= INSIGHTS_CACHE_TTL_MS, `ttl ${ttl} below base for key ${i}`);
    assert.ok(ttl < INSIGHTS_CACHE_TTL_MS + insightsCacheJitterMs(), `ttl ${ttl} above window`);
  }
});

test('the same key always resolves to the same TTL', () => {
  // Load-bearing: a per-request random TTL would let two concurrent readers
  // disagree about whether one row is stale, so a body could flip between
  // fresh and expired on refresh.
  const key = 'tenant-7|30day|instagram|top-v8';
  const first = insightsCacheTtlMs(key);
  for (let i = 0; i < 20; i++) {
    assert.equal(insightsCacheTtlMs(key), first);
  }
});

test('different keys land on different expiries', () => {
  // The point of the whole exercise: six sections written in the same second
  // must not expire in the same second.
  const ttls = new Set(
    ['activity-v7', 'top-v8', 'trends-v5', 'attention-v5', 'goal-template-v8', 'template-v4'].map(
      (version) => insightsCacheTtlMs(`tenant-7|week|all|${version}`),
    ),
  );
  assert.ok(ttls.size >= 5, `expected spread across sections, got ${ttls.size} distinct TTLs`);
});

test('a zero-jitter base returns the base TTL unchanged', () => {
  assert.equal(insightsCacheTtlMs('anything', 0), 0);
});

// ── D4b: singleflight collapses concurrent misses ─────────────────────────────

test('concurrent misses on one key run a single build', async () => {
  __resetInsightsInflightForTests();
  let builds = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });

  const build = async () => {
    builds++;
    await gate;
    return 'snapshot';
  };

  const callers = Array.from({ length: 25 }, () => buildInsightsSectionOnce('k', build));
  release();
  const results = await Promise.all(callers);

  assert.equal(builds, 1);
  assert.deepEqual(new Set(results), new Set(['snapshot']));
  assert.equal(__inflightCountForTests(), 0, 'the in-flight entry must be cleared');
});

test('different keys are not collapsed together', async () => {
  __resetInsightsInflightForTests();
  const seen: string[] = [];
  await Promise.all([
    buildInsightsSectionOnce('a', async () => { seen.push('a'); return 'a'; }),
    buildInsightsSectionOnce('b', async () => { seen.push('b'); return 'b'; }),
  ]);
  assert.deepEqual(seen.sort(), ['a', 'b']);
});

test('a later request after the build settles starts a fresh build', async () => {
  __resetInsightsInflightForTests();
  let builds = 0;
  const build = async () => { builds++; return builds; };

  assert.equal(await buildInsightsSectionOnce('k', build), 1);
  assert.equal(await buildInsightsSectionOnce('k', build), 2);
  assert.equal(__inflightCountForTests(), 0);
});

test('a follower does not inherit the leader failure', async () => {
  // Each caller passes a builder closed over its OWN pooled client, so a
  // leader can fail for a reason that has nothing to do with the follower
  // (its request aborted and released the client mid-build). The follower
  // must build on its own rather than fail with it.
  __resetInsightsInflightForTests();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });

  const leader = buildInsightsSectionOnce('k', async () => {
    await gate;
    throw new Error('leader request aborted');
  });
  const followerAttempt = leader.catch(() => 'unused');
  const follower = followerAttempt.then(() =>
    buildInsightsSectionOnce('k', async () => 'follower built it'),
  );

  release();
  await assert.rejects(leader, /leader request aborted/);
  assert.equal(await follower, 'follower built it');
  assert.equal(__inflightCountForTests(), 0);
});

test('a leader failure still reaches its own caller', async () => {
  __resetInsightsInflightForTests();
  await assert.rejects(
    buildInsightsSectionOnce('k', async () => { throw new Error('real db error'); }),
    /real db error/,
  );
  assert.equal(__inflightCountForTests(), 0, 'a failed build must not wedge the key');
});

// ── Wiring ────────────────────────────────────────────────────────────────────

test('every cached handler uses the shared jitter + singleflight policy', () => {
  for (const section of SECTIONS) {
    const source = read('backend', 'insights', section, 'handler.ts');
    assert.match(source, /insightsCacheTtlMs\(cacheKey, CACHE_TTL_BASE_MS\)/, `${section} jitter`);
    assert.match(source, /buildInsightsSectionOnce\(cacheKey,/, `${section} singleflight`);
    // The flat constant must be gone, or a handler could silently keep the
    // un-jittered expiry while looking like it opted in.
    assert.doesNotMatch(source, /\bCACHE_TTL_MS\b/, `${section} still references the flat TTL`);
  }
});
