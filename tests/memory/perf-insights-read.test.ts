import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DUE_PERFORMANCE_POSTS_SQL,
  DUE_POSTS_LIMIT,
  selectDuePerformancePosts,
  markHonchoPerfWritten,
  type Queryable,
} from '../../backend/memory/perf-insights-read';

// P0 — read-model SQL shape + gate behavior. Pure fixture/mock assertions; the
// real-planner live-DB legs are #513-gated (tests/memory/perf-insights-live-db.test.ts).

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
  // reads from #513 tables, never Meta
  assert.match(sql, /insights_post_metrics_daily/);
  assert.match(sql, /insights_posts/);
  // tenant-scoped + limited
  assert.match(sql, /p\.tenant_id = \$1/);
  assert.match(sql, /LIMIT \$2/);
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
        impressions: '1500',
        likes: '300',
        comments: '12',
        shares: '5',
        saved: '9',
        video_views: '0',
        metric_day: '2026-05-25',
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
    assert.equal(out[0].metrics.saved, 9);
    assert.equal(out[0].metrics.day, '2026-05-25');
  } finally {
    delete process.env.ARIES_INSIGHTS_513_TABLES_PRESENT;
  }
});

test('#513 GATE: returns [] without touching DB when tables absent (default)', async () => {
  delete process.env.ARIES_INSIGHTS_513_TABLES_PRESENT;
  const { client, calls } = recordingClient([{ tenant_id: 1 }]);
  const out = await selectDuePerformancePosts(7, client);
  assert.deepEqual(out, []);
  assert.equal(calls.length, 0, 'must not query the DB while #513 tables are absent');
});

test('markHonchoPerfWritten upserts ON CONFLICT DO NOTHING with lower-cased platform', async () => {
  const { client, calls } = recordingClient([]);
  await markHonchoPerfWritten(7, 'job-abc', 'Instagram', '2026-05-25', client);
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /INSERT INTO honcho_perf_writes/);
  assert.match(calls[0].text, /ON CONFLICT \(tenant_id, job_id, platform, metric_day\) DO NOTHING/);
  assert.deepEqual(calls[0].values, [7, 'job-abc', 'instagram', '2026-05-25']);
});
