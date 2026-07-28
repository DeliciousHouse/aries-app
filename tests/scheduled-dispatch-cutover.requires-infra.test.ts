import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import pg from 'pg';

import { requireDbEnvOrSkip } from './helpers/requires-infra';

const require = createRequire(import.meta.url);
const { quarantineLegacyScheduledDispatches } = require('../scripts/scheduled-dispatch-cutover.js') as {
  quarantineLegacyScheduledDispatches: (client: pg.PoolClient) => Promise<{
    scheduledPosts: number;
    platformDispatches: number;
    postsUnverified: number;
  }>;
};

test('production cutover CTE quarantines legacy ambiguity against PostgreSQL TEXT token DDL', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;

  const schema = `scheduled_cutover_${process.pid}_${Date.now()}`;
  const connection = {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  };
  const admin = new pg.Pool({ ...connection, max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new pg.Pool({
    ...connection,
    max: 2,
    options: `-c search_path="${schema}"`,
  });

  try {
    await pool.query(`
      CREATE TABLE posts (
        id BIGINT PRIMARY KEY,
        published_status TEXT NOT NULL
      );
      CREATE TABLE scheduled_posts (
        id BIGINT PRIMARY KEY,
        post_id BIGINT NOT NULL,
        dispatch_status TEXT NOT NULL,
        dispatch_attempt_token TEXT,
        dispatch_started_at TIMESTAMPTZ,
        error_at TIMESTAMPTZ,
        error_message TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE scheduled_post_dispatches (
        id BIGINT PRIMARY KEY,
        scheduled_post_id BIGINT NOT NULL,
        status TEXT NOT NULL,
        error_at TIMESTAMPTZ,
        error_message TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      INSERT INTO posts (id, published_status)
      VALUES (1, 'approved'), (2, 'approved'), (3, 'approved');
      INSERT INTO scheduled_posts (
        id, post_id, dispatch_status, dispatch_attempt_token, dispatch_started_at
      ) VALUES
        (101, 1, 'in_flight', 'legacy-worker:attempt-101', NULL),
        (102, 2, 'in_flight', 'provider-fenced:attempt-102', now()),
        (103, 3, 'pending', NULL, NULL);
      INSERT INTO scheduled_post_dispatches (id, scheduled_post_id, status, error_message)
      VALUES
        (1001, 101, 'in_flight', NULL),
        (1002, 102, 'in_flight', NULL),
        (1003, 103, 'failed', 'instagram_publish_missing_id: transport ended without an id');
    `);

    const typeResult = await pool.query(`
      SELECT data_type
        FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'scheduled_posts'
         AND column_name = 'dispatch_attempt_token'
    `);
    assert.equal(typeResult.rows[0]?.data_type, 'text');

    const client = await pool.connect();
    try {
      const result = await quarantineLegacyScheduledDispatches(client);
      assert.deepEqual(result, {
        scheduledPosts: 2,
        platformDispatches: 2,
        postsUnverified: 2,
      });

      const owners = await client.query(`
        SELECT id, dispatch_status, dispatch_attempt_token
          FROM scheduled_posts
         ORDER BY id
      `);
      assert.deepEqual(owners.rows, [
        { id: '101', dispatch_status: 'manual_reconciliation', dispatch_attempt_token: 'legacy-worker:attempt-101' },
        { id: '102', dispatch_status: 'in_flight', dispatch_attempt_token: 'provider-fenced:attempt-102' },
        { id: '103', dispatch_status: 'manual_reconciliation', dispatch_attempt_token: null },
      ]);

      const children = await client.query(`
        SELECT id, status
          FROM scheduled_post_dispatches
         ORDER BY id
      `);
      assert.deepEqual(children.rows, [
        { id: '1001', status: 'manual_reconciliation' },
        { id: '1002', status: 'in_flight' },
        { id: '1003', status: 'manual_reconciliation' },
      ]);

      const posts = await client.query('SELECT id, published_status FROM posts ORDER BY id');
      assert.deepEqual(posts.rows, [
        { id: '1', published_status: 'unverified' },
        { id: '2', published_status: 'approved' },
        { id: '3', published_status: 'unverified' },
      ]);

      assert.deepEqual(await quarantineLegacyScheduledDispatches(client), {
        scheduledPosts: 0,
        platformDispatches: 0,
        postsUnverified: 0,
      });
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});
