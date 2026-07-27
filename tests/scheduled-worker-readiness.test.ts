import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  runWorkerReadinessCheck: (
    pool: ReadinessPool,
    options?: { fetchImpl?: typeof fetch; baseUrl?: string; secret?: string },
  ) => Promise<void>;
  WORKER_READINESS_SQL: string;
};

const WORKER_SRC = readFileSync(
  path.join(REPO_ROOT, 'scripts/automations/scheduled-posts-worker.mjs'),
  'utf8',
);

async function loadWorker(): Promise<WorkerModule> {
  return (await import(
    pathToFileURL(path.join(REPO_ROOT, 'scripts/automations/scheduled-posts-worker.mjs')).href
  )) as unknown as WorkerModule;
}

test('one-shot worker readiness proves DB, required schema, and provider-fence protocol access', async () => {
  const { runWorkerReadinessCheck, WORKER_READINESS_SQL } = await loadWorker();
  const calls: string[] = [];
  const authCalls: Array<{ url: string; init?: RequestInit }> = [];
  await runWorkerReadinessCheck({
    query: async (sql) => {
      calls.push(sql);
      return { rows: [{ schema_ready: true, protocol_ready: true }], rowCount: 1 };
    },
  }, {
    baseUrl: 'https://aries.example.test/',
    secret: 'x',
    fetchImpl: async (input, init) => {
      authCalls.push({ url: String(input), init });
      return new Response(JSON.stringify({ status: 'ready' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(authCalls.length, 1);
  assert.equal(authCalls[0]?.url, 'https://aries.example.test/api/internal/publishing/scheduled-dispatch');
  assert.equal(authCalls[0]?.init?.method, 'GET');
  assert.equal(
    (authCalls[0]?.init?.headers as Record<string, string> | undefined)?.authorization,
    'Bearer x',
  );
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
      }, { baseUrl: 'https://aries.example.test', secret: 'readiness-secret' }),
      /database unavailable/,
    );
  });

  await t.test('schema access', async () => {
    await assert.rejects(
      runWorkerReadinessCheck({
        query: async () => ({ rows: [{ schema_ready: false, protocol_ready: true }], rowCount: 1 }),
      }, { baseUrl: 'https://aries.example.test', secret: 'readiness-secret' }),
      /scheduled_worker_schema_not_ready/,
    );
  });

  await t.test('protocol access', async () => {
    await assert.rejects(
      runWorkerReadinessCheck({
        query: async () => ({ rows: [{ schema_ready: true, protocol_ready: false }], rowCount: 1 }),
      }, { baseUrl: 'https://aries.example.test', secret: 'readiness-secret' }),
      /scheduled_worker_protocol_not_ready/,
    );
  });
});

test('worker readiness fails closed when worker-to-app authentication is unusable', async (t) => {
  const { runWorkerReadinessCheck } = await loadWorker();
  const readyPool: ReadinessPool = {
    query: async () => ({ rows: [{ schema_ready: true, protocol_ready: true }], rowCount: 1 }),
  };

  await t.test('missing worker secret', async () => {
    let fetchCalls = 0;
    await assert.rejects(
      runWorkerReadinessCheck(readyPool, {
        baseUrl: 'https://aries.example.test',
        secret: '',
        fetchImpl: async () => {
          fetchCalls += 1;
          return new Response(null, { status: 200 });
        },
      }),
      /scheduled_worker_internal_api_secret_not_configured/,
    );
    assert.equal(fetchCalls, 0, 'empty local auth must fail before contacting the app');
  });

  await t.test('mismatched worker secret', async () => {
    await assert.rejects(
      runWorkerReadinessCheck(readyPool, {
        baseUrl: 'https://aries.example.test',
        secret: 'wrong-secret',
        fetchImpl: async () => new Response(JSON.stringify({ error: 'invalid_internal_auth' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
      }),
      /scheduled_worker_auth_not_ready:401:invalid_internal_auth/,
    );
  });

  await t.test('app has no configured secret', async () => {
    await assert.rejects(
      runWorkerReadinessCheck(readyPool, {
        baseUrl: 'https://aries.example.test',
        secret: 'worker-secret',
        fetchImpl: async () => new Response(JSON.stringify({ error: 'internal_api_secret_not_configured' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
      }),
      /scheduled_worker_auth_not_ready:503:internal_api_secret_not_configured/,
    );
  });
});

test('normal worker startup runs readiness before creating the polling runtime', () => {
  const mainBody = WORKER_SRC.slice(WORKER_SRC.indexOf('async function main()'));
  assert.match(
    mainBody,
    /const readinessOnly = process\.env\.ARIES_SCHEDULED_POSTS_READINESS_CHECK\?\.trim\(\) === '1';\s+try \{\s+await runWorkerReadinessCheck\(pool\);/,
    'readiness must run unconditionally at startup, not only in one-shot probe mode',
  );
  assert.ok(
    mainBody.indexOf('await runWorkerReadinessCheck(pool);')
      < mainBody.indexOf('createScheduledPostsWorkerRuntime(pool)'),
    'polling must not start before authentication readiness succeeds',
  );
});
