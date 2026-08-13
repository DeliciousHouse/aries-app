/**
 * tests/insights-metric-agreement.test.ts
 *
 * Regression coverage for AA-230 and AA-231 — two "one reader disagreed with
 * its siblings" bugs found in the same S4-2/AA-105 metrics-agreement sweep:
 *
 *   AA-230 — read-api.ts was the only LATEST_POST_METRICS_LATERAL consumer
 *            still reading a bare `views` column instead of the reach-
 *            preferring `COALESCE(reach, views, 0)` every sibling reader
 *            uses. On Instagram (which writes both columns) this made
 *            /dashboard/analytics disagree with /insights by ~9% for the
 *            same tenant/window.
 *
 *   AA-231 — narrative/snapshot-builder.ts summed likes+comments_count+shares
 *            in JS for engagementRate, which Facebook's adapter always writes
 *            as literal 0 (the real number lives only in the dedicated
 *            `engagement` column). engagementRate — and the engagement term
 *            of the headline Aries Score — was therefore always exactly 0 for
 *            every Facebook tenant. This was the THIRD time the same bug was
 *            fixed in isolation (read-api.ts, trends-snapshot-builder.ts had
 *            already grown their own COALESCE(engagement, …) expressions).
 *
 * Both fixes are "use the shared, correct SQL expression everywhere" fixes,
 * so the highest-value regression here is not "the fixed file returns the
 * right number" but "no reader can drift apart again": a source-level scan
 * across backend/insights/** (the idiom tests/insights-dashboard-ui.test.ts
 * already established for this repo), paired with a behavioural fixture over
 * the mocked pool that reproduces the exact shape that diverged in prod, plus
 * a cross-section agreement check (Hero vs Trends) — the guard that would
 * have caught all three AA-231 instances instead of two silent repeats.
 *
 * Mocked pool / scripted client (tests/helpers/mock-pool.ts) — no Postgres.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/insights-metric-agreement.test.ts
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
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

import {
  handleGetInsightsSummary,
  handleGetInsightsPosts,
  handleGetInsightsAccountMetrics,
} from '../backend/insights/read-api';
import { __resetInsightsMicroCacheForTests } from '../backend/insights/micro-cache';
import { accountEngagementSql } from '../backend/insights/account-engagement-sql';
import { buildNarrativeSnapshot } from '../backend/insights/narrative/snapshot-builder';
import { buildTrendsSnapshot } from '../backend/insights/trends/trends-snapshot-builder';
import type { PoolClient } from '../lib/db';
import type { TenantContextLoader } from '../lib/tenant-context-http';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const INSIGHTS_ROOT = path.join(PROJECT_ROOT, 'backend', 'insights');

const TENANT_ID = 7;
const loader = stubTenantLoader(TENANT_ID) as unknown as TenantContextLoader;
const req = (route: string, qs = '') =>
  new Request(`https://x.test/api/insights/${route}${qs ? `?${qs}` : ''}`);

test.beforeEach(() => __resetInsightsMicroCacheForTests());

// ── Source scan helpers ─────────────────────────────────────────────────────

function stripJsComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Recursively collect .ts files under backend/insights, excluding adapters/
 * (per-platform raw metric extraction — writes what the platform reported,
 * makes no "which total does the operator see" decision) and sync/ (the
 * dispatcher UPSERTs raw column values; a writer, not a reader deciding
 * between reach and views). Neither directory can reproduce this bug's shape.
 */
function collectInsightsSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'adapters' || entry === 'sync') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectInsightsSourceFiles(full, acc);
    } else if (entry.endsWith('.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

function relPath(f: string): string {
  return path.relative(PROJECT_ROOT, f).split(path.sep).join('/');
}

const ALL_INSIGHTS_FILES = collectInsightsSourceFiles(INSIGHTS_ROOT);

/** Files whose (comment-stripped) source touches a bare `m.views` or a bare
 *  SUM(views)/AVG(views) over the metrics tables. */
const VIEWS_TOUCHING_FILES = ALL_INSIGHTS_FILES
  .filter((f) => {
    const src = stripJsComments(readFileSync(f, 'utf8'));
    return /\bm\.views\b/.test(src) || /\b(SUM|AVG)\(\s*views\s*\)/.test(src);
  })
  .map(relPath)
  .sort();

/** The deliberate exception: export-datasets.ts exposes `reach` AND `views`
 *  as SEPARATE raw CSV columns (an operator's export, not a derived "the"
 *  total) — see the golden-pin test below. Every other reader must prefer
 *  reach. */
const RAW_DUAL_COLUMN_EXPORT = 'backend/insights/export/export-datasets.ts';

/** The known, triaged set of readers that touch the raw columns. Pinned so a
 *  NEW reader can't start reading bare `views` without this test forcing a
 *  decision: either it reach-prefers (join the "must reach-prefer" set
 *  implicitly, since every file here except the export is checked below) or
 *  it is a deliberate raw-column export (extend RAW_DUAL_COLUMN_EXPORT-style
 *  exemption explicitly, with the same golden pin). */
const EXPECTED_VIEWS_TOUCHING_FILES = [
  'backend/insights/activity/activity-snapshot-builder.ts',
  'backend/insights/attention/attention-snapshot-builder.ts',
  RAW_DUAL_COLUMN_EXPORT,
  'backend/insights/goal/goal-snapshot-builder.ts',
  'backend/insights/narrative/snapshot-builder.ts',
  'backend/insights/read-api.ts',
  'backend/insights/top/top-snapshot-builder.ts',
  'backend/insights/trends/trends-snapshot-builder.ts',
].sort();

// ── AA-230: source-level "no reader can drift apart again" scan ────────────

test('AA-230: the set of files reading the raw reach/views columns is fully accounted for (no untriaged reader)', () => {
  assert.deepEqual(
    VIEWS_TOUCHING_FILES,
    EXPECTED_VIEWS_TOUCHING_FILES,
    'a new file reading `views`/`m.views` was added without being triaged here as ' +
      'either a reach-preferring reader or a deliberate raw-column export',
  );
});

test('AA-230: every per-post `m.views` reference is reach-preferring, except the deliberate raw CSV export', () => {
  for (const relFile of VIEWS_TOUCHING_FILES) {
    if (relFile === RAW_DUAL_COLUMN_EXPORT) continue;
    const src = stripJsComments(readFileSync(path.join(PROJECT_ROOT, relFile), 'utf8'));
    const matches = [...src.matchAll(/\bm\.views\b/g)];
    for (const m of matches) {
      const before = src.slice(Math.max(0, (m.index ?? 0) - 20), m.index ?? 0);
      assert.match(
        before,
        /m\.reach,\s*$/,
        `${relFile}: found "m.views" not immediately preceded by "m.reach, " — a bare ` +
          `per-post views read reintroduces the exact AA-230 disagreement`,
      );
    }
  }
});

test('AA-230: no reader sums the raw account-level `views` column outside the sanctioned reach-preferring COALESCE', () => {
  for (const relFile of VIEWS_TOUCHING_FILES) {
    if (relFile === RAW_DUAL_COLUMN_EXPORT) continue;
    const src = stripJsComments(readFileSync(path.join(PROJECT_ROOT, relFile), 'utf8'));
    assert.doesNotMatch(
      src,
      /\b(SUM|AVG)\(\s*views\s*\)/,
      `${relFile}: found a bare SUM(views)/AVG(views) — every account-level total must ` +
        `read COALESCE(reach, views, 0), never the raw column alone`,
    );
  }
});

test('the raw CSV export deliberately keeps reach and views as SEPARATE columns, not merged into a fabricated total', () => {
  // Golden pin: this file is exempt from "must reach-prefer" ONLY because it
  // exports both real columns side by side for the operator's own inspection.
  // If someone "fixes" it to a single merged total, CSV consumers silently
  // lose the `views` column — this pin makes that an intentional, reviewed
  // change rather than an accidental drift.
  const src = readFileSync(path.join(PROJECT_ROOT, RAW_DUAL_COLUMN_EXPORT), 'utf8');
  assert.match(src, /COALESCE\(m\.reach,\s*0\)\s*AS reach/);
  assert.match(src, /COALESCE\(m\.views,\s*0\)\s*AS views/);
  assert.match(src, /COALESCE\(SUM\(views\),\s*0\)\s*AS views/);
  assert.match(src, /COALESCE\(SUM\(reach\),\s*0\)\s*AS reach/);
});

// ── AA-230: behavioural cross-reader agreement (mocked pool) ────────────────
//
// The exact shape that diverged in prod: Instagram writes BOTH reach and
// views, and reach is the number /insights already showed. A reader that
// selected bare `views` would answer 250; the fix must answer 100 — reach.
// The paired fixture (reach IS NULL, views populated) is the Facebook shape,
// which must still fall back to views rather than reporting a fabricated 0.

/** Mirrors Postgres' COALESCE(reach, views, 0) exactly, so a fixture's value
 *  can never accidentally diverge from what the query is supposed to compute. */
function coalesceReachViews(reach: number | null, views: number): number {
  return reach ?? views;
}

test('AA-230: summary reports reach over views for the Instagram shape (reach=100, views=250 -> 100)', async () => {
  const rules: QueryRule[] = [
    TIMEZONE_RULE,
    {
      match: /AS total_reach/i,
      rows: [{
        total_reach: String(coalesceReachViews(100, 250)),
        current_followers: '0', followers_gained: '0', total_likes: '0',
        total_comments: '0', total_shares: '0', total_watch_time_minutes: '0',
        total_engagement: '0',
      }],
    },
  ];
  const mock = await withMockPool(rules, async (m) => {
    const res = await handleGetInsightsSummary(req('summary'), loader);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.totalReach, 100, 'reach must win over the higher views count');
    return m;
  });

  const [call] = mock.matching(/AS total_reach/i);
  assert.match(
    call.sql,
    /COALESCE\(reach,\s*views,\s*0\)/,
    'the query text itself must be reach-preferring, tying the fixture to the real expression',
  );
});

test('AA-230: summary falls back to views for the Facebook shape (reach=null, views=250 -> 250)', async () => {
  const rules: QueryRule[] = [
    TIMEZONE_RULE,
    {
      match: /AS total_reach/i,
      rows: [{
        total_reach: String(coalesceReachViews(null, 250)),
        current_followers: '0', followers_gained: '0', total_likes: '0',
        total_comments: '0', total_shares: '0', total_watch_time_minutes: '0',
        total_engagement: '0',
      }],
    },
  ];
  const body = await withMockPool(rules, async () => {
    const res = await handleGetInsightsSummary(req('summary'), loader);
    return res.json();
  });
  assert.equal(body.totalReach, 250, 'a platform with no reach column must never report 0');
});

test('AA-230: posts reports reach over views per-post for the Instagram shape', async () => {
  const rules: QueryRule[] = [{
    match: /FROM insights_posts p/i,
    rows: [{
      id: 41, platform: 'instagram', external_post_id: 'ig_1', title: 'Spring drop',
      media_type: 'image', published_at: new Date('2026-07-01T10:00:00Z'),
      permalink: null, duration_seconds: null, platform_data: null,
      total_reach: String(coalesceReachViews(100, 250)),
      total_likes: '0', total_comments: '0', total_shares: '0', avg_view_percentage: null,
    }],
  }];
  const mock = await withMockPool(rules, async (m) => {
    const res = await handleGetInsightsPosts(req('posts'), loader);
    const body = await res.json();
    assert.equal(body.posts[0].metrics.totalReach, 100);
    return m;
  });

  const [call] = mock.matching(/FROM insights_posts p/i);
  assert.match(call.sql, /COALESCE\(m\.reach,\s*m\.views,\s*0\)/);
});

test('AA-230: account-metrics series falls back to views for the Facebook shape (third fixed SQL site)', async () => {
  const rules: QueryRule[] = [
    TIMEZONE_RULE,
    {
      match: /GROUP BY date, platform/i,
      rows: [{
        date: '2026-07-01', platform: 'facebook',
        reach: String(coalesceReachViews(null, 250)),
        watch_time_minutes: '0', followers: '0', followers_delta: '0',
        likes: '0', comments_count: '0', shares: '0',
      }],
    },
  ];
  const mock = await withMockPool(rules, async (m) => {
    const res = await handleGetInsightsAccountMetrics(req('account-metrics'), loader);
    const body = await res.json();
    assert.equal(body.series[0].reach, 250, 'facebook (no reach column) still needs its views total');
    return m;
  });

  const [call] = mock.matching(/GROUP BY date, platform/i);
  assert.match(call.sql, /AS reach/i, 'the wire field must be named `reach`, not `views` (the AA-230 rename)');
  assert.match(call.sql, /COALESCE\(reach,\s*views,\s*0\)/);
});

// ── AA-231: Facebook engagement (behavioural, narrative Hero) ──────────────

const NARRATIVE_RULES = (over: Record<string, QueryRule['rows']> = {}): QueryRule[] => [
  TIMEZONE_RULE,
  { match: /watch_time_minutes/i, rows: over.current ?? [] },
  { match: /date < \$3::date/i, rows: over.prev ?? [{ reach: '0', engagement: '0' }] },
  { match: /COUNT\(\*\) AS count/i, rows: over.posts ?? [{ count: '3' }] },
  { match: /ORDER BY total_reach DESC/i, rows: over.top ?? [] },
  { match: /FILTER \(WHERE is_replied = false\)/i, rows: over.comments ?? [{ total: '0', unreplied: '0' }] },
];

test('AA-231: a Facebook-shaped account (per-column zeros, real number only in `engagement`) reports a non-zero engagementRate', async () => {
  // The exact shape adapters/facebook/index.ts writes: likes/comments_count/
  // shares are literal 0, the real total lives only in the dedicated
  // `engagement` aggregate. The row carries BOTH the old per-column fields
  // AND the new `engagement` aggregate so this fixture is faithful to a
  // revert too: pre-fix code summed the three zeros in JS and NEVER looked
  // at `engagement` -> always exactly 0 (not merely "some wrong number").
  const scripted = scriptedClient(NARRATIVE_RULES({
    current: [{
      reach: '1000', engagement: '210', watch_time_minutes: '0',
      likes: '0', comments_count: '0', shares: '0',
    }],
  }));
  const snapshot = await buildNarrativeSnapshot(
    TENANT_ID, 'week', 'facebook', scripted.client as unknown as PoolClient,
  );

  assert.equal(snapshot.engagementRate, 21, '210/1000 must be reported, not the always-0 per-column sum');
  assert.ok(snapshot.engagementRate > 0, 'the historical bug value was exactly 0 for every Facebook tenant');

  // Structural pin: the SQL actually sent must nest the shared expression
  // INSIDE the SUM (per-row resolution), not wrap a plain SUM(engagement) in
  // an outer COALESCE (which would silently drop every NULL-engagement row in
  // a mixed FB+IG tenant instead of falling back to that row's own per-column
  // sum). This is the exact distinction the ticket calls load-bearing.
  const engagementCalls = scripted.matching(/AS engagement/i);
  assert.equal(engagementCalls.length, 2, 'current + previous period queries both select `engagement`');
  for (const call of engagementCalls) {
    assert.ok(
      call.sql.includes(`SUM(${accountEngagementSql()})`),
      `expected SUM(${accountEngagementSql()}) inside the query text, got:\n${call.sql}`,
    );
  }
});

test('AA-231: a non-Facebook platform (engagement column unavailable) computes the same engagementRate as before the change', async () => {
  // Instagram/YouTube never populate the dedicated `engagement` aggregate;
  // Postgres' COALESCE falls through to the unchanged per-column sum. This
  // fixture supplies the value AS the query would already have resolved it
  // (60+20+20=100 over reach 2000 -> 5%), proving the fallback path is
  // unchanged for platforms that never had the bug. The row also carries the
  // old per-column fields at the same totals, so a revert computes the
  // identical 5% independently — this fixture is byte-identical pre/post fix.
  const scripted = scriptedClient(NARRATIVE_RULES({
    current: [{
      reach: '2000', engagement: '100', watch_time_minutes: '90',
      likes: '60', comments_count: '20', shares: '20',
    }],
  }));
  const snapshot = await buildNarrativeSnapshot(
    TENANT_ID, 'week', 'instagram', scripted.client as unknown as PoolClient,
  );
  assert.equal(snapshot.engagementRate, 5, '(60+20+20)/2000 — unchanged from before the AA-231 fix');
});

// ── AA-231: cross-section agreement (Hero vs Trends) ────────────────────────
//
// The bug was fixed twice in isolation before this third instance — the guard
// that would have caught all three is asserting two INDEPENDENT sections
// agree on the same underlying totals, not re-pinning one section's math.

function utcDayStart(daysAgo: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d;
}
const dayKey = (daysAgo: number) => utcDayStart(daysAgo).toISOString().slice(0, 10);

// Facebook-shaped totals: current period reach=1000 / engagement=210 (21%),
// prior period reach=500 / engagement=100 (20%). Both builders are fed the
// SAME totals so any disagreement in the computed rate is the regression.
const TRENDS_RULES: QueryRule[] = [
  // 1. Account-level current+prior series (one query, both windows).
  {
    match: /AS bucket[\s\S]*FROM insights_account_metrics_daily/i,
    rows: [
      { bucket: dayKey(7), reach: '1000', followers: '0', visits: '0', comments: '0', interactions: '210' },
      { bucket: dayKey(14), reach: '500', followers: '0', visits: '0', comments: '0', interactions: '100' },
    ],
  },
  // 2. Comments series (from insights_comments, not the account column).
  { match: /AS bucket[\s\S]*FROM insights_comments\b/i, rows: [] },
  // 3. Platform breakdown (current period only).
  {
    match: /GROUP BY platform/i,
    rows: [{ platform: 'facebook', reach: '1000', followers: '0', visits: '0', comments: '0', interactions: '210', base_reach: '1000' }],
  },
  // 4. Per-platform comment counts.
  { match: /ORDER BY comments DESC/i, rows: [] },
  // 5. Post count.
  { match: /SELECT COUNT\(\*\) AS count[\s\S]*FROM insights_posts\b/i, rows: [{ count: '3' }] },
  // 6. Unreplied comments.
  { match: /is_replied\s*=\s*false/i, rows: [{ count: '0' }] },
  // 7. Sentiment distribution.
  { match: /insights_comment_classifications/i, rows: [] },
  // 8. Top post title.
  { match: /SELECT p\.title/i, rows: [] },
  // 9. Follower base (AA-246) — CURRENT_FOLLOWERS_SUM_SQL, reused from
  //    read-api.ts. Not exercised by this test's assertions (which are about
  //    engagementRate agreement), so an arbitrary non-zero value is fine.
  { match: /current_followers/i, rows: [{ current_followers: '2' }] },
  // 10. Catch-all: the 90-day engagement baseline (no GROUP BY/ORDER BY marker
  //    of its own — must stay LAST so the more specific rules above win).
  {
    match: /AS interactions[\s\S]*AS base_reach[\s\S]*FROM insights_account_metrics_daily/i,
    rows: [{ interactions: '210', base_reach: '1000' }],
  },
];

test('AA-231: Hero (narrative) and Trends compute the SAME engagementRate off matching totals', async () => {
  const heroScripted = scriptedClient(NARRATIVE_RULES({
    current: [{
      reach: '1000', engagement: '210', watch_time_minutes: '0',
      likes: '0', comments_count: '0', shares: '0',
    }],
    prev: [{ reach: '500', engagement: '100', likes: '0', comments_count: '0', shares: '0' }],
  }));
  const hero = await buildNarrativeSnapshot(
    TENANT_ID, 'week', 'facebook', heroScripted.client as unknown as PoolClient,
  );

  const trendsScripted = scriptedClient(TRENDS_RULES);
  const trends = await buildTrendsSnapshot(
    TENANT_ID, 'week', 'facebook', trendsScripted.client as unknown as PoolClient,
  );

  assert.equal(hero.engagementRate, 21);
  assert.equal(trends.engagement.value, 21);
  assert.equal(
    hero.engagementRate, trends.engagement.value,
    'Hero and Trends must report the same engagement rate off the same underlying totals — ' +
      'this is the cross-section guard that would have caught all three AA-231 instances',
  );

  // Bonus: the previous-period rates agree too (20%).
  assert.equal(hero.engagementRatePrev, 20);
  assert.equal(trends.engagement.valuePrev, 20);

  // Structural pin: all three Trends call sites nest accountEngagementSql(true)
  // (Trends includes saves — the one deliberate, documented difference from
  // Hero/read-api) directly inside SUM(...).
  const interactionCalls = trendsScripted.matching(/AS interactions/i);
  assert.equal(interactionCalls.length, 3, 'series + platform-breakdown + baseline queries all select interactions');
  for (const call of interactionCalls) {
    assert.ok(
      call.sql.includes(`SUM(${accountEngagementSql(true)})`),
      `expected SUM(${accountEngagementSql(true)}) inside the query text, got:\n${call.sql}`,
    );
  }
});

// ── accountEngagementSql unit coverage ───────────────────────────────────────

test('accountEngagementSql: default (includeSaves=false) prefers the aggregate, falls back to likes+comments+shares', () => {
  assert.equal(
    accountEngagementSql(),
    'COALESCE(engagement, COALESCE(likes, 0) + COALESCE(comments_count, 0) + COALESCE(shares, 0))',
  );
  assert.equal(accountEngagementSql(false), accountEngagementSql());
});

test('accountEngagementSql: includeSaves=true additionally folds saves into the fallback sum (Trends only)', () => {
  assert.equal(
    accountEngagementSql(true),
    'COALESCE(engagement, COALESCE(likes, 0) + COALESCE(comments_count, 0) + COALESCE(saves, 0) + COALESCE(shares, 0))',
  );
});

test('accountEngagementSql: the COALESCE sits INSIDE the SUM, never the other way around', () => {
  // SUM(COALESCE(engagement, fallback)) resolves per ROW, so a mixed FB+IG
  // tenant correctly falls back to the per-column sum on IG rows while still
  // reading the real aggregate on FB rows. COALESCE(SUM(engagement), SUM(fallback))
  // would instead let Postgres's SUM silently ignore every NULL-engagement
  // (non-Facebook) row, discarding that platform's per-column contribution
  // entirely whenever ANY row in the group has a non-null engagement. A test
  // that only checks the returned STRING (not where callers place it) would
  // pass under either form — this is why every call-site test above also
  // asserts on the captured SQL text, not just accountEngagementSql()'s output.
  const expr = accountEngagementSql();
  assert.ok(expr.startsWith('COALESCE(engagement,'), 'engagement must be the FIRST COALESCE argument (preferred)');
  assert.doesNotMatch(expr, /^SUM\(/, 'accountEngagementSql must never wrap itself in SUM — callers own the SUM(...)');
});
