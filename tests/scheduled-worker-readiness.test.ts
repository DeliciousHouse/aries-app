import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

type ReadinessPool = {
  query: (sql: string) => Promise<{
    rows: Array<{ schema_ready?: boolean; protocol_ready?: boolean }>;
    rowCount: number;
  }>;
};

type WorkerModule = {
  runWorkerReadinessCheck: (pool: ReadinessPool) => Promise<void>;
  WORKER_READINESS_SQL: string;
};

async function loadWorker(): Promise<WorkerModule> {
  return (await import(
    pathToFileURL(path.join(REPO_ROOT, 'scripts/automations/scheduled-posts-worker.mjs')).href
  )) as unknown as WorkerModule;
}

test('one-shot worker readiness proves DB, required schema, and provider-fence protocol access', async () => {
  const { runWorkerReadinessCheck, WORKER_READINESS_SQL } = await loadWorker();
  const calls: string[] = [];
  await runWorkerReadinessCheck({
    query: async (sql) => {
      calls.push(sql);
      return { rows: [{ schema_ready: true, protocol_ready: true }], rowCount: 1 };
    },
  });

  assert.equal(calls.length, 1);
  assert.match(WORKER_READINESS_SQL, /scheduled_posts/);
  assert.match(WORKER_READINESS_SQL, /scheduled_post_dispatches/);
  assert.match(WORKER_READINESS_SQL, /dispatch_started_at/);
  assert.match(WORKER_READINESS_SQL, /manual_reconciliation/);
});

test('one-shot worker readiness exits through an error for DB, schema, or protocol failure', async (t) => {
  const { runWorkerReadinessCheck } = await loadWorker();

  await t.test('database access', async () => {
    await assert.rejects(
      runWorkerReadinessCheck({
        query: async () => { throw new Error('database unavailable'); },
      }),
      /database unavailable/,
    );
  });

  await t.test('schema access', async () => {
    await assert.rejects(
      runWorkerReadinessCheck({
        query: async () => ({ rows: [{ schema_ready: false, protocol_ready: true }], rowCount: 1 }),
      }),
      /scheduled_worker_schema_not_ready/,
    );
  });

  await t.test('protocol access', async () => {
    await assert.rejects(
      runWorkerReadinessCheck({
        query: async () => ({ rows: [{ schema_ready: true, protocol_ready: false }], rowCount: 1 }),
      }),
      /scheduled_worker_protocol_not_ready/,
    );
  });
});
