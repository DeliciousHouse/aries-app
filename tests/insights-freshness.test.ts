/**
 * tests/insights-freshness.test.ts
 *
 * S1-3 / AA-82 — data-freshness stamp. Covers the pure status logic
 * (computeFreshness) against the acceptance-criteria fixtures, plus the handler
 * contract: Cache-Control: no-store and NO insights_narratives access.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFreshness, type AccountSyncRow } from '../backend/insights/freshness/freshness-logic';
import { resolveInsightsStaleMs } from '../backend/insights/freshness/config';
import { handleGetInsightsFreshness } from '../backend/insights/freshness/handler';
import pool from '../lib/db';

const NOW = new Date('2026-07-07T12:00:00.000Z');
const MIN = 60_000;
const STALE_MS = 60 * MIN; // 2 ticks
const ago = (mins: number) => new Date(NOW.getTime() - mins * MIN);

const row = (over: Partial<AccountSyncRow>): AccountSyncRow => ({
  platform: 'facebook', displayName: 'FB', latestStatus: 'ok', lastSuccessAt: ago(10), ...over,
});

test('shared insights freshness threshold defaults to two ticks and honors a positive override', () => {
  assert.equal(resolveInsightsStaleMs({}), 60 * MIN);
  assert.equal(resolveInsightsStaleMs({ ARIES_INSIGHTS_STALE_MINUTES: '90' }), 90 * MIN);
  assert.equal(resolveInsightsStaleMs({ ARIES_INSIGHTS_STALE_MINUTES: 'invalid' }), 60 * MIN);
});

test('fresh: recent ok sync → status fresh, dataAsOf = that sync', () => {
  const r = computeFreshness([row({ lastSuccessAt: ago(10), latestStatus: 'ok' })], NOW, STALE_MS);
  assert.equal(r.status, 'fresh');
  assert.equal(r.dataAsOf, ago(10).toISOString());
});

test('least-fresh account wins: FB 5m + IG 3h → stale, dataAsOf = the OLDER (IG)', () => {
  const r = computeFreshness([
    row({ platform: 'facebook',  lastSuccessAt: ago(5),   latestStatus: 'ok' }),
    row({ platform: 'instagram', lastSuccessAt: ago(180), latestStatus: 'ok' }),
  ], NOW, STALE_MS);
  assert.equal(r.status, 'stale');
  assert.equal(r.dataAsOf, ago(180).toISOString()); // reflects the least-fresh channel
});

test('failed latest run is NOT a silent fresh stamp → stale (even with an older success)', () => {
  const r = computeFreshness([
    row({ lastSuccessAt: ago(20), latestStatus: 'failed' }), // synced 20m ago, but the LATEST run failed
  ], NOW, STALE_MS);
  assert.equal(r.status, 'stale');
});

test('partial latest run, recent → partial (does not overclaim fresh)', () => {
  const r = computeFreshness([row({ lastSuccessAt: ago(10), latestStatus: 'partial' })], NOW, STALE_MS);
  assert.equal(r.status, 'partial');
  assert.ok(r.dataAsOf);
});

test('a connected account that never synced forces least-fresh → stale', () => {
  const r = computeFreshness([
    row({ platform: 'facebook',  lastSuccessAt: ago(5),  latestStatus: 'ok' }),
    row({ platform: 'instagram', lastSuccessAt: null,     latestStatus: null }),
  ], NOW, STALE_MS);
  assert.equal(r.status, 'stale');
});

test('never_synced: no runs at all → never_synced, no timestamp', () => {
  const r = computeFreshness([row({ lastSuccessAt: null, latestStatus: null })], NOW, STALE_MS);
  assert.equal(r.status, 'never_synced');
  assert.equal(r.dataAsOf, null);
});

test('no connected accounts → never_synced', () => {
  const r = computeFreshness([], NOW, STALE_MS);
  assert.equal(r.status, 'never_synced');
});

test('handler sets Cache-Control: no-store and never queries insights_narratives', async () => {
  const original = pool.query;
  const seenSql: string[] = [];
  // Timestamp relative to the REAL clock — the handler uses new Date(), not the fixture NOW.
  const tenMinAgo = new Date(Date.now() - 10 * MIN);
  (pool as any).query = async (sql: string) => {
    seenSql.push(String(sql));
    return { rows: [{ platform: 'facebook', display_name: 'FB', latest_status: 'ok', last_success_at: tenMinAgo }] };
  };
  try {
    const loader = async () => ({ tenantId: '1', tenantSlug: 't', role: 'tenant_admin', userId: '1' }) as any;
    const res = await handleGetInsightsFreshness(
      new Request('https://x.test/api/insights/freshness'), loader as any,
    );
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body: any = await res.json();
    assert.equal(body.status, 'fresh');
    // The uncached contract: it must read sync tables only, never the cache table.
    assert.ok(seenSql.length > 0, 'expected a query');
    for (const sql of seenSql) {
      assert.doesNotMatch(sql, /insights_narratives/i, 'freshness must not touch the narrative cache');
      assert.match(sql, /insights_sync_runs|insights_accounts/i);
    }
  } finally {
    (pool as any).query = original;
  }
});
