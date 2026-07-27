import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

import { requireDbEnvOrSkip } from './helpers/requires-infra';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER_PATH = path.join(REPO_ROOT, 'scripts/automations/scheduled-posts-worker.mjs');

type WorkerModule = {
  SWEEP_AMBIGUOUS_DISPATCH_SQL: string;
  SWEEP_DEAD_CAMPAIGN_SQL: string;
};

async function loadWorker(): Promise<WorkerModule> {
  return (await import(pathToFileURL(WORKER_PATH).href)) as unknown as WorkerModule;
}

type SweepCase = {
  name: string;
  sql: string;
  ownerStatus: string;
  childStatus: string;
  dispatchStartedAt: string | null;
  campaignEndDate: string | null;
  expected: { canonical: string; owner: string; child: string };
};

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}_did_not_complete`)), 2_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test('production sweeps execute against PostgreSQL in canonical-first order with atomic outcomes', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;

  const worker = await loadWorker();
  const sweepCases: SweepCase[] = [
    {
      name: 'dead-campaign',
      sql: worker.SWEEP_DEAD_CAMPAIGN_SQL,
      ownerStatus: 'pending',
      childStatus: 'pending',
      dispatchStartedAt: null,
      campaignEndDate: '2020-01-01T00:00:00.000Z',
      expected: { canonical: 'expired', owner: 'failed', child: 'failed' },
    },
    {
      name: 'ambiguous-dispatch',
      sql: worker.SWEEP_AMBIGUOUS_DISPATCH_SQL,
      ownerStatus: 'in_flight',
      childStatus: 'in_flight',
      dispatchStartedAt: '2020-01-01T00:00:01.000Z',
      campaignEndDate: null,
      expected: {
        canonical: 'unverified',
        owner: 'manual_reconciliation',
        child: 'manual_reconciliation',
      },
    },
  ];

  const schema = `scheduled_sweep_lock_${process.pid}_${Date.now()}`;
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
        published_status TEXT NOT NULL,
        status TEXT NOT NULL,
        published_at TIMESTAMPTZ,
        platform_post_id TEXT,
        expired_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE scheduled_posts (
        id BIGINT PRIMARY KEY,
        post_id BIGINT NOT NULL,
        tenant_id INTEGER NOT NULL,
        scheduled_for TIMESTAMPTZ NOT NULL,
        campaign_end_date TIMESTAMPTZ,
        dispatch_status TEXT NOT NULL,
        dispatch_claimed_at TIMESTAMPTZ,
        dispatch_started_at TIMESTAMPTZ,
        error_at TIMESTAMPTZ,
        error_message TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE scheduled_post_dispatches (
        id BIGSERIAL PRIMARY KEY,
        scheduled_post_id BIGINT NOT NULL,
        status TEXT NOT NULL,
        error_at TIMESTAMPTZ,
        error_message TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    for (const scenario of sweepCases) {
      await t.test(scenario.name, async () => {
        await pool.query('TRUNCATE scheduled_post_dispatches, scheduled_posts, posts RESTART IDENTITY');
        await pool.query(
          `INSERT INTO posts (id, tenant_id, published_status, status)
           VALUES (42, 15, 'approved', 'approved')`,
        );
        await pool.query(
          `INSERT INTO scheduled_posts (
             id, post_id, tenant_id, scheduled_for, campaign_end_date,
             dispatch_status, dispatch_claimed_at, dispatch_started_at
           ) VALUES (71, 42, 15, '2020-01-01T00:00:00Z', $1, $2, '2020-01-01T00:00:00Z', $3)`,
          [scenario.campaignEndDate, scenario.ownerStatus, scenario.dispatchStartedAt],
        );
        await pool.query(
          `INSERT INTO scheduled_post_dispatches (scheduled_post_id, status)
           VALUES (71, $1)`,
          [scenario.childStatus],
        );

        const route = await pool.connect();
        const sweep = await pool.connect();
        try {
          await route.query('BEGIN');
          await route.query('SELECT id FROM posts WHERE id = 42 AND tenant_id = 15 FOR UPDATE');
          await sweep.query("SET statement_timeout = '750ms'");

          // A route owns the canonical lock. Production sweep SQL must skip it
          // without first taking the owner lock; malformed or reversed SQL
          // either fails to prepare or hits the bounded statement timeout.
          const blockedPass = await within(
            sweep.query<{ swept: number; posts_expired?: number }>(
              scenario.sql,
              [10, '2021-01-01T00:00:00.000Z'],
            ),
            `${scenario.name}_sweep_while_route_locked`,
          );
          assert.equal(Number(blockedPass.rows[0]?.swept ?? 0), 0);

          // The live route can still lock the scheduled owner while retaining
          // canonical ownership. A scheduled-first sweep would deadlock here.
          await within(
            route.query('SELECT id FROM scheduled_posts WHERE id = 71 FOR UPDATE'),
            `${scenario.name}_route_owner_lock`,
          );
          const whileLocked = await route.query<{
            canonical: string;
            owner: string;
            child: string;
          }>(`
            SELECT post.published_status AS canonical,
                   owner.dispatch_status AS owner,
                   child.status AS child
              FROM posts post
              JOIN scheduled_posts owner ON owner.post_id = post.id
              JOIN scheduled_post_dispatches child ON child.scheduled_post_id = owner.id
             WHERE post.id = 42
          `);
          assert.deepEqual(whileLocked.rows[0], {
            canonical: 'approved',
            owner: scenario.ownerStatus,
            child: scenario.childStatus,
          });
          await route.query('COMMIT');

          const terminalPass = await within(
            sweep.query<{ swept: number; posts_expired?: number }>(
              scenario.sql,
              [10, '2021-01-01T00:00:00.000Z'],
            ),
            `${scenario.name}_terminal_sweep`,
          );
          assert.equal(Number(terminalPass.rows[0]?.swept ?? 0), 1);
          const finalState = await pool.query<{
            canonical: string;
            owner: string;
            child: string;
          }>(`
            SELECT post.published_status AS canonical,
                   owner.dispatch_status AS owner,
                   child.status AS child
              FROM posts post
              JOIN scheduled_posts owner ON owner.post_id = post.id
              JOIN scheduled_post_dispatches child ON child.scheduled_post_id = owner.id
             WHERE post.id = 42
          `);
          assert.deepEqual(finalState.rows[0], scenario.expected);
        } finally {
          await route.query('ROLLBACK').catch(() => {});
          route.release();
          sweep.release();
        }
      });
    }
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});
