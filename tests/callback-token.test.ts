import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import pool from '../lib/db';

type CallbackTokenRow = {
  token_hash: string;
  aries_run_id: string;
  tenant_id: number;
  issued_at: string;
  consumed_at: string | null;
};

async function withCallbackEnv<T>(run: () => Promise<T>): Promise<T> {
  const previousDataRoot = process.env.DATA_ROOT;
  const previousSecret = process.env.INTERNAL_API_SECRET;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-callback-token-'));

  process.env.DATA_ROOT = dataRoot;
  process.env.INTERNAL_API_SECRET = 'internal-secret';
  try {
    return await run();
  } finally {
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    if (previousSecret === undefined) delete process.env.INTERNAL_API_SECRET;
    else process.env.INTERNAL_API_SECRET = previousSecret;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

function callbackRequest(body: unknown, opts?: { bearer?: string }): Request {
  return new Request('https://aries.example.com/api/internal/hermes/runs', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${opts?.bearer ?? 'internal-secret'}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function createCallbackTokensHarness() {
  const rows = new Map<string, CallbackTokenRow>();

  function seed(token: string, aries_run_id: string, tenant_id = 123): void {
    const hash = sha256Hex(token);
    rows.set(hash, {
      token_hash: hash,
      aries_run_id,
      tenant_id,
      issued_at: new Date().toISOString(),
      consumed_at: null,
    });
  }

  async function query(sql: string, params: unknown[] = []) {
    const text = String(sql);

    if (text.includes('FROM oauth_callback_tokens')) {
      const tokenHash = String(params[0]);
      const row = rows.get(tokenHash);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (text.includes('INSERT INTO oauth_callback_tokens')) {
      const tokenHash = String(params[0]);
      const aries_run_id = String(params[1]);
      const tenant_id = Number(params[2]);
      rows.set(tokenHash, {
        token_hash: tokenHash,
        aries_run_id,
        tenant_id,
        issued_at: new Date().toISOString(),
        consumed_at: null,
      });
      return { rows: [], rowCount: 1 };
    }

    if (text.includes('UPDATE oauth_callback_tokens')) {
      const tokenHash = String(params[0]);
      const existing = rows.get(tokenHash);
      if (existing) {
        existing.consumed_at = new Date().toISOString();
      }
      return { rows: [], rowCount: existing ? 1 : 0 };
    }

    throw new Error(`Unhandled SQL in callback-token harness: ${text}`);
  }

  return { rows, seed, query };
}

test('callback rejected with 403 when callback_token missing from body', async (t) => {
  await withCallbackEnv(async () => {
    const { createExecutionRunRecord } = await import('../backend/execution/run-store');
    const { POST } = await import('../app/api/internal/hermes/runs/route');

    const harness = createCallbackTokensHarness();
    t.mock.method(pool, 'query', harness.query as typeof pool.query);

    const record = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'route',
      workflowKey: 'demo_start',
      action: 'run',
      tenantId: '123',
    });

    const validToken = randomBytes(32).toString('hex');
    harness.seed(validToken, record.aries_run_id);

    const response = await POST(callbackRequest({
      event_id: 'evt-missing-token',
      aries_run_id: record.aries_run_id,
      hermes_run_id: 'hermes-run-1',
      status: 'completed',
      output: [{ ok: true }],
    }));

    assert.equal(response.status, 403);
    const body = await response.json() as { status: string; reason: string };
    assert.equal(body.status, 'error');
    assert.equal(body.reason, 'missing_callback_token');
  });
});

test('callback rejected with 403 when callback_token does not match stored hash', async (t) => {
  await withCallbackEnv(async () => {
    const { createExecutionRunRecord } = await import('../backend/execution/run-store');
    const { POST } = await import('../app/api/internal/hermes/runs/route');

    const harness = createCallbackTokensHarness();
    t.mock.method(pool, 'query', harness.query as typeof pool.query);

    const record = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'route',
      workflowKey: 'demo_start',
      action: 'run',
      tenantId: '123',
    });

    const validToken = randomBytes(32).toString('hex');
    const wrongToken = randomBytes(32).toString('hex');
    harness.seed(validToken, record.aries_run_id);

    const response = await POST(callbackRequest({
      event_id: 'evt-wrong-token',
      aries_run_id: record.aries_run_id,
      hermes_run_id: 'hermes-run-1',
      status: 'completed',
      output: [{ ok: true }],
      callback_token: wrongToken,
    }));

    assert.equal(response.status, 403);
    const body = await response.json() as { status: string; reason: string };
    assert.equal(body.status, 'error');
    assert.equal(body.reason, 'invalid_callback_token');
  });
});

test('callback accepted with 200 when callback_token matches stored hash', async (t) => {
  await withCallbackEnv(async () => {
    const { createExecutionRunRecord, loadExecutionRunRecord } = await import('../backend/execution/run-store');
    const { POST } = await import('../app/api/internal/hermes/runs/route');

    const harness = createCallbackTokensHarness();
    t.mock.method(pool, 'query', harness.query as typeof pool.query);

    const record = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'route',
      workflowKey: 'demo_start',
      action: 'run',
      tenantId: '123',
    });

    const validToken = randomBytes(32).toString('hex');
    harness.seed(validToken, record.aries_run_id);

    const response = await POST(callbackRequest({
      event_id: 'evt-correct-token',
      aries_run_id: record.aries_run_id,
      hermes_run_id: 'hermes-run-1',
      status: 'completed',
      output: [{ ok: true }],
      callback_token: validToken,
    }));

    assert.equal(response.status, 200);
    const body = await response.json() as { status: string; ariesRunId: string; duplicate: boolean };
    assert.equal(body.status, 'accepted');
    assert.equal(body.ariesRunId, record.aries_run_id);
    assert.equal(body.duplicate, false);

    const reloaded = loadExecutionRunRecord(record.aries_run_id);
    assert.equal(reloaded?.status, 'completed');
  });
});

test('callback re-delivery accepted with 200 (event_id dedup) even after token is consumed', async (t) => {
  await withCallbackEnv(async () => {
    const { createExecutionRunRecord } = await import('../backend/execution/run-store');
    const { POST } = await import('../app/api/internal/hermes/runs/route');

    const harness = createCallbackTokensHarness();
    t.mock.method(pool, 'query', harness.query as typeof pool.query);

    const record = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'route',
      workflowKey: 'demo_start',
      action: 'run',
      tenantId: '123',
    });

    const validToken = randomBytes(32).toString('hex');
    harness.seed(validToken, record.aries_run_id);

    const payload = {
      event_id: 'evt-reuse',
      aries_run_id: record.aries_run_id,
      hermes_run_id: 'hermes-run-1',
      status: 'completed',
      output: [{ ok: true }],
      callback_token: validToken,
    };

    const first = await POST(callbackRequest(payload));
    assert.equal(first.status, 200);
    const firstBody = await first.json() as { duplicate: boolean };
    assert.equal(firstBody.duplicate, false);

    const second = await POST(callbackRequest(payload));
    assert.equal(second.status, 200);
    const secondBody = await second.json() as { duplicate: boolean };
    assert.equal(secondBody.duplicate, true);
  });
});

test('callback rejected with 403 when callback_token is correct but for a different aries_run_id', async (t) => {
  await withCallbackEnv(async () => {
    const { createExecutionRunRecord } = await import('../backend/execution/run-store');
    const { POST } = await import('../app/api/internal/hermes/runs/route');

    const harness = createCallbackTokensHarness();
    t.mock.method(pool, 'query', harness.query as typeof pool.query);

    const recordA = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'route',
      workflowKey: 'demo_start',
      action: 'run',
      tenantId: '123',
    });
    const recordB = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'route',
      workflowKey: 'demo_start',
      action: 'run',
      tenantId: '123',
    });

    const tokenForA = randomBytes(32).toString('hex');
    harness.seed(tokenForA, recordA.aries_run_id);

    const response = await POST(callbackRequest({
      event_id: 'evt-cross-run',
      aries_run_id: recordB.aries_run_id,
      hermes_run_id: 'hermes-run-1',
      status: 'completed',
      output: [{ ok: true }],
      callback_token: tokenForA,
    }));

    assert.equal(response.status, 403);
    const body = await response.json() as { status: string; reason: string };
    assert.equal(body.status, 'error');
    assert.equal(body.reason, 'invalid_callback_token');
  });
});

test('Hermes submission generates a per-run callback_token and stores its SHA-256 hash', async (t) => {
  await withCallbackEnv(async () => {
    process.env.HERMES_GATEWAY_URL = 'http://hermes.test';
    process.env.HERMES_API_SERVER_KEY = 'server-key';
    process.env.APP_BASE_URL = 'https://aries.example.com';
    process.env.HERMES_SESSION_KEY = 'main';

    const harness = createCallbackTokensHarness();
    t.mock.method(pool, 'query', harness.query as typeof pool.query);

    const insertedTokens: { hash: string; aries_run_id: string; tenant_id: number }[] = [];
    const originalQuery = harness.query;
    const wrappedQuery = async (sql: string, params: unknown[] = []) => {
      if (String(sql).includes('INSERT INTO oauth_callback_tokens')) {
        insertedTokens.push({
          hash: String(params[0]),
          aries_run_id: String(params[1]),
          tenant_id: Number(params[2]),
        });
      }
      return originalQuery(sql, params);
    };
    t.mock.method(pool, 'query', wrappedQuery as typeof pool.query);

    let captured: { url: string; body: unknown } | null = null;
    const fetchImpl: typeof fetch = async (input, init) => {
      captured = {
        url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      };
      return new Response(JSON.stringify({ run_id: 'hermes-run-99' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const { HermesMarketingPort } = await import('../backend/marketing/ports/hermes');
    const port = new HermesMarketingPort(process.env, fetchImpl);

    const result = await port.runPipeline({
      jobId: 'job-test',
      doc: {
        schema_name: 'aries_marketing_job',
        schema_version: '1.0.0',
        job_id: 'job-test',
        tenant_id: '123',
        status: 'queued',
        stage: 'research',
        inputs: { request: { jobType: 'weekly_social_content' } },
        artifacts: {},
        approvals: [],
        events: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as unknown as Parameters<typeof port.runPipeline>[0]['doc'],
      argsJson: '{}',
      timeoutMs: 1_000,
      maxStdoutBytes: 65_536,
    });

    assert.equal(result.kind, 'submitted');
    assert.ok(captured, 'expected fetch to have been called');
    const body = (captured as { body: Record<string, unknown> }).body;
    const callbackAuth = body.callback_auth as Record<string, unknown> | undefined;
    assert.ok(callbackAuth, 'callback_auth should be present');
    assert.equal(typeof callbackAuth.callback_token, 'string');
    const plaintext = callbackAuth.callback_token as string;
    assert.equal(plaintext.length, 64, 'callback_token must be 64 hex chars (32 bytes)');
    assert.match(plaintext, /^[0-9a-f]{64}$/);

    assert.equal(insertedTokens.length, 1);
    assert.equal(insertedTokens[0].hash, sha256Hex(plaintext));
    assert.notEqual(insertedTokens[0].hash, plaintext);
  });
});
