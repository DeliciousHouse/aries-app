/**
 * tests/insights-goal-cache-invalidation.test.ts
 *
 * S1-6 / AA-85 — invalidate the cached goal section on a business-profile save,
 * so a goal edit (incl. confirming an S1-5 inferred goal) reflects on the next
 * /insights load instead of waiting out the 1h goal cache TTL.
 *
 * Covers the helper's contract (scoped DELETE, resilience, id guards) and a
 * source-level wiring guard that the authenticated save path actually calls it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { PoolClient } from 'pg';
import { invalidateGoalNarrativeCache } from '../backend/insights/goal/cache-invalidation';

interface SeenQuery { sql: string; params: unknown[] }

/** Fake PoolClient capturing queries; optionally rejects to simulate a DB error. */
function fakeClient(opts: { reject?: boolean } = {}): { client: PoolClient; seen: SeenQuery[] } {
  const seen: SeenQuery[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      seen.push({ sql: String(sql), params });
      if (opts.reject) throw new Error('simulated DB failure');
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PoolClient;
  return { client, seen };
}

test('deletes ONLY the goal section rows, scoped to the tenant', async () => {
  const { client, seen } = fakeClient();
  await invalidateGoalNarrativeCache(client, 42);

  assert.equal(seen.length, 1, 'expected exactly one query');
  const { sql, params } = seen[0];
  assert.match(sql, /DELETE\s+FROM\s+insights_narratives/i);
  assert.match(sql, /section_key\s*=\s*'goal'/i, 'must be scoped to the goal section');
  assert.match(sql, /tenant_id\s*=\s*\$1/i, 'must be scoped to the tenant');
  assert.deepEqual(params, [42]);
  // Must NOT wipe other sections' caches.
  assert.doesNotMatch(sql, /'hero'|'attention'|'trends'|'top'|'activity'/i);
});

test('resilient: a rejecting client.query does NOT throw (save survives)', async () => {
  const { client } = fakeClient({ reject: true });
  await assert.doesNotReject(
    () => invalidateGoalNarrativeCache(client, 7),
    'a cache-invalidation failure must not propagate and fail the profile save',
  );
});

test('guards a non-numeric or non-positive tenant id — issues no query', async () => {
  for (const bad of [0, -1, NaN, 'abc', '', null as unknown as number]) {
    const { client, seen } = fakeClient();
    await invalidateGoalNarrativeCache(client, bad as string | number);
    assert.equal(seen.length, 0, `expected no query for tenant id ${JSON.stringify(bad)}`);
  }
});

test('accepts a string tenant id (route passes tenantId as a string)', async () => {
  const { client, seen } = fakeClient();
  await invalidateGoalNarrativeCache(client, '13');
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].params, [13]);
});

test('wiring: the authenticated save path calls invalidateGoalNarrativeCache after the save', () => {
  const src = fs.readFileSync(new URL('../backend/tenant/business-profile.ts', import.meta.url), 'utf8');
  assert.match(src, /invalidateGoalNarrativeCache/, 'save path must invoke the invalidator');
  // It must run AFTER the profile is persisted, not before.
  const saveIdx = src.indexOf('saveBusinessProfileRecord({');
  const callIdx = src.indexOf('await invalidateGoalNarrativeCache(client, input.tenantId)');
  assert.ok(saveIdx >= 0, 'expected the save call in the update path');
  assert.ok(callIdx > saveIdx, 'invalidation must be wired AFTER saveBusinessProfileRecord');
});
