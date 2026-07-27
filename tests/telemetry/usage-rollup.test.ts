/**
 * AA-161 — usage time-series aggregation over task_execution_log.
 *
 * Covers the contracts a billing query depends on:
 *   - the window only ever covers CLOSED hours (an in-progress hour is never
 *     aggregated half-finished);
 *   - re-rolling an overlapping window CONVERGES (UPSERT = EXCLUDED) instead of
 *     double counting — the re-delivery over-count trap this repo keeps hitting;
 *   - the watermark is monotonic and is advanced only after every grain lands;
 *   - buckets are pinned to UTC, so a differing session TimeZone cannot shift a
 *     day boundary between the app container, a worker, and psql;
 *   - NULL tenant/user collapse to the 0 sentinel, without which the PK-based
 *     UPSERT would insert a duplicate userless row on every pass;
 *   - the first pass is bounded (backfill window + hours per pass) so it cannot
 *     scan the whole log at once.
 *
 * Fully in-memory: the db handle is injected, no Postgres is touched.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ROLLUP_DAILY_SQL,
  ROLLUP_HOURLY_SQL,
  ROLLUP_MONTHLY_SQL,
  ROLLUP_STATE_ID,
  UNSCOPED_ID,
  UPSERT_WATERMARK_SQL,
  runUsageRollup,
} from '@/backend/telemetry/usage-rollups';

type Call = { sql: string; params: unknown[] };

/** `responder` fakes the SELECTs; everything else returns an empty result. */
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

function callsMatching(calls: Call[], needle: string): Call[] {
  return calls.filter((c) => c.sql.includes(needle));
}

test('rolls only CLOSED hours, from the watermark minus the re-roll overlap', async () => {
  const db = fakeDb((sql) =>
    sql.includes('FROM usage_rollup_state')
      ? { rows: [{ rolled_through: '2026-07-27T09:00:00.000Z' }] }
      : undefined,
  );

  const report = await runUsageRollup(db, { now: at('2026-07-27T10:37:41.000Z') });

  assert.equal(report.skipped, false);
  // 09:00 watermark - 1h re-roll overlap. The overlap is what catches a raw row
  // that landed a moment after its bucket closed.
  assert.equal(report.from, '2026-07-27T08:00:00.000Z');
  // Upper bound is the boundary of the hour IN PROGRESS, never 10:37 itself.
  assert.equal(report.to, '2026-07-27T10:00:00.000Z');
  assert.equal(report.rolledThrough, '2026-07-27T10:00:00.000Z');
  assert.equal(report.truncated, false);
});

test('bootstraps from the oldest event when no watermark exists', async () => {
  const db = fakeDb((sql) => {
    if (sql.includes('FROM usage_rollup_state')) return { rows: [] };
    if (sql.includes('min(started_at)')) return { rows: [{ oldest: '2026-07-01T03:20:00.000Z' }] };
    return undefined;
  });

  const report = await runUsageRollup(db, { now: at('2026-07-01T05:10:00.000Z') });

  assert.equal(report.from, '2026-07-01T03:00:00.000Z'); // floored to its hour
  assert.equal(report.to, '2026-07-01T05:00:00.000Z');
});

test('an empty log stamps the watermark instead of re-scanning for a minimum forever', async () => {
  const db = fakeDb((sql) => {
    if (sql.includes('FROM usage_rollup_state')) return { rows: [] };
    if (sql.includes('min(started_at)')) return { rows: [{ oldest: null }] };
    return undefined;
  });

  const report = await runUsageRollup(db, { now: at('2026-07-27T10:37:00.000Z') });

  assert.equal(report.skipped, true);
  assert.equal(report.hourlyRows, 0);
  assert.equal(callsMatching(db.calls, 'INSERT INTO usage_rollup_hourly').length, 0);
  const stamp = callsMatching(db.calls, 'INSERT INTO usage_rollup_state');
  assert.equal(stamp.length, 1);
  assert.deepEqual(stamp[0].params, [ROLLUP_STATE_ID, '2026-07-27T10:00:00.000Z']);
});

test('the first pass is bounded by the backfill window and the per-pass hour cap', async () => {
  const db = fakeDb((sql) => {
    if (sql.includes('FROM usage_rollup_state')) return { rows: [] };
    // Ancient first event: without the bounds this pass would scan years of log.
    if (sql.includes('min(started_at)')) return { rows: [{ oldest: '2020-01-01T00:00:00.000Z' }] };
    return undefined;
  });

  const report = await runUsageRollup(db, {
    now: at('2026-07-27T10:37:00.000Z'),
    maxBackfillDays: 90,
    maxHoursPerPass: 168,
  });

  const boundary = Date.parse('2026-07-27T10:00:00.000Z');
  const expectedFrom = new Date(boundary - 90 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(report.from, expectedFrom);
  // Clamped to one week per pass; the rest is caught up over the next ticks.
  assert.equal(report.to, new Date(Date.parse(expectedFrom) + 168 * 60 * 60 * 1000).toISOString());
  assert.equal(report.truncated, true);
  // Everything before the backfill bound is skipped for good, so it is reported
  // rather than dropped silently.
  assert.equal(report.backfillClamped, true);
});

test('a caught-up pass does not report a backfill clamp', async () => {
  const db = fakeDb((sql) =>
    sql.includes('FROM usage_rollup_state')
      ? { rows: [{ rolled_through: '2026-07-27T09:00:00.000Z' }] }
      : undefined,
  );

  const report = await runUsageRollup(db, { now: at('2026-07-27T10:37:00.000Z') });

  assert.equal(report.backfillClamped, false);
});

test('skips entirely when there is no closed hour past the watermark', async () => {
  const db = fakeDb((sql) =>
    sql.includes('FROM usage_rollup_state')
      ? { rows: [{ rolled_through: '2026-07-27T11:00:00.000Z' }] }
      : undefined,
  );

  const report = await runUsageRollup(db, {
    now: at('2026-07-27T10:37:00.000Z'),
    rerollHours: 0,
  });

  assert.equal(report.skipped, true);
  assert.equal(report.from, null);
  assert.equal(callsMatching(db.calls, 'INSERT INTO usage_rollup_hourly').length, 0);
  assert.equal(callsMatching(db.calls, 'INSERT INTO usage_rollup_state').length, 0);
});

test('advances the watermark only after all three grains have landed', async () => {
  const db = fakeDb((sql) =>
    sql.includes('FROM usage_rollup_state')
      ? { rows: [{ rolled_through: '2026-07-27T09:00:00.000Z' }] }
      : undefined,
  );

  await runUsageRollup(db, { now: at('2026-07-27T10:37:00.000Z') });

  const order = db.calls
    .map((c) => {
      if (c.sql.includes('INSERT INTO usage_rollup_hourly')) return 'hourly';
      if (c.sql.includes('INSERT INTO usage_rollup_daily')) return 'daily';
      if (c.sql.includes('INSERT INTO usage_rollup_monthly')) return 'monthly';
      if (c.sql.includes('INSERT INTO usage_rollup_state')) return 'watermark';
      return null;
    })
    .filter(Boolean);

  // A crash mid-pass must leave the watermark where it was, so the next pass
  // redoes the window (idempotently) rather than skipping it.
  assert.deepEqual(order, ['hourly', 'daily', 'monthly', 'watermark']);
});

test('every grain UPSERTs by replacement, never by accumulation', () => {
  for (const sql of [ROLLUP_HOURLY_SQL, ROLLUP_DAILY_SQL, ROLLUP_MONTHLY_SQL]) {
    assert.match(sql, /ON CONFLICT \(bucket_start, tenant_id, user_id, execution_engine, task_key\) DO UPDATE/);
    assert.match(sql, /events\s+= EXCLUDED\.events/);
    assert.match(sql, /total_tokens\s+= EXCLUDED\.total_tokens/);
    // An additive update would double-count the moment a window is re-rolled.
    assert.ok(
      !/=\s*\w+\.\w+\s*\+/.test(sql),
      'rollup UPSERT must replace the bucket, not add to it',
    );
  }
});

test('the watermark can only move forward', () => {
  assert.match(UPSERT_WATERMARK_SQL, /WHERE usage_rollup_state\.rolled_through < EXCLUDED\.rolled_through/);
});

test('buckets are pinned to UTC so a session TimeZone cannot shift a day boundary', () => {
  assert.match(ROLLUP_HOURLY_SQL, /date_trunc\('hour', started_at AT TIME ZONE 'UTC'\) AT TIME ZONE 'UTC'/);
  assert.match(ROLLUP_DAILY_SQL, /date_trunc\('day', bucket_start AT TIME ZONE 'UTC'\) AT TIME ZONE 'UTC'/);
  assert.match(
    ROLLUP_MONTHLY_SQL,
    /date_trunc\('month', bucket_start AT TIME ZONE 'UTC'\) AT TIME ZONE 'UTC'/,
  );
});

test('NULL tenant/user collapse to the unscoped sentinel so the UPSERT stays idempotent', () => {
  assert.equal(UNSCOPED_ID, 0);
  assert.match(ROLLUP_HOURLY_SQL, new RegExp(`COALESCE\\(tenant_id, ${UNSCOPED_ID}\\)`));
  assert.match(ROLLUP_HOURLY_SQL, new RegExp(`COALESCE\\(user_id, ${UNSCOPED_ID}\\)`));
});

test('AI usage is summed without inventing zeros, and carries its reported-count denominator', () => {
  // SUM skips NULLs, so a bucket of unreported AI runs stays NULL ("not
  // reported") rather than becoming a $0 bucket that reads as "no spend".
  assert.match(ROLLUP_HOURLY_SQL, /sum\(total_tokens\)/);
  assert.match(ROLLUP_HOURLY_SQL, /count\(\*\) FILTER \(WHERE execution_engine = 'AI_LLM'\)/);
  assert.match(
    ROLLUP_HOURLY_SQL,
    /count\(\*\) FILTER \(WHERE execution_engine = 'AI_LLM' AND total_tokens IS NOT NULL\)/,
  );
  // Retries are counted separately from settled attempts (the AA-158 status axis).
  assert.match(ROLLUP_HOURLY_SQL, /count\(\*\) FILTER \(WHERE status = 'retry'\)/);
});

test('derived grains rebuild WHOLE periods from the hourly table, not from the raw log', () => {
  // Rebuilding from hourly is what lets daily/monthly stay correct after the raw
  // rows are purged; widening to whole periods is what stops a partial window
  // from overwriting a complete day with one hour of totals.
  for (const sql of [ROLLUP_DAILY_SQL, ROLLUP_MONTHLY_SQL]) {
    assert.match(sql, /FROM usage_rollup_hourly/);
    assert.ok(!sql.includes('FROM task_execution_log'));
  }
  assert.match(ROLLUP_DAILY_SQL, /date_trunc\('day', \$1::timestamptz AT TIME ZONE 'UTC'\)/);
  assert.match(ROLLUP_DAILY_SQL, /\+ interval '1 day'/);
  assert.match(ROLLUP_MONTHLY_SQL, /\+ interval '1 month'/);
});
