/**
 * tests/insights-goal-builder-sequential.test.ts
 *
 * S8-4 / AA-127 (gap D7) — the goal builder's four `Promise.all` sites, and the
 * convention they violated.
 *
 * WHAT WAS ACTUALLY WRONG, precisely: nothing, at runtime. All four sites issue
 * their queries through a single HELD PoolClient, and pg serialises queries on
 * one connection — so the "parallelism" was imaginary. No fan-out, no speedup.
 * It was a readability/convention problem (guardrail #1: no Promise.all around
 * DB call chains), not a performance one.
 *
 * WHY THE OBVIOUS FIX IS THE DANGEROUS ONE, and why this file exists: the
 * tempting way to "make the parallelism real" is to swap `client.query` for
 * `pool.query`. That would take a benign style violation and turn it into
 * genuine connection fan-out — 2-3 pooled connections per goal read instead of
 * one, on an endpoint that already holds a client. With DB_POOL_MAX at 10 per
 * worker that is exactly the contention guardrail #1 was written about. So the
 * assertions below pin BOTH directions: no Promise.all, and no pool.query.
 *
 * The refactor itself is behaviour-preserving, and these tests were written
 * BEFORE it to prove that: same queries, same order, same bound params. The one
 * intended difference is on the failure path — sequential `await` stops after a
 * throw instead of leaving the sibling query running — which is strictly better
 * and is pinned below.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/insights-goal-builder-sequential.test.ts
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';
import { buildGoalSnapshot } from '../backend/insights/goal/goal-snapshot-builder';
import type { PoolClient } from '../lib/db';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const SOURCE = readFileSync(
  path.join(PROJECT_ROOT, 'backend', 'insights', 'goal', 'goal-snapshot-builder.ts'),
  'utf8',
);

interface Recorded {
  sql: string;
  params: unknown[];
}

/**
 * Records every query in issue order. Returning plausible single rows keeps the
 * builder on its happy path, so the recording covers the whole goal read rather
 * than stopping at the first `rows[0]` dereference.
 */
function recordingClient(goal: string, opts: { throwOn?: RegExp } = {}) {
  const calls: Recorded[] = [];
  const client = {
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (opts.throwOn?.test(sql)) throw new Error('simulated query failure');

      if (/FROM business_profiles/i.test(sql)) {
        return {
          rows: [{ primary_goal: goal, primary_goal_source: 'explicit', goal_type: goal, timezone: 'UTC' }] as unknown as T[],
        };
      }
      // Every metric query reads exactly one aggregate row; supply all the
      // column aliases the four goal branches use.
      return {
        rows: [{ count: '4', total: '9', saves: '3', visits: null, reach: '120' }] as unknown as T[],
      };
    },
  };
  return { calls, client: client as unknown as PoolClient };
}

const GOALS = ['lead_generation', 'content_growth', 'product_sales', 'brand_awareness'] as const;

/**
 * Only the headline metric queries. Identified POSITIVELY rather than by
 * excluding `ORDER BY` — LATEST_POST_METRICS_LATERAL contains one, so an
 * exclude-filter silently dropped the product_sales reads and made the test
 * assert nothing.
 *
 * The metric queries are the ones issued after the profile lookup and before
 * the contributors read; contributors/categories both project a `metric` alias,
 * which nothing in the headline pair does.
 */
function metricQueries(calls: Recorded[]): Recorded[] {
  const out: Recorded[] = [];
  for (const call of calls) {
    if (/FROM business_profiles/i.test(call.sql)) continue;
    if (/AS metric/i.test(call.sql)) break; // contributors/categories — we are past the headline
    out.push(call);
  }
  return out;
}

// ── Behaviour is unchanged by the refactor ───────────────────────────────────

test('each goal still issues its metric queries in the same order with the same params', async () => {
  for (const goal of GOALS) {
    const { calls, client } = recordingClient(goal);
    const snapshot = await buildGoalSnapshot(1, 'week', 'all', client);

    assert.ok(snapshot, `${goal}: the builder must produce a snapshot`);
    const metrics = metricQueries(calls);

    // product_sales reads three (current saves, previous saves, profile visits);
    // the other three read a current/previous pair.
    const expected = goal === 'product_sales' ? 3 : 2;
    assert.equal(metrics.length, expected, `${goal}: expected ${expected} metric queries`);

    // Current window first, previous second — the previous-window query is the
    // one carrying the extra upper-bound parameter.
    assert.equal(metrics[0].params.length, 3, `${goal}: current window binds 3 params`);
    assert.equal(metrics[1].params.length, 4, `${goal}: previous window binds 4 (adds the upper bound)`);

    for (const call of metrics) {
      assert.equal(call.params[0], 1, `${goal}: tenant id is always $1`);
      assert.ok(
        call.params.includes(null),
        `${goal}: platform 'all' must bind null, not the string "all"`,
      );
    }
  }
});

test('product_sales still reads saves from the POST table and visits from the account table', async () => {
  // S4-2 (gap C3): the headline used to read account-level `saves`, which has no
  // writer and never will, so it showed 0 forever while the contributors list
  // underneath ranked posts BY saves. Sequentialising must not disturb which
  // table each of the three queries hits.
  const { calls, client } = recordingClient('product_sales');
  await buildGoalSnapshot(1, 'week', 'all', client);
  const [curr, prev, visits] = metricQueries(calls);

  assert.match(curr.sql, /FROM insights_posts p/, 'current saves come from the post table');
  assert.match(prev.sql, /FROM insights_posts p/, 'previous saves too');
  assert.match(visits.sql, /FROM insights_account_metrics_daily/, 'profile visits are account-level');
});

test('profile visits stay NULL rather than becoming a confident zero', async () => {
  // The query deliberately does NOT COALESCE: profile_visits has no source
  // (Meta deprecated IG profile_views), and a null secondary makes the UI omit
  // the line instead of rendering "0 profile visits" to every operator.
  const { calls, client } = recordingClient('product_sales');
  await buildGoalSnapshot(1, 'week', 'all', client);
  const visits = metricQueries(calls)[2];

  assert.match(visits.sql, /SUM\(profile_visits\)/);
  assert.doesNotMatch(visits.sql, /COALESCE\(SUM\(profile_visits\)/, 'coalescing here fabricates a 0');
});

test('a failing metric query no longer leaves its sibling running', async () => {
  // The one intended behaviour change. Under Promise.all both queries were
  // issued before either could reject; sequential await stops at the failure.
  const { calls, client } = recordingClient('brand_awareness', { throwOn: /AS reach/i });
  await assert.rejects(() => buildGoalSnapshot(1, 'week', 'all', client));

  assert.equal(
    metricQueries(calls).length,
    1,
    'the second window query must never be issued after the first throws',
  );
});

// ── The convention, pinned in both directions ────────────────────────────────

test('the goal builder contains no Promise.all over database calls', () => {
  assert.doesNotMatch(
    SOURCE,
    /Promise\.all\(/,
    'guardrail #1: no Promise.all around pool-backed call chains',
  );
});

test('and it did NOT "fix" the convention by switching to pool.query', () => {
  // This is the assertion that actually protects the connection budget. The
  // builder is HANDED a client (AA-122) and must use it; reaching for the pool
  // would open a second (and third) connection per goal read while still
  // holding the first.
  assert.doesNotMatch(SOURCE, /\bpool\.query\(/, 'the builder must use the held client');
  assert.doesNotMatch(SOURCE, /pool\.connect\(/, 'and must never acquire its own');
  assert.match(SOURCE, /client\.query</, 'all reads go through the passed-in client');
});

test('the reason is written down where the next person will look', () => {
  // Without the comment this reads as an un-optimised sequence and someone
  // "parallelises" it back — the exact regression the assertion above blocks.
  assert.match(
    SOURCE,
    /guardrail #1/i,
    'the convention must be named in the source, not only in this test',
  );
  assert.match(
    SOURCE,
    /pool\.query/,
    'and the comment must say why pool.query is the wrong fix',
  );
});
