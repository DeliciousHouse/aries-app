/**
 * tests/insights-narrative.test.ts
 *
 * S8-1 / AA-124 (gap E3) — the narrative module, which backs the Hero band on
 * the shipped /insights dashboard (frontend/insights/HeroSection.tsx) and had no
 * tests at all: score builder, snapshot builder, template builder, and handler.
 *
 * Only tests/insights-narrative-connection-error.test.ts existed, covering the
 * S1-4 connect-gate. Everything the operator actually READS — the score, the
 * judgment word, the sentences — was unpinned.
 *
 * The score and the honesty guards get the most attention here, because this is
 * the one section that states a conclusion rather than a number. S3-1 exists
 * because a dead account used to score ~50 and read as reassurance; a test that
 * did not pin the zero-signal path would let that come back silently.
 *
 * No Postgres: the pure builders take plain values, the snapshot builder is
 * HANDED a scripted client (AA-122 — it must never acquire its own), and the
 * handler runs against a mocked pool.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/insights-narrative.test.ts
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';
import {
  withMockPool,
  scriptedClient,
  TIMEZONE_RULE,
  stubTenantLoader,
  type QueryRule,
} from './helpers/mock-pool';

import { computeAriesScore } from '../backend/insights/narrative/score-builder';
import { buildNarrativeText } from '../backend/insights/narrative/template-builder';
import {
  buildNarrativeSnapshot,
  type NarrativeSnapshot,
} from '../backend/insights/narrative/snapshot-builder';
import { handleGetInsightsNarrative } from '../backend/insights/narrative/handler';
import { __resetInsightsInflightForTests } from '../backend/insights/cache-policy';
import { __resetInsightsForceThrottleForTests } from '../backend/insights/force-throttle';
import { HOURS_PER_POST } from '../backend/insights/hours-saved';
import type { PoolClient } from '../lib/db';
import type { TenantContextLoader } from '../lib/tenant-context-http';

const TENANT_ID = 7;
const loader = stubTenantLoader(TENANT_ID) as unknown as TenantContextLoader;

/** The live template version, read from source so a bump cannot silently
 *  invalidate these fixtures without also failing here. */
const TEMPLATE_VERSION = (() => {
  const source = readFileSync(
    path.join(resolveProjectRoot(import.meta.url), 'backend', 'insights', 'narrative', 'handler.ts'),
    'utf8',
  );
  const m = source.match(/const TEMPLATE_VERSION = '([^']+)'/);
  assert.ok(m, 'TEMPLATE_VERSION must be readable from handler.ts');
  return m[1];
})();

test.beforeEach(() => {
  __resetInsightsInflightForTests();
  __resetInsightsForceThrottleForTests();
});

// ── Score builder ────────────────────────────────────────────────────────────

test('S3-1: an account with NO measured signal scores 0, not the ~50 base', () => {
  // The honesty guard. Before it, a dead account floated at its period base and
  // the Hero reported a reassuring ~50 for a tenant with nothing happening.
  const dead = computeAriesScore('week', 0, 0, 0, 0);
  assert.equal(dead.score, 0);
  assert.equal(dead.scoreDelta, 0);

  // Any ONE of reach / engagement / positive reach delta counts as measured.
  assert.equal(computeAriesScore('week', 0, 0, 0, 120).score, 56, 'reach alone earns the base');
  assert.ok(computeAriesScore('week', 1.2, 0, 0, 0).score > 0, 'engagement alone earns it');
  assert.ok(computeAriesScore('week', 0, 5, 0, 0).score > 0, 'a positive reach delta earns it');
});

test('each period has its own base, so scores stay comparable across windows', () => {
  // A longer window accumulates more reach delta, so the baseline compresses.
  assert.equal(computeAriesScore('week', 0, 0, 0, 100).score, 56);
  assert.equal(computeAriesScore('30day', 0, 0, 0, 100).score, 55);
  assert.equal(computeAriesScore('90day', 0, 0, 0, 100).score, 48);
});

test('the score is clamped to 0..100 at both ends', () => {
  assert.equal(computeAriesScore('week', 1000, 0, 0, 100).score, 100);
  assert.equal(computeAriesScore('week', 0, -1000, 0, 100).score, 0, 'a collapse floors at 0');
});

test('scoreDelta compares against the previous period at a flat reach delta', () => {
  // reachDelta is deliberately assumed 0 for the prior window (no third query),
  // so the delta reflects the change in ENGAGEMENT only.
  const improved = computeAriesScore('week', 4, 0, 2, 100);
  assert.equal(improved.score, 66);      // 56 + 2.5*4
  assert.equal(improved.scoreDelta, 5);  // 66 - (56 + 2.5*2)

  const flat = computeAriesScore('week', 4, 0, 4, 100);
  assert.equal(flat.scoreDelta, 0);
});

test('judgment words follow the thresholds, with the period-specific suffix', () => {
  const j = (period: 'week' | '30day' | '90day', er: number, erPrev = er) =>
    computeAriesScore(period, er, 0, erPrev, 100).judgment;

  assert.equal(j('week', 8), 'Strong week');       // 76
  assert.equal(j('30day', 8.4), 'Strong month');   // 76
  assert.equal(j('90day', 11.2), 'Strong');        // 76, no suffix
  assert.equal(j('week', 4.8), 'Steady');          // 68
  assert.equal(j('90day', 8), 'Steady growth');    // 68 on the quarter reads differently
  assert.equal(j('week', 2, 2), 'Steady');         // 61, flat delta
  assert.equal(j('week', 2, 0), 'Building');       // 61, delta +5
  assert.equal(j('week', 0, 0), 'Slow');           // 56, flat
});

// ── Template builder ─────────────────────────────────────────────────────────

const BASE_SNAPSHOT: NarrativeSnapshot = {
  platform: 'instagram',
  period: 'week',
  posts: 3,
  postsLabel: 'post',
  reach: 1500,
  reachPrev: 1000,
  reachDelta: 50,
  reachLabel: 'people',
  engagementRate: 4.2,
  engagementRatePrev: 3.1,
  comments: 5,
  unreplied: 0,
  hoursSaved: 9,
  topPost: null,
  watchTimeMinutes: null,
  hasData: true,
};

const snap = (over: Partial<NarrativeSnapshot> = {}): NarrativeSnapshot => ({
  ...BASE_SNAPSHOT,
  ...over,
});

test('with no data the copy invites a first post instead of reporting zeros', () => {
  const text = buildNarrativeText(snap({ hasData: false }));
  assert.match(text, /^No posts published on Instagram yet this week\./);
  assert.match(text, /Once you publish/);
  assert.doesNotMatch(text, /\b0 people\b/, 'an empty period must not be narrated as a result');

  assert.match(buildNarrativeText(snap({ hasData: false, platform: 'all' })), /any of your channels/);
  assert.match(
    buildNarrativeText(snap({ hasData: false, platform: 'youtube' })),
    /No videos published/,
    'YouTube counts videos, not posts',
  );
  assert.match(
    buildNarrativeText(snap({ hasData: false, period: '30day' })),
    /in the last 30 days/,
  );
});

test('a single-platform period reads as one sentence with reach and its delta', () => {
  assert.equal(
    buildNarrativeText(snap()),
    'This week, Instagram: 3 posts published, reaching 1.5K people (up 50% last week). Engagement rate: 4.2%.',
  );
});

test('the all-channels context aggregates and names the top post platform', () => {
  const text = buildNarrativeText(
    snap({
      platform: 'all',
      period: '30day',
      reach: 1_200_000,
      reachDelta: -12.5,
      topPost: { title: 'Spring drop', platform: 'facebook', metric: 4200, metricLabel: 'people' },
    }),
  );
  assert.match(text, /^This month across all your channels, you published 3 posts reaching 1\.2M people — down 12\.5% the previous 30 days\./);
  assert.match(text, /Your top post was "Spring drop" on Facebook with 4\.2K people\./);
});

test('a zero reach delta is narrated as "about the same", never as up 0%', () => {
  assert.match(buildNarrativeText(snap({ reachDelta: 0 })), /about the same as last week/);
});

test('the top-post sentence is omitted when the top post has no reach', () => {
  // Naming a "top post" that reached nobody is the fabrication this guards.
  const text = buildNarrativeText(
    snap({ topPost: { title: 'Quiet one', platform: 'instagram', metric: 0, metricLabel: 'people' } }),
  );
  assert.doesNotMatch(text, /top post/);
});

test('watch time replaces the engagement hint and pluralises by unit', () => {
  assert.match(
    buildNarrativeText(snap({ platform: 'youtube', watchTimeMinutes: 45 })),
    /45 minutes of watch time generated\./,
  );
  assert.match(
    buildNarrativeText(snap({ platform: 'youtube', watchTimeMinutes: 1 })),
    /1 minute of watch time/,
  );
  assert.match(
    buildNarrativeText(snap({ platform: 'youtube', watchTimeMinutes: 120 })),
    /2 hours of watch time/,
  );
  assert.doesNotMatch(
    buildNarrativeText(snap({ platform: 'youtube', watchTimeMinutes: 120 })),
    /Engagement rate/,
    'watch time takes the slot, so the two never both appear',
  );
});

test('the unreplied nudge agrees with itself on number', () => {
  assert.match(buildNarrativeText(snap({ unreplied: 1 })), /1 comment is waiting for a reply\.$/);
  assert.match(buildNarrativeText(snap({ unreplied: 4 })), /4 comments are waiting for a reply\.$/);
  assert.doesNotMatch(buildNarrativeText(snap({ unreplied: 0 })), /waiting for a reply/);
});

test('a single post is not narrated as "1 posts"', () => {
  assert.match(buildNarrativeText(snap({ posts: 1 })), /1 post published/);
});

// ── Snapshot builder ─────────────────────────────────────────────────────────

// AA-231: mock rows carry the `engagement` alias the query now selects
// (accountEngagementSql — COALESCE(engagement, likes+comments_count+shares)).
// 100 / 30 below are the same totals the old likes(60)+comments(20)+shares(20)
// and likes(20)+comments(5)+shares(5) fixtures summed to, so the expected
// engagementRate / engagementRatePrev assertions below are unchanged.
const SNAPSHOT_RULES = (over: Record<string, QueryRule['rows']> = {}): QueryRule[] => [
  TIMEZONE_RULE,
  { match: /watch_time_minutes/i, rows: over.current ?? [{ reach: '2000', engagement: '100', watch_time_minutes: '90' }] },
  { match: /date < \$3::date/i, rows: over.prev ?? [{ reach: '1000', engagement: '30' }] },
  { match: /COUNT\(\*\) AS count/i, rows: over.posts ?? [{ count: '4' }] },
  { match: /ORDER BY total_reach DESC/i, rows: over.top ?? [{ title: 'Spring drop', platform: 'instagram', total_reach: '800' }] },
  { match: /FILTER \(WHERE is_replied = false\)/i, rows: over.comments ?? [{ total: '9', unreplied: '3' }] },
];

async function build(period: 'week' | '30day' | '90day', platform: string, over = {}) {
  const scripted = scriptedClient(SNAPSHOT_RULES(over));
  const snapshot = await buildNarrativeSnapshot(
    TENANT_ID,
    period,
    platform,
    scripted.client as unknown as PoolClient,
  );
  return { snapshot, scripted };
}

test('the snapshot computes rates and deltas from the scripted rows', async () => {
  const { snapshot } = await build('week', 'instagram');

  assert.equal(snapshot.reach, 2000);
  assert.equal(snapshot.reachPrev, 1000);
  assert.equal(snapshot.reachDelta, 100, '(2000-1000)/1000');
  assert.equal(snapshot.engagementRate, 5, '(60+20+20)/2000');
  assert.equal(snapshot.engagementRatePrev, 3, '(20+5+5)/1000');
  assert.equal(snapshot.posts, 4);
  assert.equal(snapshot.comments, 9);
  assert.equal(snapshot.unreplied, 3);
  assert.equal(snapshot.topPost?.metric, 800);
  assert.equal(typeof snapshot.reach, 'number', 'pg strings must be coerced');
});

test('hoursSaved comes from the ONE shared estimator (S3-1)', async () => {
  // Two surfaces previously used two different constants and disagreed on the
  // same dashboard.
  const { snapshot } = await build('week', 'instagram');
  assert.equal(snapshot.hoursSaved, 4 * HOURS_PER_POST);
});

test('a period with posts but zero reach and zero engagement is NOT "has data"', async () => {
  // S3-1 again: `posts > 0` used to qualify, which let a 0-reach post render a
  // fabricated ~50 score instead of the empty state.
  const { snapshot } = await build('week', 'instagram', {
    current: [{ reach: '0', engagement: '0', watch_time_minutes: '0' }],
    prev: [{ reach: '0', engagement: '0' }],
    top: [],
  });

  assert.equal(snapshot.posts, 4, 'the posts really were published');
  assert.equal(snapshot.hasData, false, 'but there is nothing measurable to summarize');
  assert.equal(snapshot.topPost, null);
  assert.equal(computeAriesScore('week', snapshot.engagementRate, snapshot.reachDelta, snapshot.engagementRatePrev, snapshot.reach).score, 0);
});

test('a first period with no prior data reports +100%, not a divide-by-zero', async () => {
  const { snapshot } = await build('week', 'instagram', {
    prev: [{ reach: '0', engagement: '0' }],
  });
  assert.equal(snapshot.reachDelta, 100);

  const flat = await build('week', 'instagram', {
    current: [{ reach: '0', engagement: '5', watch_time_minutes: '0' }],
    prev: [{ reach: '0', engagement: '0' }],
  });
  assert.equal(flat.snapshot.reachDelta, 0, 'nothing from nothing is 0%, not 100%');
});

test('watch time is reported only where the platform measures it', async () => {
  assert.equal((await build('week', 'youtube')).snapshot.watchTimeMinutes, 90);
  assert.equal((await build('week', 'all')).snapshot.watchTimeMinutes, 90);
  assert.equal(
    (await build('week', 'instagram')).snapshot.watchTimeMinutes,
    null,
    'Instagram does not report watch time — null, not 0',
  );
});

test("platform 'all' drops the filter instead of querying a platform named 'all'", async () => {
  const { scripted } = await build('week', 'all');
  for (const call of scripted.matching(/insights_(account_metrics_daily|posts|comments)/i)) {
    assert.ok(
      !call.params.includes('all'),
      `'all' must be bound as null, not as a platform value:\n${call.sql.slice(0, 80)}`,
    );
  }

  const single = await build('week', 'instagram');
  assert.ok(
    single.scripted.matching(/COUNT\(\*\) AS count/i)[0].params.includes('instagram'),
    'a specific platform must still filter',
  );
});

test('the builder never acquires its own pooled client (AA-122)', async () => {
  // It is handed one by the handler. Acquiring a second would double this
  // section's connection cost — guardrail #1.
  const source = readFileSync(
    path.join(resolveProjectRoot(import.meta.url), 'backend', 'insights', 'narrative', 'snapshot-builder.ts'),
    'utf8',
  );
  assert.doesNotMatch(source, /pool\.connect\(/);
  assert.doesNotMatch(source, /\.release\(\)/);
});

// ── Handler ──────────────────────────────────────────────────────────────────

const narrativeReq = (qs: string) =>
  new Request(`https://x.test/api/insights/narrative?${qs}`);

const HANDLER_RULES = (cached: QueryRule['rows']): QueryRule[] => [
  { match: /FROM insights_narratives/i, rows: cached },
  { match: /INSERT INTO insights_narratives/i, rows: [] },
  ...SNAPSHOT_RULES(),
];

test('an unsupported period is rejected before any DB work', async () => {
  const mock = await withMockPool([], async (m) => {
    const res = await handleGetInsightsNarrative(narrativeReq('period=fortnight'), loader);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /Invalid period/);
    return m;
  });
  assert.equal(mock.calls.length, 0, 'a bad period must not reach the database');
  assert.equal(mock.connectCount, 0);
});

test('a cache miss builds, upserts, and answers cached:false', async () => {
  const body = await withMockPool(HANDLER_RULES([]), async (m) => {
    const res = await handleGetInsightsNarrative(narrativeReq('period=week&platform=all'), loader);
    assert.equal(res.status, 200);
    const json = await res.json();

    const [upsert] = m.matching(/INSERT INTO insights_narratives/i);
    assert.ok(upsert, 'a freshly built narrative must be persisted');
    assert.equal(upsert.params[0], TENANT_ID);
    assert.equal(upsert.params[5], TEMPLATE_VERSION, 'stamped with the current template version');
    return json;
  });

  assert.equal(body.status, 'ok');
  assert.equal(body.cached, false);
  assert.ok(body.narrative.length > 0);
  assert.equal(typeof body.score, 'number');
  assert.equal(body.periodMeta.posts, 4);
  assert.equal(body.snapshot.hasData, true);
});

test('a fresh cached row is served without rebuilding the snapshot', async () => {
  const cachedBody = { narrative: 'cached copy', score: 61, judgment: 'Building' };
  const mock = await withMockPool(
    HANDLER_RULES([{ body: cachedBody, generated_at: new Date(), model: TEMPLATE_VERSION }]),
    async (m) => {
      const res = await handleGetInsightsNarrative(narrativeReq('period=week&platform=all'), loader);
      const json = await res.json();
      assert.equal(json.cached, true);
      assert.equal(json.narrative, 'cached copy');
      assert.equal(json.score, 61);
      return m;
    },
  );

  assert.equal(mock.matching(/COUNT\(\*\) AS count/i).length, 0, 'no snapshot query on a hit');
  assert.equal(mock.matching(/INSERT INTO insights_narratives/i).length, 0, 'and no write');
});

test('a row written by an older template version is treated as a MISS', async () => {
  // This is what makes bumping TEMPLATE_VERSION actually invalidate. Without it
  // every tenant would keep reading pre-fix copy forever.
  const mock = await withMockPool(
    HANDLER_RULES([{ body: { narrative: 'stale' }, generated_at: new Date(), model: 'template-v1' }]),
    async (m) => {
      const res = await handleGetInsightsNarrative(narrativeReq('period=week&platform=all'), loader);
      assert.equal((await res.json()).cached, false);
      return m;
    },
  );
  assert.equal(mock.matching(/INSERT INTO insights_narratives/i).length, 1, 'it rebuilds and rewrites');
});

test('an expired row is a miss even though its template version is current', async () => {
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25h — past the 1h TTL
  const body = await withMockPool(
    HANDLER_RULES([{ body: { narrative: 'yesterday' }, generated_at: old, model: TEMPLATE_VERSION }]),
    async () => {
      const res = await handleGetInsightsNarrative(narrativeReq('period=week&platform=all'), loader);
      return res.json();
    },
  );
  assert.equal(body.cached, false);
  assert.notEqual(body.narrative, 'yesterday');
});

test('?force=true skips the cache READ entirely', async () => {
  const mock = await withMockPool(
    HANDLER_RULES([{ body: { narrative: 'cached copy' }, generated_at: new Date(), model: TEMPLATE_VERSION }]),
    async (m) => {
      const res = await handleGetInsightsNarrative(narrativeReq('period=week&platform=all&force=true'), loader);
      assert.equal((await res.json()).cached, false);
      return m;
    },
  );
  assert.equal(
    mock.matching(/SELECT body, generated_at, model/i).length,
    0,
    'a forced refresh must not even look at the cached row',
  );
});

test('a throttled forced refresh issues no query at all (AA-120)', async () => {
  const prevBurst = process.env.ARIES_INSIGHTS_FORCE_THROTTLE_BURST;
  const prevEnabled = process.env.ARIES_INSIGHTS_FORCE_THROTTLE_ENABLED;
  process.env.ARIES_INSIGHTS_FORCE_THROTTLE_BURST = '1';
  process.env.ARIES_INSIGHTS_FORCE_THROTTLE_ENABLED = '1';
  __resetInsightsForceThrottleForTests();

  try {
    const mock = await withMockPool(HANDLER_RULES([]), async (m) => {
      const first = await handleGetInsightsNarrative(narrativeReq('period=week&platform=all&force=true'), loader);
      assert.equal(first.status, 200, 'the allowance is spent, not denied');
      const before = m.calls.length;

      const second = await handleGetInsightsNarrative(narrativeReq('period=week&platform=all&force=true'), loader);
      assert.equal(second.status, 429);
      assert.ok(second.headers.get('Retry-After'), 'a 429 must say when to come back');
      assert.equal(m.calls.length, before, 'the denied request must cost no DB work');
      return m;
    });
    assert.ok(mock.connectCount >= 1);
  } finally {
    if (prevBurst === undefined) delete process.env.ARIES_INSIGHTS_FORCE_THROTTLE_BURST;
    else process.env.ARIES_INSIGHTS_FORCE_THROTTLE_BURST = prevBurst;
    if (prevEnabled === undefined) delete process.env.ARIES_INSIGHTS_FORCE_THROTTLE_ENABLED;
    else process.env.ARIES_INSIGHTS_FORCE_THROTTLE_ENABLED = prevEnabled;
    __resetInsightsForceThrottleForTests();
  }
});

test('the handler releases its pooled client when the build throws', async () => {
  const rules: QueryRule[] = [
    { match: /FROM insights_narratives/i, rows: [] },
    { match: /FROM business_profiles/i, rows: [{ timezone: null }] },
    { match: /watch_time_minutes/i, rows: [], throws: new Error('snapshot exploded') },
  ];
  const mock = await withMockPool(rules, async (m) => {
    await assert.rejects(() =>
      handleGetInsightsNarrative(narrativeReq('period=week&platform=all'), loader),
    );
    return m;
  });
  assert.equal(mock.connectCount, 1);
  assert.equal(mock.releaseCount, 1);
});
