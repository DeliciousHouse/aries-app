/**
 * tests/marketing/auto-publish-gate-live-db.test.ts
 *
 * Owner-gated auto-publish — REAL Postgres. The self-contained suite
 * (auto-publish-gate.test.ts) proves the admit predicate is present and
 * correctly shaped; only a real planner proves it does what it reads like.
 *
 * The three properties that matter, none of which a string assertion can show:
 *
 *   1. Gate OFF  → every row still dispatches and still sweeps. The feature
 *      ships dark and the pre-gate behaviour is intact.
 *   2. Gate ON   → an opted-in tenant dispatches; a tenant with no row, or with
 *      enabled=false, is HELD (neither claimed nor due-scanned).
 *   3. Gate ON   → a HELD row past campaign_end_date SURVIVES the dead-campaign
 *      sweep. This is the one that protects the week: without it the gate would
 *      convert "waiting for the owner" into "failed, post expired".
 *
 * Builds its own schema in a throwaway namespace, so it needs a reachable
 * Postgres but not the app's migrations. Skips cleanly without DB env.
 *
 * Run:
 *   DB_HOST=… DB_PORT=… DB_USER=… DB_PASSWORD=… DB_NAME=… \
 *     ./node_modules/.bin/tsx --test tests/marketing/auto-publish-gate-live-db.test.ts
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Client } from 'pg';

import { requireDbEnvOrSkip } from '../helpers/requires-infra';

// Plain `.mjs`, no declaration file — dynamic import through pathToFileURL is
// the repo convention (see tests/scheduled-post-partial-dispatch.test.ts).
type WorkerSql = {
  CLAIM_ROW_SQL: string;
  DUE_ROWS_SQL: string;
  SWEEP_DEAD_CAMPAIGN_SQL: string;
};

// `../..` — one directory deeper than tests/, so the shared resolveProjectRoot
// helper (which climbs exactly one level) would land on tests/.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function workerSql(): Promise<WorkerSql> {
  return (await import(
    pathToFileURL(path.join(REPO_ROOT, 'scripts/automations/scheduled-posts-worker.mjs')).href
  )) as unknown as WorkerSql;
}

const SCHEMA = 'auto_publish_gate_test';

const SCHEMA_SQL = `
DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;
CREATE SCHEMA ${SCHEMA};
SET search_path TO ${SCHEMA};

CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  caption TEXT,
  platform_post_id TEXT,
  published_at TIMESTAMPTZ,
  published_status TEXT,
  status TEXT,
  expired_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE scheduled_posts (
  id SERIAL PRIMARY KEY,
  post_id TEXT NOT NULL,
  tenant_id INTEGER NOT NULL,
  scheduled_for TIMESTAMPTZ NOT NULL,
  target_platforms TEXT[],
  campaign_end_date TIMESTAMPTZ,
  surface TEXT,
  media_type TEXT,
  width_px INTEGER,
  height_px INTEGER,
  duration_seconds INTEGER,
  dispatch_status TEXT NOT NULL DEFAULT 'pending',
  dispatch_attempt_token TEXT,
  dispatch_claimed_at TIMESTAMPTZ,
  dispatch_started_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  error_at TIMESTAMPTZ,
  error_message TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE scheduled_post_dispatches (
  id SERIAL PRIMARY KEY,
  scheduled_post_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error_at TIMESTAMPTZ,
  error_message TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE marketing_auto_publish_settings (
  tenant_id INTEGER PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT false,
  updated_by_user_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

/** Tenant 1 opted in, tenant 2 explicitly opted out, tenant 3 never seeded. */
const SEED_SQL = `
SET search_path TO ${SCHEMA};
INSERT INTO marketing_auto_publish_settings (tenant_id, enabled) VALUES (1, true), (2, false);

INSERT INTO posts (id, tenant_id, caption, published_status, status) VALUES
  ('p-optedin',  1, 'opted in',  'approved', 'approved'),
  ('p-optedout', 2, 'opted out', 'approved', 'approved'),
  ('p-unseeded', 3, 'unseeded',  'approved', 'approved');

-- Due now, campaign still open: the dispatch case.
INSERT INTO scheduled_posts (id, post_id, tenant_id, scheduled_for, campaign_end_date, dispatch_status) VALUES
  (1, 'p-optedin',  1, NOW() - INTERVAL '1 hour', NOW() + INTERVAL '7 days', 'pending'),
  (2, 'p-optedout', 2, NOW() - INTERVAL '1 hour', NOW() + INTERVAL '7 days', 'pending'),
  (3, 'p-unseeded', 3, NOW() - INTERVAL '1 hour', NOW() + INTERVAL '7 days', 'pending');
`;

/** Rows whose campaign window has closed: the sweep case. */
const SEED_DEAD_SQL = `
SET search_path TO ${SCHEMA};
UPDATE scheduled_posts
   SET scheduled_for     = NOW() - INTERVAL '10 days',
       campaign_end_date = NOW() - INTERVAL '1 day';
`;

const STALE_CUTOFF = new Date(Date.now() - 15 * 60 * 1000).toISOString();

async function connect(): Promise<Client> {
  const client = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  await client.connect();
  return client;
}

async function withSchema<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const client = await connect();
  try {
    await client.query(SCHEMA_SQL);
    await client.query(SEED_SQL);
    await client.query(`SET search_path TO ${SCHEMA}`);
    return await run(client);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
    await client.end().catch(() => {});
  }
}

async function dueIds(client: Client, gateEnabled: boolean): Promise<number[]> {
  const { DUE_ROWS_SQL } = await workerSql();
  const res = await client.query<{ id: number }>(DUE_ROWS_SQL, [50, STALE_CUTOFF, gateEnabled]);
  return res.rows.map((r) => Number(r.id)).sort((a, b) => a - b);
}

async function claimable(client: Client, rowId: number, gateEnabled: boolean): Promise<boolean> {
  // CLAIM_ROW_SQL takes row locks; keep it inside a transaction that is always
  // rolled back so one probe never affects the next.
  const { CLAIM_ROW_SQL } = await workerSql();
  await client.query('BEGIN');
  try {
    const res = await client.query(CLAIM_ROW_SQL, [rowId, STALE_CUTOFF, gateEnabled]);
    return res.rows.length > 0;
  } finally {
    await client.query('ROLLBACK');
  }
}

test('gate OFF: every tenant is due and claimable, exactly as before the gate', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;
  await withSchema(async (client) => {
    assert.deepEqual(await dueIds(client, false), [1, 2, 3]);
    for (const id of [1, 2, 3]) {
      assert.equal(await claimable(client, id, false), true, `row ${id} must be claimable`);
    }
  });
});

test('gate ON: only the opted-in tenant is due', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;
  await withSchema(async (client) => {
    assert.deepEqual(
      await dueIds(client, true),
      [1],
      'enabled=false and unseeded tenants must be held out of the due scan',
    );
  });
});

test('gate ON: held rows are not claimable even when addressed directly', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;
  await withSchema(async (client) => {
    assert.equal(await claimable(client, 1, true), true, 'opted-in tenant must still dispatch');
    assert.equal(await claimable(client, 2, true), false, 'enabled=false must be held');
    assert.equal(await claimable(client, 3, true), false, 'unseeded tenant must be held');
  });
});

test('gate ON: a held row past campaign_end_date survives the dead-campaign sweep', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;
  await withSchema(async (client) => {
    const { SWEEP_DEAD_CAMPAIGN_SQL } = await workerSql();
    await client.query(SEED_DEAD_SQL);
    const swept = await client.query<{ swept: number; posts_expired: number }>(
      SWEEP_DEAD_CAMPAIGN_SQL,
      [100, STALE_CUTOFF, true],
    );
    assert.equal(Number(swept.rows[0].swept), 1, 'only the opted-in tenant’s dead row may sweep');

    const rows = await client.query<{ dispatch_status: string; published_status: string }>(
      `SELECT sp.id, sp.dispatch_status, p.published_status
         FROM scheduled_posts sp JOIN posts p ON p.id = sp.post_id ORDER BY sp.id`,
    );
    assert.equal(rows.rows[0].dispatch_status, 'failed', 'opted-in dead row sweeps as before');
    assert.equal(rows.rows[0].published_status, 'expired');

    for (const idx of [1, 2]) {
      assert.equal(
        rows.rows[idx].dispatch_status,
        'pending',
        'a held row must NOT be marked failed for want of an owner click',
      );
      assert.equal(
        rows.rows[idx].published_status,
        'approved',
        'a held post must NOT be expired',
      );
    }
  });
});

test('gate OFF: the sweep still reaps every dead row', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;
  await withSchema(async (client) => {
    const { SWEEP_DEAD_CAMPAIGN_SQL } = await workerSql();
    await client.query(SEED_DEAD_SQL);
    const swept = await client.query<{ swept: number; posts_expired: number }>(
      SWEEP_DEAD_CAMPAIGN_SQL,
      [100, STALE_CUTOFF, false],
    );
    assert.equal(Number(swept.rows[0].swept), 3, 'gate off must not change sweep coverage');
    assert.equal(Number(swept.rows[0].posts_expired), 3);
  });
});
