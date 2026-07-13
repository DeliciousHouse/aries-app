import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';

import { requireDbEnvOrSkip } from './helpers/requires-infra';

// S2-2 / AA-93 (part 2/2) — live-schema proof that a later same-day sync REFRESHES
// the per-post metrics row (DO UPDATE), instead of the old DO NOTHING that froze
// the row at its earliest-morning value (Gap A10 "intraday freeze").
//
// insights_post_metrics_daily holds one lifetime-cumulative snapshot per post per
// sync date, keyed by (tenant_id, post_id, date). The sync runs ~every 30 min;
// without DO UPDATE the first run of a calendar day wins and every later same-day
// run is discarded, so today's row never advances as the post's lifetime totals
// grow through the day.
//
// SAFE ONLY WITH S2-1 LIVE: S2-1's latest-snapshot readers take ORDER BY date DESC
// LIMIT 1, so DO UPDATE only freshens the single newest row a reader reads — no
// sum-across-dates path exists to re-inflate. This test exercises the write path
// in isolation (it proves the upsert, independent of any reader), so it passes
// with or without S2-1; the S2-1 dependency is a prod merge-order constraint, not
// a test dependency.
//
// The fix is pure SQL, so a mock proves nothing — this runs the EXACT
// ON CONFLICT ... DO UPDATE clause shipped in
// backend/insights/sync/dispatcher.ts against real Postgres inside a rolled-back
// transaction. requires-infra: self-skips without DB env (as in CI), verified
// locally.

// Kept byte-identical to the dispatcher's Site B statement so this test exercises
// the shipped SQL, not a paraphrase.
const POST_METRICS_UPSERT = `
  INSERT INTO insights_post_metrics_daily
    (tenant_id, post_id, platform, date,
     views, watch_time_minutes,
     avg_view_duration_sec, avg_view_percentage,
     likes, comments_count, shares,
     platform_data, raw_source)
  VALUES ($1, $2, $3, $4,
          $5, $6, $7, $8,
          $9, $10, $11,
          '{}', $12)
  ON CONFLICT (tenant_id, post_id, date) DO UPDATE SET
    views                 = EXCLUDED.views,
    watch_time_minutes    = EXCLUDED.watch_time_minutes,
    avg_view_duration_sec = EXCLUDED.avg_view_duration_sec,
    avg_view_percentage   = EXCLUDED.avg_view_percentage,
    likes                 = EXCLUDED.likes,
    comments_count        = EXCLUDED.comments_count,
    shares                = EXCLUDED.shares,
    raw_source            = EXCLUDED.raw_source`;

test('later same-day per-post sync updates the row (DO UPDATE, not frozen DO NOTHING)', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;

  const pool = new pg.Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    max: 1,
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const org = (await client.query<{ id: number }>(
      `INSERT INTO organizations (name) VALUES ('S2-2 per-post upsert test') RETURNING id`,
    )).rows[0].id;

    const account = (await client.query<{ id: number }>(
      `INSERT INTO insights_accounts (tenant_id, platform, external_account_id)
       VALUES ($1, 'facebook', 'fb-acct-1') RETURNING id`,
      [org],
    )).rows[0].id;

    const post = (await client.query<{ id: number }>(
      `INSERT INTO insights_posts (tenant_id, account_id, platform, external_post_id, published_at, media_type)
       VALUES ($1, $2, 'facebook', 'fb-post-1', now() - interval '5 days', 'image') RETURNING id`,
      [org, account],
    )).rows[0].id;

    // A single fixed calendar day (the conflict key), so both writes collide.
    const day = '2026-07-01';
    const writeSnapshot = async (views: number, likes: number, shares: number) => {
      await client.query(POST_METRICS_UPSERT, [
        org, post, 'facebook', day,
        views, /* watch */ 0, /* avg_view_duration_sec */ 0, /* avg_view_percentage */ 0,
        likes, /* comments */ 0, shares,
        JSON.stringify({}),
      ]);
    };

    // First sync of the day (earliest-morning lifetime total).
    await writeSnapshot(100, 10, 2);
    // A later same-day sync as the post's lifetime totals grow — same (tenant, post, date).
    await writeSnapshot(200, 30, 5);

    const row = (await client.query<{ views: string; likes: string; shares: string }>(
      `SELECT views, likes, shares
       FROM insights_post_metrics_daily
       WHERE tenant_id = $1 AND post_id = $2`,
      [org, post],
    )).rows[0];

    // DO UPDATE: the row reflects the LATER sync. Under the old DO NOTHING it would
    // still read 100 / 10 / 2 (frozen at the first write).
    assert.equal(Number(row.views), 200, 'views advance to the later same-day sync (not frozen at 100)');
    assert.equal(Number(row.likes), 30, 'likes advance to the later same-day sync (not frozen at 10)');
    assert.equal(Number(row.shares), 5, 'shares advance to the later same-day sync (not frozen at 2)');

    // And exactly one row exists for the day — the upsert updated in place, it did
    // not insert a duplicate.
    const count = (await client.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM insights_post_metrics_daily
       WHERE tenant_id = $1 AND post_id = $2`,
      [org, post],
    )).rows[0];
    assert.equal(Number(count.n), 1, 'one row per (tenant, post, date) — updated in place');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
});
