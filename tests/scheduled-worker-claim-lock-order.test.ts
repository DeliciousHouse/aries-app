import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

import { requireDbEnvOrSkip } from './helpers/requires-infra';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER_PATH = path.join(REPO_ROOT, 'scripts/automations/scheduled-posts-worker.mjs');

type WorkerModule = {
  CLAIM_ROW_SQL: string;
  RELEASE_PRE_PROVIDER_CLAIM_SQL: string;
};

async function loadWorker(): Promise<WorkerModule> {
  return (await import(pathToFileURL(WORKER_PATH).href)) as unknown as WorkerModule;
}

test('real claim and release SQL serialize on canonical post before scheduled owner', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;

  const workerSql = await loadWorker();
  const schema = `scheduled_claim_lock_${process.pid}_${Date.now()}`;
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
    max: 6,
    options: `-c search_path="${schema}"`,
  });

  try {
    await pool.query(`
      CREATE TABLE posts (
        id BIGINT PRIMARY KEY,
        tenant_id INTEGER NOT NULL,
        caption TEXT,
        platform_post_id TEXT,
        published_status TEXT NOT NULL
      );
      CREATE TABLE scheduled_posts (
        id BIGINT PRIMARY KEY,
        post_id BIGINT NOT NULL,
        tenant_id INTEGER NOT NULL,
        target_platforms TEXT[] NOT NULL,
        surface TEXT,
        media_type TEXT,
        width_px INTEGER,
        height_px INTEGER,
        duration_seconds INTEGER,
        scheduled_for TIMESTAMPTZ NOT NULL,
        campaign_end_date TIMESTAMPTZ,
        dispatch_status TEXT NOT NULL,
        dispatch_attempt_token UUID,
        dispatch_claimed_at TIMESTAMPTZ,
        dispatch_started_at TIMESTAMPTZ,
        next_attempt_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE scheduled_post_dispatches (
        id BIGSERIAL PRIMARY KEY,
        scheduled_post_id BIGINT NOT NULL,
        status TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      INSERT INTO posts (id, tenant_id, caption, published_status)
      VALUES (42, 15, 'canonical-first', 'approved');
      INSERT INTO scheduled_posts (
        id, post_id, tenant_id, target_platforms, scheduled_for, dispatch_status
      ) VALUES (71, 42, 15, ARRAY['facebook'], now() - interval '1 minute', 'pending');
      INSERT INTO scheduled_post_dispatches (scheduled_post_id, status)
      VALUES (71, 'pending');
    `);

    await t.test('route canonical lock wins over worker claim without owner inversion', async () => {
      const route = await pool.connect();
      const worker = await pool.connect();
      try {
        await route.query('BEGIN');
        await route.query('SELECT id FROM posts WHERE id = 42 AND tenant_id = 15 FOR UPDATE');
        await worker.query('BEGIN');
        await worker.query("SET LOCAL statement_timeout = '750ms'");
        const claim = await worker.query(workerSql.CLAIM_ROW_SQL, [71, new Date(0).toISOString()]);
        assert.equal(claim.rowCount, 0, 'SKIP LOCKED observes the canonical winner before touching owner');

        await route.query("SET LOCAL statement_timeout = '750ms'");
        const owner = await route.query('SELECT id FROM scheduled_posts WHERE id = 71 FOR UPDATE');
        assert.equal(owner.rowCount, 1, 'route can take owner second without deadlocking');
      } finally {
        await route.query('ROLLBACK').catch(() => {});
        await worker.query('ROLLBACK').catch(() => {});
        route.release();
        worker.release();
      }
    });

    await t.test('worker claim wins both locks and later route waits at canonical', async () => {
      const worker = await pool.connect();
      const route = await pool.connect();
      try {
        await worker.query('BEGIN');
        const claim = await worker.query(workerSql.CLAIM_ROW_SQL, [71, new Date(0).toISOString()]);
        assert.equal(claim.rowCount, 1);
        await route.query('BEGIN');
        await route.query("SET LOCAL lock_timeout = '500ms'");
        await assert.rejects(
          route.query('SELECT id FROM posts WHERE id = 42 AND tenant_id = 15 FOR UPDATE'),
          (error: unknown) => (error as { code?: string }).code === '55P03',
        );
      } finally {
        await route.query('ROLLBACK').catch(() => {});
        await worker.query('ROLLBACK').catch(() => {});
        route.release();
        worker.release();
      }
    });

    await pool.query(`
      UPDATE scheduled_posts
         SET dispatch_status = 'in_flight',
             dispatch_attempt_token = '00000000-0000-4000-8000-000000000071',
             dispatch_claimed_at = now(),
             dispatch_started_at = NULL
       WHERE id = 71
    `);

    await t.test('route canonical lock wins over pre-provider release', async () => {
      const route = await pool.connect();
      const worker = await pool.connect();
      try {
        await route.query('BEGIN');
        await route.query('SELECT id FROM posts WHERE id = 42 AND tenant_id = 15 FOR UPDATE');
        const released = await worker.query(
          workerSql.RELEASE_PRE_PROVIDER_CLAIM_SQL,
          [71, '00000000-0000-4000-8000-000000000071'],
        );
        assert.equal(Number(released.rows[0]?.released ?? 0), 0);
        const owner = await route.query('SELECT dispatch_status FROM scheduled_posts WHERE id = 71 FOR UPDATE');
        assert.equal(owner.rows[0]?.dispatch_status, 'in_flight');
      } finally {
        await route.query('ROLLBACK').catch(() => {});
        route.release();
        worker.release();
      }
    });
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});
