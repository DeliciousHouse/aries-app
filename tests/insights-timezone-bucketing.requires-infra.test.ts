import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';

import { requireDbEnvOrSkip } from './helpers/requires-infra';

// S2-3 / AA-94 — live-schema proof that the SQL day-of-week bucketing derives the
// weekday in the TENANT's business timezone ($tz), not UTC. This is the exact
// expression the attention best-day-of-week query now runs (and the shape the
// aries week-bucket + audience heatmap share):
//   EXTRACT(DOW FROM published_at AT TIME ZONE $tz)
//
// Boundary post: published 2026-07-08T03:30:00Z. In America/New_York (UTC-4 in
// July DST) that is 2026-07-07 23:30 — a TUESDAY. In UTC it is 2026-07-08 — a
// WEDNESDAY. So the tenant-tz DOW (2 = Tue) must differ from the UTC DOW (3 = Wed);
// the pre-S2-3 `AT TIME ZONE 'UTC'` expression returned the Wednesday.
//
// requires-infra: self-skips without DB env (as in CI), verified locally.
test('SQL DOW bucketing uses the tenant timezone, not UTC (boundary post)', async (t) => {
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
      `INSERT INTO organizations (name) VALUES ('S2-3 tz-bucketing test') RETURNING id`,
    )).rows[0].id;

    const account = (await client.query<{ id: number }>(
      `INSERT INTO insights_accounts (tenant_id, platform, external_account_id)
       VALUES ($1, 'facebook', 'fb-acct-1') RETURNING id`,
      [org],
    )).rows[0].id;

    // 2026-07-07 23:30 America/New_York = 2026-07-08 03:30 UTC.
    await client.query(
      `INSERT INTO insights_posts (tenant_id, account_id, platform, external_post_id, published_at, media_type)
       VALUES ($1, $2, 'facebook', 'fb-post-1', '2026-07-08T03:30:00Z', 'image')`,
      [org, account],
    );

    const row = (await client.query<{ tenant_dow: number; utc_dow: number }>(
      `SELECT
         EXTRACT(DOW FROM published_at AT TIME ZONE $2)::int AS tenant_dow,
         EXTRACT(DOW FROM published_at AT TIME ZONE 'UTC')::int AS utc_dow
       FROM insights_posts
       WHERE tenant_id = $1`,
      [org, 'America/New_York'],
    )).rows[0];

    // Passes-after: the shipped $tz expression buckets the post on Tuesday (2).
    assert.equal(Number(row.tenant_dow), 2, 'tenant-tz weekday = Tuesday (post was 23:30 NY on the 7th)');
    // Fails-before contrast: the old AT TIME ZONE \'UTC\' expression bucketed it on
    // Wednesday (3) — a different day. Proves the swap actually changes the result.
    assert.equal(Number(row.utc_dow), 3, 'UTC weekday = Wednesday (the pre-S2-3 answer)');
    assert.notEqual(Number(row.tenant_dow), Number(row.utc_dow), 'tenant-tz and UTC disagree at the boundary');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
});
