import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';

import { requireDbEnvOrSkip } from './helpers/requires-infra';
import {
  COUNT_SQL,
  COUNT_BY_TENANT_SQL,
  SELECT_BATCH_SQL,
  EXPIRE_BATCH_SQL,
} from '../backend/marketing/draft-expiry-sweep';

// Real-Postgres integration test for the draft-expiry sweep.
//
// Proves against the live schema (inside a transaction that is ALWAYS rolled
// back — no row persists, safe even against prod):
//   1. all four sweep statements PLAN against the real posts/scheduled_posts
//      schema (a mock pool never rejects, the real planner does);
//   2. the 'expired' value is actually ACCEPTED by the posts_published_status
//      and posts_status CHECK constraints — i.e. the init-db.js constraint
//      widening is present. A stranded post inserted with updated_at far in the
//      past flips to published_status='expired' / status='expired' and stamps
//      expired_at;
//   3. the guard holds: a post WITH a scheduled_posts row, and a too-recent
//      post, are both skipped by EXPIRE_BATCH_SQL (rowCount 0).
//
// Without DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME the test self-skips via the
// shared guard. When the DB is reachable it MUST run and pass.

function dbConfigFromEnv(): pg.PoolConfig | null {
  const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } = process.env;
  if (!DB_HOST || !DB_PORT || !DB_USER || !DB_PASSWORD || !DB_NAME) return null;
  return {
    host: DB_HOST,
    port: Number(DB_PORT),
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    max: 2,
  };
}

const dbConfig = dbConfigFromEnv();

// Cutoff well in the future-of-the-test-rows but past "recent": the inserted
// stranded rows use updated_at = now() - 60d, so a 14-day cutoff includes them.
function cutoffIso(ageDays: number): string {
  return new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000).toISOString();
}

test('draft-expiry sweep statements + expired constraint run against real Postgres', async (t) => {
  if (!dbConfig) {
    console.warn(
      '\n[draft-expiry-sweep-requires-infra] SKIPPED: DB env not all set. This test ' +
        'MUST run against a real database in CI/prod validation — a skip means the ' +
        "real planner and the 'expired' CHECK constraint were never exercised.\n",
    );
    requireDbEnvOrSkip(t);
    return;
  }

  const cutoff = cutoffIso(14);
  const pool = new pg.Pool(dbConfig);
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Plan-validation: every statement parses + plans against real schema.
      //    id=-1 / no-op writes; the predicate touches scheduled_posts + posts.
      await client.query(COUNT_SQL, [cutoff]);
      await client.query(COUNT_BY_TENANT_SQL, [cutoff]);
      await client.query(SELECT_BATCH_SQL, [cutoff, 1]);
      const noop = await client.query(EXPIRE_BATCH_SQL, [cutoff, [-1]]);
      assert.equal(noop.rowCount, 0, 'id=-1 matches nothing');

      // The write-path assertions need a valid organizations row to satisfy the
      // posts.tenant_id FK. Pick any existing one; if the DB has none (a bare
      // schema), the plan-validation above still proved the statements run.
      const org = await client.query('SELECT id FROM organizations ORDER BY id LIMIT 1');
      if (org.rowCount && org.rows[0]) {
        const tenantId = (org.rows[0] as { id: number }).id;

        // 2a. A stranded approved post (no scheduled_posts row, 60d old) expires.
        const ins = await client.query(
          `INSERT INTO posts (tenant_id, caption, published_status, status, published_at, created_at, updated_at)
           VALUES ($1, 'draft-expiry requires-infra test', 'approved', 'approved', NULL,
                   now() - interval '60 days', now() - interval '60 days')
           RETURNING id`,
          [tenantId],
        );
        const strandedId = (ins.rows[0] as { id: number }).id;

        const expired = await client.query(EXPIRE_BATCH_SQL, [cutoff, [strandedId]]);
        assert.equal(expired.rowCount, 1, 'the stranded post is expired');

        const after = await client.query(
          'SELECT published_status, status, expired_at FROM posts WHERE id = $1',
          [strandedId],
        );
        const row = after.rows[0] as { published_status: string; status: string; expired_at: string | null };
        assert.equal(row.published_status, 'expired', "published_status accepts 'expired'");
        assert.equal(row.status, 'expired', "legacy status accepts 'expired'");
        assert.ok(row.expired_at, 'expired_at is stamped');

        // 2b. A post WITH a scheduled_posts row is NOT expired (guard holds).
        const insSched = await client.query(
          `INSERT INTO posts (tenant_id, caption, published_status, status, published_at, created_at, updated_at)
           VALUES ($1, 'draft-expiry scheduled guard', 'approved', 'approved', NULL,
                   now() - interval '60 days', now() - interval '60 days')
           RETURNING id`,
          [tenantId],
        );
        const scheduledId = (insSched.rows[0] as { id: number }).id;
        await client.query(
          `INSERT INTO scheduled_posts (post_id, tenant_id, scheduled_for, target_platforms)
           VALUES ($1, $2, now() + interval '1 day', ARRAY['instagram'])`,
          [scheduledId, tenantId],
        );
        const guarded = await client.query(EXPIRE_BATCH_SQL, [cutoff, [scheduledId]]);
        assert.equal(guarded.rowCount, 0, 'a scheduled post is never expired');

        // 2c. A too-recent post is NOT expired (age guard holds).
        const insRecent = await client.query(
          `INSERT INTO posts (tenant_id, caption, published_status, status, published_at, created_at, updated_at)
           VALUES ($1, 'draft-expiry recent guard', 'approved', 'approved', NULL, now(), now())
           RETURNING id`,
          [tenantId],
        );
        const recentId = (insRecent.rows[0] as { id: number }).id;
        const recent = await client.query(EXPIRE_BATCH_SQL, [cutoff, [recentId]]);
        assert.equal(recent.rowCount, 0, 'a too-recent post is never expired');

        // 2d. A FB-native-scheduled post (published_status='scheduled', legacy
        // status left at 'draft' default, a Meta platform_post_id, no
        // scheduled_posts row, published_at NULL) is NOT expired. This is the
        // false-positive the adversarial review caught — the predicate must key
        // on canonical published_status + guard platform_post_id IS NULL, not
        // OR on the stale legacy status.
        const insMeta = await client.query(
          `INSERT INTO posts (tenant_id, caption, published_status, status, platform_post_id, scheduled_at, published_at, created_at, updated_at)
           VALUES ($1, 'draft-expiry meta-native guard', 'scheduled', 'draft', 'fb_17841_test',
                   now() + interval '1 day', NULL, now() - interval '60 days', now() - interval '60 days')
           RETURNING id`,
          [tenantId],
        );
        const metaId = (insMeta.rows[0] as { id: number }).id;
        const meta = await client.query(EXPIRE_BATCH_SQL, [cutoff, [metaId]]);
        assert.equal(meta.rowCount, 0, 'a Meta-native-scheduled post is never expired');

        console.log('[draft-expiry-sweep-requires-infra] PASS: expired write + all three guards verified.');
      } else {
        console.log(
          '[draft-expiry-sweep-requires-infra] PASS (plan-only): no organizations row to ' +
            'exercise the write path; all four statements planned against real Postgres.',
        );
      }

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
});
