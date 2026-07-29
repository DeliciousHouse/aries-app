/**
 * AA-161 — retention half of the usage time-series layer.
 *
 * The one unrecoverable mistake available here is deleting usage history that was
 * never aggregated, so these tests pin the guards rather than the happy path:
 *   - no rollup watermark => delete NOTHING (fail closed);
 *   - the cutoff is min(now - retention, watermark - re-roll overlap), so a raw
 *     row at or above the point the rollup may still re-read is never destroyed;
 *   - dry-run issues counts only;
 *   - daily/monthly aggregates are never swept ("kept indefinitely");
 *   - the delete loop is batched and bounded.
 *
 * Fully in-memory: the db handle is injected, no Postgres is touched.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COUNT_EXPIRED_HOURLY_SQL,
  COUNT_EXPIRED_RAW_SQL,
  DELETE_EXPIRED_HOURLY_SQL,
  DELETE_EXPIRED_RAW_SQL,
  runUsageRetentionSweep,
} from '@/backend/telemetry/usage-retention';

type Call = { sql: string; params: unknown[] };

function fakeDb(responder?: (sql: string) => { rows?: unknown[]; rowCount?: number } | undefined) {
  const calls: Call[] = [];
  return {
    calls,
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      const res = responder?.(sql);
      return { rows: res?.rows ?? [], rowCount: res?.rowCount ?? 0 };
    },
  };
}

const at = (iso: string) => () => new Date(iso);

function watermarkAt(iso: string | null, extra?: (sql: string) => { rows?: unknown[]; rowCount?: number } | undefined) {
  return (sql: string) => {
    if (sql.includes('FROM usage_rollup_state')) {
      return { rows: iso ? [{ rolled_through: iso }] : [] };
    }
    return extra?.(sql);
  };
}

function deleteCalls(calls: Call[]): Call[] {
  return calls.filter((c) => c.sql.trimStart().startsWith('DELETE'));
}

test('deletes nothing when the rollup has never run', async () => {
  const db = fakeDb(watermarkAt(null));

  const report = await runUsageRetentionSweep(db, {
    dryRun: false,
    now: at('2026-07-27T10:00:00.000Z'),
  });

  assert.equal(report.skippedReason, 'no_rollup_watermark');
  assert.equal(report.rawCutoff, null);
  assert.deepEqual(deleteCalls(db.calls), []);
});

test('the cutoff never rises above the point the rollup may still re-read', async () => {
  // Watermark far behind "now": the retention window would happily delete rows
  // from the last 90 days, but they have not been aggregated yet.
  const db = fakeDb(
    watermarkAt('2026-01-10T00:00:00.000Z', (sql) =>
      sql.includes('count(*)') ? { rows: [{ n: '7' }] } : undefined,
    ),
  );

  const report = await runUsageRetentionSweep(db, {
    dryRun: true,
    rawRetentionDays: 90,
    hourlyRetentionDays: 30,
    now: at('2026-07-27T10:00:00.000Z'),
  });

  // Both tiers clamp to watermark 2026-01-10T00:00Z minus the 1h re-roll overlap
  // — NOT their own windows (now-90d = 2026-04-28, now-30d = 2026-06-27), which
  // would destroy history the rollup has not reached yet.
  assert.equal(report.rawCutoff, '2026-01-09T23:00:00.000Z');
  assert.equal(report.hourlyCutoff, '2026-01-09T23:00:00.000Z');
});

test('a current watermark leaves the configured retention window in charge', async () => {
  const db = fakeDb(
    watermarkAt('2026-07-27T10:00:00.000Z', (sql) =>
      sql.includes('count(*)') ? { rows: [{ n: '0' }] } : undefined,
    ),
  );

  const report = await runUsageRetentionSweep(db, {
    dryRun: true,
    rawRetentionDays: 90,
    hourlyRetentionDays: 400,
    now: at('2026-07-27T10:00:00.000Z'),
  });

  // The watermark is current, so the interlock is not the binding constraint and
  // each tier's own window decides. Hourly detail outlives the raw rows it came
  // from; daily/monthly outlive both (never swept at all).
  assert.equal(report.rawCutoff, '2026-04-28T10:00:00.000Z'); // 90 days back
  assert.equal(report.hourlyCutoff, '2025-06-22T10:00:00.000Z'); // 400 days back
});

test('dry-run counts candidates and deletes nothing', async () => {
  const db = fakeDb(
    watermarkAt('2026-07-27T10:00:00.000Z', (sql) => {
      if (sql.includes('FROM task_execution_log')) return { rows: [{ n: '1200' }] };
      if (sql.includes('FROM usage_rollup_hourly')) return { rows: [{ n: '48' }] };
      return undefined;
    }),
  );

  const report = await runUsageRetentionSweep(db, {
    dryRun: true,
    now: at('2026-07-27T10:00:00.000Z'),
  });

  assert.equal(report.rawCandidates, 1200);
  assert.equal(report.hourlyCandidates, 48);
  assert.equal(report.rawDeleted, 0);
  assert.equal(report.hourlyDeleted, 0);
  assert.deepEqual(deleteCalls(db.calls), []);
});

test('committing deletes in bounded batches until the predicate is exhausted', async () => {
  let rawBatches = 0;
  const db = fakeDb(
    watermarkAt('2026-07-27T10:00:00.000Z', (sql) => {
      if (sql.startsWith('DELETE FROM task_execution_log')) {
        rawBatches += 1;
        // Two full batches, then a partial one that ends the loop.
        return { rowCount: rawBatches <= 2 ? 100 : 40 };
      }
      if (sql.startsWith('DELETE FROM usage_rollup_hourly')) return { rowCount: 0 };
      if (sql.includes('count(*)')) return { rows: [{ n: '240' }] };
      return undefined;
    }),
  );

  const report = await runUsageRetentionSweep(db, {
    dryRun: false,
    batchSize: 100,
    now: at('2026-07-27T10:00:00.000Z'),
  });

  assert.equal(rawBatches, 3);
  assert.equal(report.rawDeleted, 240);
  assert.equal(report.truncated, false);
});

test('the delete loop is bounded by maxBatches and reports the remainder', async () => {
  const db = fakeDb(
    watermarkAt('2026-07-27T10:00:00.000Z', (sql) => {
      if (sql.trimStart().startsWith('DELETE')) return { rowCount: 100 }; // never drains
      if (sql.includes('count(*)')) return { rows: [{ n: '999999' }] };
      return undefined;
    }),
  );

  const report = await runUsageRetentionSweep(db, {
    dryRun: false,
    batchSize: 100,
    maxBatches: 3,
    now: at('2026-07-27T10:00:00.000Z'),
  });

  assert.equal(report.truncated, true);
  assert.equal(report.rawDeleted, 300);
});

test('daily and monthly aggregates are never swept', () => {
  for (const sql of [
    COUNT_EXPIRED_RAW_SQL,
    COUNT_EXPIRED_HOURLY_SQL,
    DELETE_EXPIRED_RAW_SQL,
    DELETE_EXPIRED_HOURLY_SQL,
  ]) {
    assert.ok(!sql.includes('usage_rollup_daily'));
    assert.ok(!sql.includes('usage_rollup_monthly'));
  }
  // Batched by key, not an unbounded DELETE that would lock the append-only log
  // the live writers are inserting into.
  assert.match(DELETE_EXPIRED_RAW_SQL, /LIMIT \$2/);
  assert.match(DELETE_EXPIRED_HOURLY_SQL, /LIMIT \$2/);
});
