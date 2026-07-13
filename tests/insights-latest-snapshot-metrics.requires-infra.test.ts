import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';

import { requireDbEnvOrSkip } from './helpers/requires-infra';
import { LATEST_POST_METRICS_LATERAL } from '../backend/insights/latest-post-metrics-sql';

// S2-1 / AA-92 — live-schema proof that per-post readers use the LATEST lifetime
// snapshot per post, NOT SUM across dated cumulative rows (Gap A1 inflation).
//
// Per-post metrics are stored as lifetime-cumulative snapshots: one row per post
// per sync date, each an all-time running total. Over N days a post has N rows,
// so SUMming them inflates ~N×. All 8 readers now share
// LATEST_POST_METRICS_LATERAL (one exported source of truth), so proving that
// fragment proves both cross-surface paths (/insights builders AND the read-api
// posts endpoint behind /dashboard/analytics).
//
// The fix is pure SQL, so a mock proves nothing — this runs the exact exported
// fragment against real Postgres inside a rolled-back transaction. requires-infra:
// self-skips without DB env (as in CI), verified locally.
test('per-post reader returns latest lifetime snapshot, not sum-across-dates', async (t) => {
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
      `INSERT INTO organizations (name) VALUES ('S2-1 latest-snapshot test') RETURNING id`,
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

    // Three CUMULATIVE daily snapshots — each a growing all-time total.
    // reach 100 → 150 → 200 ; likes 10 → 20 → 30.
    const snap = async (daysAgo: number, reach: number, likes: number) => {
      await client.query(
        `INSERT INTO insights_post_metrics_daily
           (tenant_id, post_id, platform, date, reach, likes, raw_source)
         VALUES ($1, $2, 'facebook', CURRENT_DATE - $3::int, $4, $5, '{}'::jsonb)`,
        [org, post, daysAgo, reach, likes],
      );
    };
    await snap(2, 100, 10);   // oldest
    await snap(1, 150, 20);
    await snap(0, 200, 30);   // latest lifetime total

    // The shipped fragment: latest snapshot per post.
    const latest = await client.query<{ reach: string; likes: string }>(
      `SELECT COALESCE(m.reach, m.views, 0) AS reach, COALESCE(m.likes, 0) AS likes
       FROM insights_posts p
       ${LATEST_POST_METRICS_LATERAL}
       WHERE p.id = $1`,
      [post],
    );
    assert.equal(Number(latest.rows[0].reach), 200, 'reach = latest lifetime snapshot (not 450 = 100+150+200)');
    assert.equal(Number(latest.rows[0].likes), 30, 'likes = latest lifetime snapshot (not 60 = 10+20+30)');

    // Contrast: the OLD sum-across-dates math (what this ticket fixes) would
    // inflate to 450 — proving the three rows are the inflation source and that
    // the fragment above genuinely changes the result.
    const oldSum = await client.query<{ reach: string }>(
      `SELECT COALESCE(SUM(COALESCE(m.reach, m.views, 0)), 0) AS reach
       FROM insights_posts p
       LEFT JOIN insights_post_metrics_daily m
              ON m.post_id = p.id AND m.tenant_id = p.tenant_id
       WHERE p.id = $1
       GROUP BY p.id`,
      [post],
    );
    assert.equal(Number(oldSum.rows[0].reach), 450, 'sanity: the old SUM math inflates to 450 across 3 dated rows');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
});
