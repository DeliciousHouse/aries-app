import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';
import {
  DISPATCH_OUTCOMES_SQL,
  WEEK_POST_RANKING_SQL,
  buildWeeklyResultsReport,
  deriveLearnings,
  type WeeklyResultsQueryable,
} from '../backend/marketing/weekly-results-report';
import {
  isoWeekParts,
  mostRecentCompletedWeek,
  parseWeekIso,
  resolveReportWeek,
} from '../backend/marketing/weekly-results-week';

test('terminal dead letters are included in the weekly failed-dispatch count', () => {
  assert.match(
    DISPATCH_OUTCOMES_SQL,
    /dispatch_status IN \('failed', 'dead_letter'\)/,
  );
});

/**
 * S5-1 / AA-110 (gap F1b) — the weekly results report builder.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/weekly-results-report.test.ts
 */

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

// ── Week boundary math ───────────────────────────────────────────────────────

test('default window is the most-recent COMPLETED Mon–Sun week in UTC', () => {
  // Wednesday 2026-08-05 → the completed week is Mon 2026-07-27 .. Sun 2026-08-02.
  const week = mostRecentCompletedWeek(new Date('2026-08-05T12:00:00Z'));
  assert.equal(week.startYmd, '2026-07-27');
  assert.equal(week.endYmd, '2026-08-02');
  assert.equal(week.start.toISOString(), '2026-07-27T00:00:00.000Z');
  // End is EXCLUSIVE — the following Monday.
  assert.equal(week.end.toISOString(), '2026-08-03T00:00:00.000Z');
});

test('the in-progress week is never reported on', () => {
  // On a Monday, the completed week is the one that ended YESTERDAY, not the
  // three-hours-old week that just started — a seven-day panel showing one day
  // of data would understate every number on it.
  const week = mostRecentCompletedWeek(new Date('2026-08-03T00:30:00Z'));
  assert.equal(week.startYmd, '2026-07-27');
  assert.equal(week.endYmd, '2026-08-02');

  // And on a Sunday (the last day of a week), that week is still in progress.
  const sunday = mostRecentCompletedWeek(new Date('2026-08-02T23:59:59Z'));
  assert.equal(sunday.endYmd, '2026-07-26');
});

test('ISO week numbering handles the year boundary', () => {
  // The ISO year is not the calendar year at the boundary — this is exactly
  // where naive week math produces a window in the wrong year.
  assert.deepEqual(isoWeekParts(new Date('2027-01-01T00:00:00Z')), { year: 2026, week: 53 });
  assert.deepEqual(isoWeekParts(new Date('2025-12-29T00:00:00Z')), { year: 2026, week: 1 });

  const w1 = parseWeekIso('2026-W01');
  assert.ok(w1);
  assert.equal(w1.startYmd, '2025-12-29', 'ISO 2026-W01 starts in December 2025');
});

test('?week override parses, round-trips, and rejects junk', () => {
  const w = parseWeekIso('2026-W31');
  assert.ok(w);
  assert.equal(w.iso, '2026-W31');
  assert.equal(w.startYmd, '2026-07-27');

  // Accepted spellings.
  assert.equal(parseWeekIso('2026-31')?.iso, '2026-W31');
  assert.equal(parseWeekIso('2026-w31')?.iso, '2026-W31');

  for (const bad of ['', '   ', 'nope', '2026', '2026-W00', '2026-W54', '1999-W01', '20260-W1']) {
    assert.equal(parseWeekIso(bad), null, `${JSON.stringify(bad)} must not parse`);
  }
});

test('a week 53 that does not exist in that ISO year is rejected, not rolled forward', () => {
  // 2027 has 52 ISO weeks. Without the round-trip check this would silently
  // resolve to 2028-W01 and report on a week nobody asked for.
  assert.equal(parseWeekIso('2027-W53'), null);
  // 2026 genuinely has 53.
  assert.equal(parseWeekIso('2026-W53')?.iso, '2026-W53');
});

test('resolveReportWeek falls back to the default week on an unusable override', () => {
  const now = new Date('2026-08-05T12:00:00Z');
  assert.equal(resolveReportWeek('garbage', now).startYmd, '2026-07-27');
  assert.equal(resolveReportWeek(null, now).startYmd, '2026-07-27');
  assert.equal(resolveReportWeek('2026-W30', now).startYmd, '2026-07-20');
});

// ── Builder over a fixture ───────────────────────────────────────────────────

type Rows = Record<string, unknown>[];

function fakeDb(handlers: {
  published?: Rows;
  outcomes?: Rows;
  reconnect?: Rows;
  availability?: Rows;
  ranking?: Rows;
}): { db: WeeklyResultsQueryable; calls: string[] } {
  const calls: string[] = [];
  const db: WeeklyResultsQueryable = {
    async query(text: string) {
      calls.push(text);
      if (text.includes('FROM posts')) return { rows: (handlers.published ?? []) as never[] };
      if (text.includes('FROM scheduled_posts')) {
        return {
          rows: (handlers.outcomes ?? [
            { skipped: 0, failed: 0, needs_reconciliation: 0 },
          ]) as never[],
        };
      }
      if (text.includes('FROM oauth_connections')) return { rows: (handlers.reconnect ?? []) as never[] };
      if (text.includes('account_count')) {
        return {
          rows: (handlers.availability ?? [{ account_count: 0, metric_row_count: 0 }]) as never[],
        };
      }
      if (text.includes('post_metrics')) return { rows: (handlers.ranking ?? []) as never[] };
      return { rows: [] as never[] };
    },
  };
  return { db, calls };
}

const NOW = new Date('2026-08-05T12:00:00Z');

// The spec's acceptance fixture: 3 published IG + 2 published FB, 1 failed
// dispatch, 1 due-undispatched, and an IG connection needing reauthorization.
const SPEC_FIXTURE = {
  published: [
    { platform: 'instagram', surface: 'feed', n: 3 },
    { platform: 'facebook', surface: 'feed', n: 2 },
  ],
  outcomes: [{ skipped: 1, failed: 1, needs_reconciliation: 0 }],
  reconnect: [{ provider: 'instagram' }],
};

test('builds the spec acceptance fixture exactly', async () => {
  const { db } = fakeDb(SPEC_FIXTURE);
  const report = await buildWeeklyResultsReport(7, { now: NOW }, db);

  assert.equal(report.published.total, 5);
  assert.deepEqual(report.published.byChannel, { instagram: 3, facebook: 2 });
  assert.deepEqual(report.published.bySurface, { feed: 5 });
  assert.equal(report.skipped.total, 1);
  assert.equal(report.blocked.failedCount, 1);
  assert.equal(report.blocked.reconnect, true);
  assert.deepEqual(report.blocked.reconnectChannels, ['instagram']);
  assert.deepEqual(report.topChannel, {
    channel: 'instagram',
    basis: 'published_count',
    value: 3,
  });
  assert.equal(report.bestPost.available, false);
  assert.equal(report.bestPost.reason, 'insights_not_connected');
  assert.equal(report.insightsConnected, false);
});

test('an unavailable ranking slot carries NO post payload', () => {
  // The honesty contract is not just a boolean — a stray postId on an
  // unavailable slot is exactly how a "guessed winner" would reach the UI.
  return buildWeeklyResultsReport(7, { now: NOW }, fakeDb(SPEC_FIXTURE).db).then((report) => {
    assert.equal(report.bestPost.post, undefined);
    assert.equal(report.weakestPost.post, undefined);
    assert.equal(JSON.stringify(report.bestPost).includes('postId'), false);
  });
});

test('reconnect is derived from oauth_connections, never from a per-post code', async () => {
  // scheduled_posts has no failure-code column; a failed dispatch alone must not
  // imply "reconnect".
  const { db } = fakeDb({
    outcomes: [{ skipped: 0, failed: 3, needs_reconciliation: 0 }],
    reconnect: [],
  });
  const report = await buildWeeklyResultsReport(7, { now: NOW }, db);
  assert.equal(report.blocked.failedCount, 3);
  assert.equal(report.blocked.reconnect, false);
  assert.deepEqual(report.blocked.reconnectChannels, []);
});

test('manual_reconciliation is its own count and is NEVER folded into blocked', async () => {
  // Those dispatches may well have reached the platform — the publish path parks
  // them precisely because the outcome is unknown. Counting them as blocked
  // would assert something untrue.
  const { db } = fakeDb({ outcomes: [{ skipped: 0, failed: 1, needs_reconciliation: 2 }] });
  const report = await buildWeeklyResultsReport(7, { now: NOW }, db);
  assert.equal(report.needsReconciliation.total, 2);
  assert.equal(report.blocked.total, 1, 'blocked counts failures only');
  assert.equal(report.blocked.failedCount, 1);
});

// ── Ranking + the A1 regression ──────────────────────────────────────────────

test('with metrics present it ranks best and weakest from ONE inverted ordering', async () => {
  const { db } = fakeDb({
    published: [{ platform: 'instagram', surface: 'feed', n: 3 }],
    availability: [{ account_count: 1, metric_row_count: 3 }],
    ranking: [
      { id: 11, platform: 'instagram', title: 'Best', caption: null, permalink: 'https://x/1', reach: '900' },
      { id: 12, platform: 'instagram', title: 'Mid', caption: null, permalink: null, reach: '400' },
      { id: 13, platform: 'instagram', title: 'Worst', caption: null, permalink: null, reach: '20' },
    ],
  });
  const report = await buildWeeklyResultsReport(7, { now: NOW }, db);

  assert.equal(report.insightsConnected, true);
  assert.equal(report.bestPost.available, true);
  assert.equal(report.bestPost.post?.postId, '11');
  assert.equal(report.bestPost.post?.reach, 900);
  assert.equal(report.weakestPost.available, true);
  assert.equal(report.weakestPost.post?.postId, '13');
  assert.equal(report.weakestPost.post?.reach, 20);
  // Basis upgrades to reach once real metrics exist.
  assert.equal(report.topChannel.basis, 'reach');
  assert.equal(report.topChannel.value, 1320);
});

test('a single ranked post is both best and weakest (truthful, not a bug)', async () => {
  const { db } = fakeDb({
    availability: [{ account_count: 1, metric_row_count: 1 }],
    ranking: [
      { id: 5, platform: 'facebook', title: 'Only', caption: null, permalink: null, reach: '50' },
    ],
  });
  const report = await buildWeeklyResultsReport(7, { now: NOW }, db);
  assert.equal(report.bestPost.post?.postId, '5');
  assert.equal(report.weakestPost.post?.postId, '5');
});

test('a connected account with zero in-window metrics does NOT rank', async () => {
  const { db } = fakeDb({ availability: [{ account_count: 1, metric_row_count: 0 }] });
  const report = await buildWeeklyResultsReport(7, { now: NOW }, db);
  assert.equal(report.insightsConnected, false);
  assert.equal(report.bestPost.reason, 'insights_not_connected');
});

test('connected with metrics but no posts in the window reports no_posts_in_window', async () => {
  const { db } = fakeDb({ availability: [{ account_count: 1, metric_row_count: 4 }], ranking: [] });
  const report = await buildWeeklyResultsReport(7, { now: NOW }, db);
  assert.equal(report.bestPost.available, false);
  assert.equal(report.bestPost.reason, 'no_posts_in_window');
});

test('A1 REGRESSION: ranking reads the LATEST snapshot, never a SUM of dated rows', () => {
  // insights_post_metrics_daily rows are lifetime-CUMULATIVE. SUMming a post's
  // dated rows inflates it ~N× over N sync days and would hand "best post" to
  // whichever post has simply been synced longest. LATEST_POST_METRICS_LATERAL
  // is the shared fix (S2-1/AA-92); this pins that the builder uses it.
  assert.match(WEEK_POST_RANKING_SQL, /LEFT JOIN LATERAL/);
  assert.match(WEEK_POST_RANKING_SQL, /ORDER BY d\.date DESC\s*\n?\s*LIMIT 1/);
  assert.doesNotMatch(WEEK_POST_RANKING_SQL, /SUM\s*\(/i, 'must never SUM per-post metrics');
  assert.doesNotMatch(WEEK_POST_RANKING_SQL, /GROUP BY/i);
});

test('the ranking window is BOUNDED at both ends', () => {
  // top-snapshot-builder ranks over `published_at >= fromDate` with no upper
  // bound — correct for a rolling period, wrong for a completed week. Reusing it
  // verbatim would silently include everything published since the week started.
  assert.match(WEEK_POST_RANKING_SQL, /p\.published_at >= \$2/);
  assert.match(WEEK_POST_RANKING_SQL, /p\.published_at <\s+\$3/);
});

test('the builder never reaches for the un-flippable #513 read path', () => {
  const source = readFileSync(
    path.join(PROJECT_ROOT, 'backend', 'marketing', 'weekly-results-report.ts'),
    'utf8',
  );

  // Assert on IMPORTS, not on any mention: the module's header deliberately
  // names these paths to record why they are not used, and a bare substring
  // check would forbid documenting the decision.
  const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  for (const forbidden of ['perf-insights-read', 'insights-513-contract', 'attribution-scope']) {
    assert.ok(
      !imports.some((i) => i.includes(forbidden)),
      `must not import ${forbidden} (imports: ${imports.join(', ')})`,
    );
  }
  assert.doesNotMatch(source, /insights513TablesPresent\(/);
  // The default-OFF attribution scope must not silently change which posts this
  // panel counts.
  assert.doesNotMatch(source, /resolveAttributionScope\(/);
  // Guardrail #1: no fan-out across pool-backed calls. Match the CALL, so the
  // header can keep explaining why the fan-out is absent.
  assert.doesNotMatch(source, /Promise\.all\(/);
});

// ── D.2: derived learning + next action ──────────────────────────────────────

const NO_ISSUES = {
  blocked: { total: 0, failedCount: 0, reconnect: false, reconnectChannels: [] },
  skipped: { total: 0, note: '' },
  needsReconciliation: { total: 0 },
  published: { total: 4 },
};

test('reconnect outranks every other next action', () => {
  const out = deriveLearnings({
    ...NO_ISSUES,
    blocked: { total: 2, failedCount: 2, reconnect: true, reconnectChannels: ['instagram'] },
    skipped: { total: 3, note: '' },
  });
  assert.match(out.nextAction?.title ?? '', /Reconnect Instagram/);
  assert.equal(out.nextAction?.href, '/dashboard/settings/channel-integrations');
  // The other conditions still surface as learnings — only the ACTION is singular.
  assert.ok(out.learnings.some((l) => l.id === 'dispatch-failures'));
  assert.ok(out.learnings.some((l) => l.id === 'skipped-posts'));
});

test('failures and skips each produce a learning when there is no reconnect', () => {
  const failed = deriveLearnings({
    ...NO_ISSUES,
    blocked: { total: 1, failedCount: 1, reconnect: false, reconnectChannels: [] },
  });
  assert.equal(failed.learnings[0].id, 'dispatch-failures');
  assert.match(failed.nextAction?.title ?? '', /failed posts/i);

  const skipped = deriveLearnings({ ...NO_ISSUES, skipped: { total: 2, note: '' } });
  assert.equal(skipped.learnings[0].id, 'skipped-posts');
});

test('learning copy agrees with itself on singular vs plural', () => {
  // Caught by rendering the real report, not by a mock: the singular branch read
  // "1 post was still waiting … after THEIR scheduled time passed."
  const one = deriveLearnings({ ...NO_ISSUES, skipped: { total: 1, note: '' } });
  const oneBody = one.learnings[0].body;
  assert.match(oneBody, /1 post was .* its scheduled time passed\./);
  assert.doesNotMatch(oneBody, /\btheir\b/, 'singular copy must not say "their"');

  const many = deriveLearnings({ ...NO_ISSUES, skipped: { total: 3, note: '' } });
  assert.match(many.learnings[0].body, /3 posts were .* their scheduled times passed\./);

  // The same agreement on the other count-bearing learnings.
  const oneFail = deriveLearnings({
    ...NO_ISSUES,
    blocked: { total: 1, failedCount: 1, reconnect: false, reconnectChannels: [] },
  });
  assert.match(oneFail.learnings[0].title, /^1 post failed/);
  const twoFail = deriveLearnings({
    ...NO_ISSUES,
    blocked: { total: 2, failedCount: 2, reconnect: false, reconnectChannels: [] },
  });
  assert.match(twoFail.learnings[0].title, /^2 posts failed/);
});

test('a clean week reports calm, not a manufactured recommendation', () => {
  const out = deriveLearnings(NO_ISSUES);
  assert.equal(out.learnings.length, 1);
  assert.equal(out.learnings[0].id, 'clean-week');
  assert.equal(out.nextAction, null, 'no invented next action on a clean week');
});

test('a quiet week (nothing scheduled) says so instead of claiming success', () => {
  const out = deriveLearnings({ ...NO_ISSUES, published: { total: 0 } });
  assert.match(out.learnings[0].title, /No posts were scheduled/);
});

test('every MVP learning is informational — findingId is always null', () => {
  // Promotion to memory arrives with the deferred D.1/E slice. A non-null
  // findingId here would render approve buttons wired to a route that does not
  // exist yet.
  const out = deriveLearnings({
    ...NO_ISSUES,
    blocked: { total: 1, failedCount: 1, reconnect: true, reconnectChannels: ['facebook'] },
    skipped: { total: 1, note: '' },
    needsReconciliation: { total: 1 },
  });
  assert.ok(out.learnings.length >= 3);
  for (const learning of out.learnings) {
    assert.equal(learning.findingId, null);
    assert.equal(learning.source, 'publish_reliability');
  }
});
