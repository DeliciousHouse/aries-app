import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';

import { requireDbEnvOrSkip } from './helpers/requires-infra';
import { CURRENT_FOLLOWERS_SUM_SQL } from '../backend/insights/read-api';

// S1-8 / AA-87 — live-schema proof that summary.currentFollowers is the SUM of
// each platform's LATEST follower count, not MAX across platforms.
//
// This can only be proven against real Postgres: the fix lives entirely in SQL
// (DISTINCT ON (platform) latest row, then SUM), so a mocked pool would prove
// nothing. Runs the exact exported statement inside a rolled-back transaction.
//
// requires-infra: self-skips when DB env is absent (as in CI — see the S8-2
// gap), so the green CI check does NOT mean this ran. Verified locally via the
// fails-before/passes-after swap (MAX → returns the largest single platform).
test('summary.currentFollowers = SUM of per-platform latest, not MAX', async (t) => {
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
      `INSERT INTO organizations (name) VALUES ('S1-8 followers-sum test') RETURNING id`,
    )).rows[0].id;

    const account = async (platform: string): Promise<number> => (
      await client.query<{ id: number }>(
        `INSERT INTO insights_accounts (tenant_id, platform, external_account_id)
         VALUES ($1, $2, $3) RETURNING id`,
        [org, platform, `${platform}-ext-1`],
      )
    ).rows[0].id;

    const fb = await account('facebook');
    const ig = await account('instagram');

    // followers is a dated time-series. Older rows PLUS a latest row per platform.
    const snap = async (accId: number, platform: string, daysAgo: number, followers: number) => {
      await client.query(
        `INSERT INTO insights_account_metrics_daily
           (tenant_id, account_id, platform, date, followers, raw_source)
         VALUES ($1, $2, $3, CURRENT_DATE - $4::int, $5, '{}'::jsonb)`,
        [org, accId, platform, daysAgo, followers],
      );
    };
    await snap(fb, 'facebook', 5, 8000);   // older FB
    await snap(fb, 'facebook', 1, 10000);  // latest FB
    await snap(ig, 'instagram', 5, 5000);  // older IG
    await snap(ig, 'instagram', 1, 6000);  // latest IG

    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 30);

    // All platforms: latest FB (10k) + latest IG (6k) = 16k.
    // NOT 10000 (MAX across platforms) and NOT 29000 (8k+10k+5k+6k across dates).
    const all = await client.query<{ current_followers: string }>(
      CURRENT_FOLLOWERS_SUM_SQL, [org, fromDate, null],
    );
    assert.equal(Number(all.rows[0].current_followers), 16000,
      'combined = sum of each platform\'s latest follower count');

    // Single-platform filter still correct: FB latest = 10k.
    const fbOnly = await client.query<{ current_followers: string }>(
      CURRENT_FOLLOWERS_SUM_SQL, [org, fromDate, 'facebook'],
    );
    assert.equal(Number(fbOnly.rows[0].current_followers), 10000,
      'single-platform tenant unaffected');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
});
