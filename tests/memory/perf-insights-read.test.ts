import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DUE_PERFORMANCE_POSTS_SQL,
  DUE_POSTS_LIMIT,
  VIDEO_MEDIA_TYPES,
  selectDuePerformancePosts,
  markHonchoPerfWritten,
  type Queryable,
} from '../../backend/memory/perf-insights-read';

// P0 — read-model SQL shape + gate behavior. Pure fixture/mock assertions; the
// real-planner leg runs against a live schema in
// tests/perf-insights-due-posts.requires-infra.test.ts.

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

test('due-posts SQL: 24h..30d window, status + job_id filter, ledger-exclude, LIMIT', () => {
  const sql = DUE_PERFORMANCE_POSTS_SQL;
  assert.match(sql, /published_at <= NOW\(\) - INTERVAL '24 hours'/);
  assert.match(sql, /published_at >= NOW\(\) - INTERVAL '30 days'/);
  assert.match(sql, /published_status = 'published'/);
  assert.match(sql, /p\.job_id IS NOT NULL/);
  // ledger exclude (LEFT JOIN honcho_perf_writes ... w.job_id IS NULL)
  assert.match(sql, /LEFT JOIN honcho_perf_writes/);
  assert.match(sql, /w\.job_id IS NULL/);
  // reads from the insights tables, never Meta
  assert.match(sql, /insights_post_metrics_daily/);
  assert.match(sql, /insights_posts/);
  // tenant-scoped + limited
  assert.match(sql, /p\.tenant_id = \$1/);
  assert.match(sql, /LIMIT \$2/);
});

// S4-4 / gap B2: this SQL was frozen against a PROPOSED schema and referenced
// six columns the landed tables never created, so flipping the rollout gate
// errored every tick. These two tests pin the landed column map in both
// directions — the negative half is what stops a stale name creeping back.

test('due-posts SQL joins metrics on post_id and takes the LATEST snapshot', () => {
  const sql = DUE_PERFORMANCE_POSTS_SQL;
  // insights_post_metrics_daily keys on post_id -> insights_posts(id); it has
  // no external_post_id column.
  assert.match(sql, /d\.post_id = ip\.id/);
  assert.match(sql, /d\.tenant_id = ip\.tenant_id/);
  // Rows are lifetime-CUMULATIVE: newest row per post is the true total, so
  // ORDER BY date DESC LIMIT 1 — never SUM across a post's dated rows (S2-1).
  assert.match(sql, /ORDER BY d\.date DESC\s+LIMIT 1/);
  // posts <-> insights_posts platform match normalizes the legacy 'meta' alias
  // (posts.platform carries both spellings), mirroring the sync dispatcher.
  assert.match(sql, /lower\(ip\.platform\) = 'meta'/);
  assert.match(sql, /lower\(p\.platform\) = 'meta'/);
  // Ledger day is the post's UTC PUBLISH day, not the snapshot's sync date.
  assert.match(sql, /w\.metric_day = \(p\.published_at AT TIME ZONE 'UTC'\)::date/);
});

test('due-posts SQL never references the pre-S4-4 phantom columns', () => {
  const sql = DUE_PERFORMANCE_POSTS_SQL;
  for (const phantom of [
    /d\.external_post_id/, // metrics table keys on post_id
    /\bm\.day\b/, //          landed column is `date`
    /\bd\.day\b/,
    /\bm\.comments\b(?!_count)/, // landed column is `comments_count`
    /\bd\.comments\b(?!_count)/,
    /\bm\.saved\b/, //        landed column is `saves`
    /\bd\.saved\b/,
    /\bm\.impressions\b/, //  no landed counterpart at all
    /\bd\.impressions\b/,
    /\bm\.video_views\b/, //  derived from `views`, not a stored column
    /\bd\.video_views\b/,
  ]) {
    assert.doesNotMatch(sql, phantom, `phantom column ${phantom} must not reappear`);
  }
});

test('video_views is derived from views for video media types only', () => {
  const sql = DUE_PERFORMANCE_POSTS_SQL;
  // `views` is populated for EVERY media type, so an image post's views must
  // never be reported as video views (S4-4 decision).
  assert.match(sql, /lower\(ip\.media_type\) IN \('video', 'reel', 'short'\)/);
  assert.match(sql, /THEN m\.views\s+END\s+AS video_views/);
  assert.deepEqual([...VIDEO_MEDIA_TYPES], ['video', 'reel', 'short']);
});

test('selectDuePerformancePosts is tenant-scoped + LIMIT-capped (gate ON)', async () => {
  process.env.ARIES_INSIGHTS_513_TABLES_PRESENT = '1';
  try {
    const { client, calls } = recordingClient([]);
    await selectDuePerformancePosts(7, client, 99999);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].values, [7, DUE_POSTS_LIMIT]); // capped to max
  } finally {
    delete process.env.ARIES_INSIGHTS_513_TABLES_PRESENT;
  }
});

test('selectDuePerformancePosts maps rows into DuePerformancePost (gate ON)', async () => {
  process.env.ARIES_INSIGHTS_513_TABLES_PRESENT = '1';
  try {
    const { client } = recordingClient([
      {
        tenant_id: 7,
        job_id: 'job-abc',
        platform: 'instagram',
        publish_day: '2026-05-25',
        permalink: 'https://www.instagram.com/p/ABC/',
        reach: '1200',
        likes: '300',
        comments_count: '12',
        shares: '5',
        saves: '9',
        video_views: null, // image post — CASE resolved it to NULL
        snapshot_date: '2026-05-28',
      },
    ]);
    const out = await selectDuePerformancePosts(7, client);
    assert.equal(out.length, 1);
    assert.equal(out[0].tenantId, 7);
    assert.equal(out[0].jobId, 'job-abc');
    assert.equal(out[0].platform, 'instagram');
    assert.equal(out[0].publishDay, '2026-05-25');
    assert.equal(out[0].permalink, 'https://www.instagram.com/p/ABC/');
    assert.equal(out[0].metrics.reach, 1200); // numeric coercion
    assert.equal(out[0].metrics.saves, 9);
    assert.equal(out[0].metrics.comments_count, 12);
    assert.equal(out[0].metrics.video_views, null, 'null stays null, never coerced to 0');
    // Snapshot date is provenance and is DISTINCT from the publish day: the
    // ledger/idempotency day is publishDay.
    assert.equal(out[0].metrics.snapshot_date, '2026-05-28');
  } finally {
    delete process.env.ARIES_INSIGHTS_513_TABLES_PRESENT;
  }
});

test('ROLLOUT GATE: returns [] without touching DB when the gate is off (default)', async () => {
  delete process.env.ARIES_INSIGHTS_513_TABLES_PRESENT;
  const { client, calls } = recordingClient([{ tenant_id: 1 }]);
  const out = await selectDuePerformancePosts(7, client);
  assert.deepEqual(out, []);
  assert.equal(calls.length, 0, 'must not query the DB while the rollout gate is off');
});

test('markHonchoPerfWritten upserts ON CONFLICT DO NOTHING with lower-cased platform', async () => {
  const { client, calls } = recordingClient([]);
  await markHonchoPerfWritten(7, 'job-abc', 'Instagram', '2026-05-25', client);
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /INSERT INTO honcho_perf_writes/);
  assert.match(calls[0].text, /ON CONFLICT \(tenant_id, job_id, platform, metric_day\) DO NOTHING/);
  assert.deepEqual(calls[0].values, [7, 'job-abc', 'instagram', '2026-05-25']);
});
