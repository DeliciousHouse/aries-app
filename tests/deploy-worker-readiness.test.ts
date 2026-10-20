import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureClaimsTable } from '../scripts/automations/weekly-job-trigger-worker';

test('protects read-only weekly startup; fails_when DDL or missing constraints accepted; no_claim restored compatibility', async () => {
  const queries: string[] = [];
  await ensureClaimsTable({ query: async (sql) => {
    queries.push(sql);
    return { rows: [{ ready: true }] };
  } });
  assert.equal(queries.length, 1);
  assert.doesNotMatch(queries[0], /\b(CREATE|ALTER|DROP)\b/i);
  assert.match(queries[0], /pg_constraint/);
  for (const rows of [[], [{ ready: false }], [{ ready: null }], [{ ready: true }, { ready: true }]]) {
    await assert.rejects(ensureClaimsTable({ query: async () => ({ rows }) }), /claims schema not ready/);
  }
  await assert.rejects(ensureClaimsTable({ query: async () => { throw new Error('unavailable'); } }), /unavailable/);
});
