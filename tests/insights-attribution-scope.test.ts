/**
 * tests/insights-attribution-scope.test.ts
 *
 * S4-1 / AA-104 — the Activity + Top attribution scope decision.
 *
 * The load-bearing property is the one #785 broke: a section must never
 * re-empty because it was scoped to `aries_post_id IS NOT NULL` on a tenant
 * whose history is not stamped. Every case below either proves the scoped set
 * is non-empty or proves we fell back to all-channel.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/insights-attribution-scope.test.ts
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_ATTRIBUTION_COVERAGE_THRESHOLD,
  resolveAttributionCoverageThreshold,
  resolveAttributionScope,
  type AttributionQueryable,
} from '../backend/insights/attribution-scope';
import { isAttributionScopeEnabled } from '../backend/insights/attribution-scope-env';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** A queryable that answers the coverage COUNT with fixed numbers. */
function countingDb(
  totalPosts: number,
  attributedPosts: number,
  onQuery?: (sql: string, params?: unknown[]) => void,
): AttributionQueryable {
  return {
    async query<T>(sql: string, params?: unknown[]) {
      onQuery?.(sql, params);
      return {
        rows: [
          { total_posts: String(totalPosts), attributed_posts: String(attributedPosts) },
        ] as unknown as T[],
        rowCount: 1,
      };
    },
  };
}

function throwingDb(message: string): AttributionQueryable {
  return {
    async query<T>(): Promise<{ rows: T[]; rowCount?: number | null }> {
      throw new Error(message);
    },
  };
}

// `enabled: true` on the shared base: the scope decision below is what these
// tests are about. The shipped default is OFF and has its own block at the end.
const BASE = {
  tenantId: 7,
  fromDate: new Date('2026-07-01T00:00:00Z'),
  platformFilter: null,
  enabled: true,
};

// ── Threshold resolution ──────────────────────────────────────────────────────

test('threshold defaults when the env var is unset or blank', () => {
  assert.equal(resolveAttributionCoverageThreshold(undefined), DEFAULT_ATTRIBUTION_COVERAGE_THRESHOLD);
  assert.equal(resolveAttributionCoverageThreshold('   '), DEFAULT_ATTRIBUTION_COVERAGE_THRESHOLD);
});

test('threshold accepts a valid fraction, including the 0 and 1 bounds', () => {
  assert.equal(resolveAttributionCoverageThreshold('0.5'), 0.5);
  assert.equal(resolveAttributionCoverageThreshold(' 0.95 '), 0.95);
  assert.equal(resolveAttributionCoverageThreshold('0'), 0);
  assert.equal(resolveAttributionCoverageThreshold('1'), 1);
});

test('threshold falls back rather than trusting an out-of-range or unparseable value', () => {
  for (const bad of ['-0.1', '1.5', 'eighty percent', '80%', 'NaN', 'Infinity']) {
    assert.equal(
      resolveAttributionCoverageThreshold(bad),
      DEFAULT_ATTRIBUTION_COVERAGE_THRESHOLD,
      `expected fallback for ${bad}`,
    );
  }
});

// ── Scope decision ────────────────────────────────────────────────────────────

test('a well-attributed window scopes to Aries-published posts', async () => {
  const result = await resolveAttributionScope({
    ...BASE,
    db: countingDb(10, 9),
    threshold: 0.8,
  });

  assert.equal(result.scope, 'aries');
  assert.equal(result.attributedOnly, true);
  assert.equal(result.totalPosts, 10);
  assert.equal(result.attributedPosts, 9);
  assert.equal(result.coverage, 0.9);
  assert.equal(result.threshold, 0.8);
});

test('coverage exactly at the threshold is trusted', async () => {
  const result = await resolveAttributionScope({ ...BASE, db: countingDb(5, 4), threshold: 0.8 });
  assert.equal(result.scope, 'aries');
});

test('a thinly attributed window falls back to all-channel', async () => {
  const result = await resolveAttributionScope({ ...BASE, db: countingDb(10, 3), threshold: 0.8 });

  assert.equal(result.scope, 'all-channel');
  assert.equal(result.attributedOnly, false);
  // The counts are still reported so the UI can explain the fallback.
  assert.equal(result.totalPosts, 10);
  assert.equal(result.attributedPosts, 3);
  assert.equal(result.coverage, 0.3);
});

test('unstamped history (the #785 regression) falls back instead of emptying the section', async () => {
  const result = await resolveAttributionScope({ ...BASE, db: countingDb(42, 0), threshold: 0.8 });

  assert.equal(result.scope, 'all-channel');
  assert.equal(result.attributedOnly, false);
  assert.equal(result.coverage, 0);
});

test('a zero threshold still cannot scope an all-unattributed window to Aries', async () => {
  // computeAttributionCoverage calls this window trustworthy (coverage 0 >= 0);
  // scoping to `aries` here would empty a section that has 42 posts in it.
  const result = await resolveAttributionScope({ ...BASE, db: countingDb(42, 0), threshold: 0 });

  assert.equal(result.scope, 'all-channel');
  assert.equal(result.attributedOnly, false);
});

test('a zero threshold does scope when at least one post is attributed', async () => {
  const result = await resolveAttributionScope({ ...BASE, db: countingDb(42, 1), threshold: 0 });
  assert.equal(result.scope, 'aries');
  assert.equal(result.attributedPosts, 1);
});

test('an empty window falls back to all-channel', async () => {
  const result = await resolveAttributionScope({ ...BASE, db: countingDb(0, 0), threshold: 0.8 });

  assert.equal(result.scope, 'all-channel');
  assert.equal(result.totalPosts, 0);
  assert.equal(result.coverage, 0);
});

test('scoping to Aries implies a non-empty attributed set at any threshold', async () => {
  // The property the whole ticket rests on, checked across the grid.
  for (const threshold of [0, 0.25, 0.5, 0.8, 1]) {
    for (const total of [0, 1, 5, 42]) {
      for (let attributed = 0; attributed <= total; attributed++) {
        const result = await resolveAttributionScope({
          ...BASE,
          db: countingDb(total, attributed),
          threshold,
        });
        if (result.scope === 'aries') {
          assert.ok(
            result.attributedPosts > 0,
            `scoped to aries with ${attributed}/${total} at threshold ${threshold}`,
          );
        }
      }
    }
  }
});

// ── Fail-open behavior ────────────────────────────────────────────────────────

test('a coverage query failure falls back to all-channel instead of throwing', async () => {
  const result = await resolveAttributionScope({
    ...BASE,
    db: throwingDb('connection terminated'),
    threshold: 0.8,
  });

  assert.equal(result.scope, 'all-channel');
  assert.equal(result.attributedOnly, false);
  assert.equal(result.totalPosts, 0);
  assert.equal(result.threshold, 0.8);
});

test('impossible counts from the database fall back rather than propagating', async () => {
  // attributedPosts > totalPosts makes the coverage math throw; the section
  // must still render.
  const result = await resolveAttributionScope({ ...BASE, db: countingDb(2, 5), threshold: 0.8 });

  assert.equal(result.scope, 'all-channel');
  assert.equal(result.attributedOnly, false);
});

test('a non-numeric count row falls back to all-channel', async () => {
  const db: AttributionQueryable = {
    async query<T>() {
      return {
        rows: [{ total_posts: 'not-a-number', attributed_posts: '1' }] as unknown as T[],
        rowCount: 1,
      };
    },
  };

  const result = await resolveAttributionScope({ ...BASE, db, threshold: 0.8 });
  assert.equal(result.scope, 'all-channel');
});

// ── Query shape ───────────────────────────────────────────────────────────────

test('coverage is measured over the caller window and platform filter', async () => {
  let seenSql = '';
  let seenParams: unknown[] | undefined;

  await resolveAttributionScope({
    db: countingDb(10, 9, (sql, params) => {
      seenSql = sql;
      seenParams = params;
    }),
    tenantId: 7,
    fromDate: BASE.fromDate,
    platformFilter: 'instagram',
    threshold: 0.8,
    enabled: true,
  });

  assert.match(seenSql, /FROM insights_posts/);
  assert.match(seenSql, /FILTER \(WHERE aries_post_id IS NOT NULL\)/);
  assert.match(seenSql, /published_at\s+>= \$2/);
  assert.deepEqual(seenParams, [7, BASE.fromDate, 'instagram']);
});

// ── Rollout flag (shipped default OFF) ────────────────────────────────────────

test('the scope flag is off unless explicitly enabled', () => {
  assert.equal(isAttributionScopeEnabled(undefined), false);
  assert.equal(isAttributionScopeEnabled(''), false);
  assert.equal(isAttributionScopeEnabled('0'), false);
  assert.equal(isAttributionScopeEnabled('false'), false);
  assert.equal(isAttributionScopeEnabled('off'), false);
  for (const on of ['1', 'true', 'yes', 'on', 'TRUE', ' On ']) {
    assert.equal(isAttributionScopeEnabled(on), true, `expected ${on} to enable`);
  }
});

test('with the flag off the sections keep their all-channel numbers and no query runs', async () => {
  // The load-bearing part is `queried === false`: Activity and Top must be
  // exactly what they are today, down to the DB work they do, until every
  // post-derived section moves to the same scope (see attribution-scope-env.ts).
  let queried = false;

  const result = await resolveAttributionScope({
    ...BASE,
    enabled: false,
    db: countingDb(10, 10, () => {
      queried = true;
    }),
    threshold: 0.8,
  });

  assert.equal(queried, false);
  assert.equal(result.scope, 'all-channel');
  assert.equal(result.attributedOnly, false);
  assert.equal(result.threshold, 0.8);
});

test('a fully attributed window still stays all-channel while the flag is off', async () => {
  // Perfect coverage is exactly the case that would flip the scope when the
  // flag is on, so it is the sharpest check that the gate actually gates.
  const result = await resolveAttributionScope({
    ...BASE,
    enabled: false,
    db: countingDb(25, 25),
    threshold: 0.8,
  });

  assert.equal(result.scope, 'all-channel');
  assert.equal(result.attributedOnly, false);
});
