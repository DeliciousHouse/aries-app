import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';

import { requireDbEnvOrSkip } from './helpers/requires-infra';
import { DUE_PERFORMANCE_POSTS_SQL, DUE_POSTS_LIMIT } from '../backend/memory/perf-insights-read';

// S4-4 / gap B2 — live-schema proof for the Honcho perf-leg read model.
//
// DUE_PERFORMANCE_POSTS_SQL was frozen against a PROPOSED insights schema and
// referenced six columns the landed tables never created, so flipping
// ARIES_INSIGHTS_513_TABLES_PRESENT=1 errored every 30-min tick. A mock client
// cannot catch that class of bug — only the real planner resolves column names.
// This runs the exact exported SQL against Postgres inside a rolled-back
// transaction. requires-infra: self-skips without DB env (as in CI).

function connect(): pg.Pool {
  return new pg.Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    max: 1,
  });
}

/** Seed one org + published post + synced insights post, return the ids. */
async function seed(
  client: pg.PoolClient,
  opts: { platform: string; postsPlatform?: string; mediaType: string; jobId: string },
): Promise<{ org: number; insightsPostId: number }> {
  const org = (await client.query<{ id: number }>(
    `INSERT INTO organizations (name) VALUES ('S4-4 perf due-posts test') RETURNING id`,
  )).rows[0].id;

  const externalPostId = `ext-${opts.jobId}`;

  await client.query(
    `INSERT INTO posts
       (tenant_id, caption, platform, platform_post_id, job_id, published_status, published_at)
     VALUES ($1, 'caption', $2, $3, $4, 'published', now() - interval '3 days')`,
    [org, opts.postsPlatform ?? opts.platform, externalPostId, opts.jobId],
  );

  const account = (await client.query<{ id: number }>(
    `INSERT INTO insights_accounts (tenant_id, platform, external_account_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [org, opts.platform, `acct-${opts.jobId}`],
  )).rows[0].id;

  const insightsPostId = (await client.query<{ id: number }>(
    `INSERT INTO insights_posts
       (tenant_id, account_id, platform, external_post_id, published_at, media_type, permalink)
     VALUES ($1, $2, $3, $4, now() - interval '3 days', $5, $6) RETURNING id`,
    [org, account, opts.platform, externalPostId, opts.mediaType, `https://example.com/p/${opts.jobId}`],
  )).rows[0].id;

  return { org, insightsPostId };
}

async function snapshot(
  client: pg.PoolClient,
  args: { org: number; postId: number; platform: string; daysAgo: number; reach: number; views: number },
): Promise<void> {
  await client.query(
    `INSERT INTO insights_post_metrics_daily
       (tenant_id, post_id, platform, date, reach, views, likes, comments_count, shares, saves, raw_source)
     VALUES ($1, $2, $3, CURRENT_DATE - $4::int, $5, $6, 10, 3, 2, 7, '{}'::jsonb)`,
    [args.org, args.postId, args.platform, args.daysAgo, args.reach, args.views],
  );
}

test('due-posts SQL resolves against the live schema and returns the latest snapshot', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;

  const pool = connect();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { org, insightsPostId } = await seed(client, {
      platform: 'instagram',
      mediaType: 'image',
      jobId: 'job-live-1',
    });

    // Cumulative snapshots — the NEWEST is the post's true lifetime total.
    await snapshot(client, { org, postId: insightsPostId, platform: 'instagram', daysAgo: 2, reach: 100, views: 500 });
    await snapshot(client, { org, postId: insightsPostId, platform: 'instagram', daysAgo: 0, reach: 300, views: 900 });

    const { rows } = await client.query(DUE_PERFORMANCE_POSTS_SQL, [org, DUE_POSTS_LIMIT]);

    assert.equal(rows.length, 1);
    const row = rows[0] as Record<string, unknown>;
    assert.equal(row.job_id, 'job-live-1');
    assert.equal(row.platform, 'instagram');
    assert.equal(Number(row.reach), 300, 'latest snapshot, not the older one or a SUM');
    assert.equal(Number(row.comments_count), 3);
    assert.equal(Number(row.saves), 7);
    // Image post: `views` exists on the row but must NOT surface as video_views.
    assert.equal(row.video_views, null);
    // publish_day is the post's UTC publish day; snapshot_date is the sync date.
    assert.match(String(row.publish_day), /^\d{4}-\d{2}-\d{2}$/);
    assert.match(String(row.snapshot_date), /^\d{4}-\d{2}-\d{2}$/);
    assert.notEqual(row.publish_day, row.snapshot_date);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
});

test('video media types surface views as video_views', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;

  const pool = connect();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { org, insightsPostId } = await seed(client, {
      platform: 'instagram',
      mediaType: 'reel',
      jobId: 'job-live-reel',
    });
    await snapshot(client, { org, postId: insightsPostId, platform: 'instagram', daysAgo: 0, reach: 300, views: 900 });

    const { rows } = await client.query(DUE_PERFORMANCE_POSTS_SQL, [org, DUE_POSTS_LIMIT]);
    assert.equal(rows.length, 1);
    assert.equal(Number((rows[0] as Record<string, unknown>).video_views), 900);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
});

test("posts.platform 'meta' still joins to the 'facebook' insights row", async (t) => {
  if (!requireDbEnvOrSkip(t)) return;

  // posts.platform genuinely carries both spellings; the shipped insights
  // attribution join normalizes meta→facebook and this query must match it, or
  // every Facebook post silently drops out of the due set.
  const pool = connect();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { org, insightsPostId } = await seed(client, {
      platform: 'facebook',
      postsPlatform: 'meta',
      mediaType: 'image',
      jobId: 'job-live-meta',
    });
    await snapshot(client, { org, postId: insightsPostId, platform: 'facebook', daysAgo: 0, reach: 55, views: 66 });

    const { rows } = await client.query(DUE_PERFORMANCE_POSTS_SQL, [org, DUE_POSTS_LIMIT]);
    assert.equal(rows.length, 1, 'meta-spelled post must still resolve');
    assert.equal(Number((rows[0] as Record<string, unknown>).reach), 55);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
});

test('ledger row keyed on the publish day excludes the post on the next tick', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;

  // The dedup join keys on the post's UTC publish day. A later metrics snapshot
  // must NOT re-open an already-written post (the re-drive-forever bug).
  const pool = connect();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { org, insightsPostId } = await seed(client, {
      platform: 'instagram',
      mediaType: 'image',
      jobId: 'job-live-ledger',
    });
    await snapshot(client, { org, postId: insightsPostId, platform: 'instagram', daysAgo: 1, reach: 100, views: 0 });

    const before = await client.query(DUE_PERFORMANCE_POSTS_SQL, [org, DUE_POSTS_LIMIT]);
    assert.equal(before.rows.length, 1);
    const publishDay = String((before.rows[0] as Record<string, unknown>).publish_day);

    await client.query(
      `INSERT INTO honcho_perf_writes (tenant_id, job_id, platform, metric_day)
       VALUES ($1, 'job-live-ledger', 'instagram', $2::date)`,
      [org, publishDay],
    );

    const after = await client.query(DUE_PERFORMANCE_POSTS_SQL, [org, DUE_POSTS_LIMIT]);
    assert.equal(after.rows.length, 0, 'ledgered post must be excluded');

    // A fresh sync snapshot lands today — the post must STAY excluded.
    await snapshot(client, { org, postId: insightsPostId, platform: 'instagram', daysAgo: 0, reach: 400, views: 0 });
    const afterResync = await client.query(DUE_PERFORMANCE_POSTS_SQL, [org, DUE_POSTS_LIMIT]);
    assert.equal(
      afterResync.rows.length,
      0,
      'a newer snapshot must not re-drive an already-written post',
    );
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
});
