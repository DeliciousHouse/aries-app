import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';

import { requireDbEnvOrSkip } from './helpers/requires-infra';

// S2-2 / AA-93 (part 1/2) — live-schema proof that a later same-day sync REFRESHES
// the account-daily row (DO UPDATE), instead of the old DO NOTHING that froze the
// row at its earliest-morning value (Gap A10 "intraday freeze").
//
// insights_account_metrics_daily holds GENUINE daily values keyed by
// (tenant_id, account_id, date). The sync runs ~every 30 min; without DO UPDATE
// the first run of a calendar day wins and every later same-day run is discarded,
// so today's row never advances as engagement accrues through the day.
//
// The fix is pure SQL, so a mock proves nothing — this runs the EXACT
// ON CONFLICT ... DO UPDATE clause shipped in
// backend/insights/sync/dispatcher.ts against real Postgres inside a rolled-back
// transaction. requires-infra: self-skips without DB env (as in CI), verified
// locally.

// Kept byte-identical to the dispatcher's Site A statement so this test exercises
// the shipped SQL, not a paraphrase.
const ACCOUNT_DAILY_UPSERT = `
  INSERT INTO insights_account_metrics_daily
    (tenant_id, account_id, platform, date,
     views, watch_time_minutes, followers, followers_delta,
     likes, comments_count, shares, engagement,
     platform_data, raw_source)
  VALUES ($1, $2, $3, $4,
          $5, $6, $7, $8,
          $9, $10, $11, $12,
          '{}', $13)
  ON CONFLICT (tenant_id, account_id, date) DO UPDATE SET
    views              = EXCLUDED.views,
    watch_time_minutes = EXCLUDED.watch_time_minutes,
    likes              = EXCLUDED.likes,
    comments_count     = EXCLUDED.comments_count,
    shares             = EXCLUDED.shares,
    engagement         = EXCLUDED.engagement,
    raw_source         = EXCLUDED.raw_source`;

test('later same-day account sync updates the row (DO UPDATE, not frozen DO NOTHING)', async (t) => {
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
      `INSERT INTO organizations (name) VALUES ('S2-2 account-dailies upsert test') RETURNING id`,
    )).rows[0].id;

    const account = (await client.query<{ id: number }>(
      `INSERT INTO insights_accounts (tenant_id, platform, external_account_id)
       VALUES ($1, 'facebook', 'fb-acct-1') RETURNING id`,
      [org],
    )).rows[0].id;

    // A single fixed calendar day (the conflict key), so both writes collide.
    const day = '2026-07-01';
    const writeSnapshot = async (
      views: number,
      followers: number,
      likes: number,
      engagement: number,
    ) => {
      await client.query(ACCOUNT_DAILY_UPSERT, [
        org, account, 'facebook', day,
        views, /* watch */ 0, followers, /* followers_delta */ 0,
        likes, /* comments */ 0, /* shares */ 0, engagement,
        JSON.stringify({}),
      ]);
    };

    // First sync of the day (earliest-morning value).
    await writeSnapshot(1000, 100, 10, 1200);
    // A later same-day sync as the day's engagement accrues — same (tenant, account, date).
    await writeSnapshot(1500, 150, 25, 1800);

    const row = (await client.query<{
      views: string; followers: string; likes: string; engagement: string;
    }>(
      `SELECT views, followers, likes, engagement
       FROM insights_account_metrics_daily
       WHERE tenant_id = $1 AND account_id = $2`,
      [org, account],
    )).rows[0];

    // DO UPDATE: the row reflects the LATER sync. Under the old DO NOTHING it would
    // still read 1000 / 100 / 10 / 1200 (frozen at the first write).
    assert.equal(Number(row.views), 1500, 'views advance to the later same-day sync (not frozen at 1000)');
    // followers is deliberately NOT in the DO UPDATE SET: it is an absolute
    // point-in-time snapshot that adapters stamp authoritatively only on the
    // range's latest day; a re-emitted historical day carries a '?? 0' fallback
    // that would rewrite stored history. First write of the day wins.
    assert.equal(Number(row.followers), 100, 'followers keep the first authoritative write (deliberately excluded from DO UPDATE)');
    assert.equal(Number(row.likes), 25, 'likes advance to the later same-day sync (not frozen at 10)');
    assert.equal(Number(row.engagement), 1800, 'engagement advances to the later same-day sync (not frozen at 1200)');

    // And exactly one row exists for the day — the upsert updated in place, it did
    // not insert a duplicate.
    const count = (await client.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM insights_account_metrics_daily
       WHERE tenant_id = $1 AND account_id = $2`,
      [org, account],
    )).rows[0];
    assert.equal(Number(count.n), 1, 'one row per (tenant, account, date) — updated in place');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
});
