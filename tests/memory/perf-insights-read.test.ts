import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  DUE_PERFORMANCE_POSTS_SQL,
  DUE_POSTS_LIMIT,
  selectDuePerformancePosts,
  markHonchoPerfWritten,
  type Queryable,
} from '../../backend/memory/perf-insights-read';
import { OBSERVATION_HORIZON_DAYS } from '../../backend/memory/insights-513-contract';

// P0 — read-model SQL shape, SCHEMA CORRECTNESS against the real DDL, and gate
// behaviour. Pure fixture/mock assertions; no DB.

function recordingClient(rows: Record<string, unknown>[] = []): {
  client: Queryable;
  calls: { text: string; values?: unknown[] }[];
} {
  const calls: { text: string; values?: unknown[] }[] = [];
  const client: Queryable = {
    async query(text: string, values?: unknown[]) {
      calls.push({ text, values });
      return { rows: rows as never[] };
    },
  };
  return { client, calls };
}

// ---------------------------------------------------------------------------
// Schema correctness — parse the REAL CREATE TABLE bodies out of init-db.js and
// assert every column the query references actually exists. This is the check
// that was missing: the previous SQL targeted a proposed schema
// (external_post_id/day/impressions/saved/comments/video_views on the metrics
// table) that never shipped, and nothing failed because the gate was off.
// ---------------------------------------------------------------------------

const INIT_DB = readFileSync(
  path.join(process.cwd(), 'scripts', 'init-db.js'),
  'utf8',
);

/** Columns declared in `CREATE TABLE IF NOT EXISTS <name> ( … );`. */
function columnsOf(table: string): Set<string> {
  const start = INIT_DB.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
  assert.ok(start >= 0, `DDL for ${table} not found in scripts/init-db.js`);
  const open = INIT_DB.indexOf('(', start);
  let depth = 0;
  let end = open;
  for (let i = open; i < INIT_DB.length; i++) {
    const ch = INIT_DB[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = INIT_DB.slice(open + 1, end);
  const cols = new Set<string>();
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('--')) continue;
    const m = /^([a-z_][a-z0-9_]*)\s+[A-Za-z]/.exec(line);
    if (!m) continue;
    const name = m[1]!.toLowerCase();
    // Table-level constraints parse as words; drop the ones that are not columns.
    if (['primary', 'unique', 'foreign', 'constraint', 'check'].includes(name)) continue;
    cols.add(name);
  }
  assert.ok(cols.size > 0, `no columns parsed for ${table}`);
  return cols;
}

/** Every `<alias>.<column>` reference in the due-posts SQL. */
function referencedColumns(alias: string): string[] {
  const re = new RegExp(`\\b${alias}\\.([a-z_][a-z0-9_]*)`, 'g');
  const out = new Set<string>();
  for (const m of DUE_PERFORMANCE_POSTS_SQL.matchAll(re)) out.add(m[1]!);
  return [...out];
}

test('due-posts SQL only references columns that exist in insights_post_metrics_daily', () => {
  const cols = columnsOf('insights_post_metrics_daily');
  // `m` is the LATERAL projection; `d` is the underlying table.
  for (const col of [...referencedColumns('d'), ...referencedColumns('m')]) {
    assert.ok(cols.has(col), `insights_post_metrics_daily has no column "${col}"`);
  }
});

test('due-posts SQL only references columns that exist in insights_posts / insights_accounts', () => {
  const postCols = columnsOf('insights_posts');
  for (const col of referencedColumns('ip')) {
    assert.ok(postCols.has(col), `insights_posts has no column "${col}"`);
  }
  const acctCols = columnsOf('insights_accounts');
  for (const col of referencedColumns('a')) {
    // disabled_at is added by a later ALTER TABLE, not the CREATE body.
    if (col === 'disabled_at') {
      assert.match(INIT_DB, /ALTER TABLE insights_accounts ADD COLUMN IF NOT EXISTS disabled_at/);
      continue;
    }
    assert.ok(acctCols.has(col), `insights_accounts has no column "${col}"`);
  }
});

test('regression: the drifted column names are gone for good', () => {
  const sql = DUE_PERFORMANCE_POSTS_SQL;
  for (const dead of [/\bimpressions\b/, /\bsaved\b/, /\bvideo_views\b/, /\bm\.day\b/, /\bd\.day\b/, /d\.external_post_id/]) {
    assert.ok(!dead.test(sql), `drifted reference ${dead} is back in DUE_PERFORMANCE_POSTS_SQL`);
  }
  // The real join key + day column.
  assert.match(sql, /d\.post_id = ip\.id/);
  assert.match(sql, /ORDER BY d\.date DESC/);
  assert.match(sql, /d\.comments_count/);
  assert.match(sql, /d\.saves/);
  assert.match(sql, /d\.views/);
});

// ---------------------------------------------------------------------------
// Query shape
// ---------------------------------------------------------------------------

test('due-posts SQL: 24h..30d window, status + job_id filter, ledger-exclude, LIMIT', () => {
  const sql = DUE_PERFORMANCE_POSTS_SQL;
  assert.match(sql, /published_at <= NOW\(\) - INTERVAL '24 hours'/);
  assert.match(sql, /published_at >= NOW\(\) - INTERVAL '30 days'/);
  assert.match(sql, /published_status = 'published'/);
  assert.match(sql, /p\.job_id IS NOT NULL/);
  assert.match(sql, /LEFT JOIN honcho_perf_writes/);
  assert.match(sql, /w\.job_id IS NULL/);
  assert.match(sql, /insights_post_metrics_daily/);
  assert.match(sql, /insights_posts/);
  assert.match(sql, /p\.tenant_id = \$1/);
  assert.match(sql, /LIMIT \$2/);
});

test('due-posts SQL excludes disabled insights accounts (production reader contract)', () => {
  assert.match(DUE_PERFORMANCE_POSTS_SQL, /JOIN insights_accounts a[\s\S]*a\.disabled_at IS NULL/);
});

test('due-posts SQL normalizes the legacy meta platform alias', () => {
  assert.match(DUE_PERFORMANCE_POSTS_SQL, /lower\(ip\.platform\) = 'meta'/);
  assert.match(DUE_PERFORMANCE_POSTS_SQL, /lower\(p\.platform\) = 'meta'/);
});

test('due-posts SQL implements the horizon cadence and ledgers on the horizon anchor', () => {
  const sql = DUE_PERFORMANCE_POSTS_SQL;
  // The horizon VALUES list is derived from the contract constant.
  for (const days of OBSERVATION_HORIZON_DAYS) {
    assert.ok(sql.includes(`(${days})`), `horizon ${days} missing from the VALUES list`);
  }
  // Largest reached horizon wins.
  assert.match(sql, /ORDER BY h\.days DESC[\s\S]*LIMIT 1/);
  // The ledger join is on publish_day + horizon, NOT on the raw snapshot date —
  // that is what stops a post being re-offered on all 29 remaining days.
  assert.match(sql, /w\.metric_day = \(p\.published_at AT TIME ZONE 'UTC'\)::date \+ hz\.days/);
  assert.ok(
    !/w\.metric_day = m\.date/.test(sql),
    'ledger must not join on the raw snapshot date (daily no-op churn)',
  );
});

// ---------------------------------------------------------------------------
// Behaviour
// ---------------------------------------------------------------------------

test('selectDuePerformancePosts is tenant-scoped + LIMIT-capped', async () => {
  const { client, calls } = recordingClient([]);
  await selectDuePerformancePosts(7, client, 99999);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].values, [7, DUE_POSTS_LIMIT]); // capped to max
});

test('selectDuePerformancePosts maps rows into DuePerformancePost incl. caption/mediaType/horizon', async () => {
  const { client } = recordingClient([
    {
      tenant_id: 7,
      job_id: 'job-abc',
      platform: 'Instagram',
      publish_day: '2026-05-25',
      permalink: 'https://www.instagram.com/p/ABC/',
      caption: 'three ways to break in new leather',
      media_type: 'reel',
      views: '3400',
      reach: '1200',
      likes: '300',
      comments_count: '12',
      shares: '5',
      saves: '9',
      metric_day: '2026-06-01',
      horizon_days: '7',
      observation_day: '2026-06-01',
    },
  ]);
  const out = await selectDuePerformancePosts(7, client);
  assert.equal(out.length, 1);
  const post = out[0]!;
  assert.equal(post.tenantId, 7);
  assert.equal(post.jobId, 'job-abc');
  assert.equal(post.platform, 'instagram'); // lower-cased
  assert.equal(post.publishDay, '2026-05-25');
  assert.equal(post.permalink, 'https://www.instagram.com/p/ABC/');
  assert.equal(post.caption, 'three ways to break in new leather');
  assert.equal(post.mediaType, 'reel');
  assert.equal(post.horizonDays, 7);
  assert.equal(post.observationDay, '2026-06-01');
  assert.equal(post.metrics.reach, 1200); // numeric coercion
  assert.equal(post.metrics.views, 3400);
  assert.equal(post.metrics.comments_count, 12);
  assert.equal(post.metrics.saves, 9);
  assert.equal(post.metrics.date, '2026-06-01');
});

test('gate DEFAULTS ON (tables ship with init-db); =0 is the kill switch', async () => {
  delete process.env.ARIES_INSIGHTS_513_TABLES_PRESENT;
  const on = recordingClient([]);
  await selectDuePerformancePosts(7, on.client);
  assert.equal(on.calls.length, 1, 'default-on must query');

  process.env.ARIES_INSIGHTS_513_TABLES_PRESENT = '0';
  try {
    const off = recordingClient([{ tenant_id: 1 }]);
    const out = await selectDuePerformancePosts(7, off.client);
    assert.deepEqual(out, []);
    assert.equal(off.calls.length, 0, 'kill switch must not touch the DB');
  } finally {
    delete process.env.ARIES_INSIGHTS_513_TABLES_PRESENT;
  }
});

test('markHonchoPerfWritten upserts ON CONFLICT DO NOTHING with lower-cased platform', async () => {
  const { client, calls } = recordingClient([]);
  await markHonchoPerfWritten(7, 'job-abc', 'Instagram', '2026-06-01', client);
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /INSERT INTO honcho_perf_writes/);
  assert.match(calls[0].text, /ON CONFLICT \(tenant_id, job_id, platform, metric_day\) DO NOTHING/);
  assert.deepEqual(calls[0].values, [7, 'job-abc', 'instagram', '2026-06-01']);
});
