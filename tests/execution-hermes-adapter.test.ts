import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ExecutionError } from '../backend/execution';
import {
  HermesExecutionAdapter,
  buildHermesRequestEnvelope,
} from '../backend/execution/providers/hermes';
import { TEST_HERMES_GATEWAY_URL, TEST_UNREACHABLE_URL } from './fixtures/service-urls';

type FetchCall = { url: string; init: RequestInit };

function recordingFetchSequence(responses: Array<() => Response>) {
  const calls: FetchCall[] = [];
  let i = 0;
  const fetchImpl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} });
    const make = responses[i] ?? responses[responses.length - 1];
    if (i < responses.length - 1) i += 1;
    return make();
  };
  return { calls, fetchImpl };
}

const NO_SLEEP = async () => {};

async function withDataRoot<T>(run: () => Promise<T>): Promise<T> {
  const previousDataRoot = process.env.DATA_ROOT;
  const previousAppBaseUrl = process.env.APP_BASE_URL;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-hermes-adapter-'));

  process.env.DATA_ROOT = dataRoot;
  process.env.APP_BASE_URL = 'https://aries.example.com';
  try {
    return await run();
  } finally {
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    if (previousAppBaseUrl === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = previousAppBaseUrl;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

test('HermesExecutionAdapter reports missing HERMES_GATEWAY_URL with an actionable ExecutionError', async () => {
  const adapter = new HermesExecutionAdapter({
    HERMES_API_SERVER_KEY: 'token-123',
  });

  const result = await adapter.runWorkflow('marketing_demo', { tenantId: 'tenant-123' });

  assert.equal(result.kind, 'gateway_error');
  if (result.kind !== 'gateway_error') {
    assert.fail('expected gateway_error result');
  }

  assert.ok(result.error instanceof ExecutionError);
  assert.equal(result.error.provider, 'hermes');
  assert.equal(result.error.code, 'not_configured');
  assert.equal(result.error.status, 503);
  assert.match(result.error.message, /HERMES_GATEWAY_URL/);
  assert.match(result.error.message, /ARIES_EXECUTION_PROVIDER=legacy-openclaw/);
});

test('HermesExecutionAdapter reports missing HERMES_API_SERVER_KEY with an actionable ExecutionError', async () => {
  const adapter = new HermesExecutionAdapter({
    HERMES_GATEWAY_URL: TEST_HERMES_GATEWAY_URL,
  });

  const result = await adapter.runWorkflow('marketing_demo', { tenantId: 'tenant-123' });

  assert.equal(result.kind, 'gateway_error');
  if (result.kind !== 'gateway_error') {
    assert.fail('expected gateway_error result');
  }

  assert.equal(result.error.provider, 'hermes');
  assert.equal(result.error.code, 'not_configured');
  assert.match(result.error.message, /HERMES_API_SERVER_KEY/);
});

test('HermesExecutionAdapter returns not_implemented for unsupported workflows even when configured', async () => {
  let called = false;
  const adapter = new HermesExecutionAdapter(
    {
      HERMES_GATEWAY_URL: TEST_HERMES_GATEWAY_URL,
      HERMES_API_SERVER_KEY: 'token-123',
    },
    async () => {
      called = true;
      return new Response('{}');
    },
    NO_SLEEP,
  );

  const result = await adapter.runWorkflow('calendar_sync', { tenant_id: 'tenant-123' });

  assert.equal(called, false);
  assert.equal(result.kind, 'not_implemented');
  if (result.kind !== 'not_implemented') {
    assert.fail('expected not_implemented result');
  }
  assert.equal(result.payload.route, 'calendar_sync');
  assert.equal(result.payload.provider, 'hermes');
});

test('HermesExecutionAdapter submits demo_start once and returns an async run envelope', async () => {
  await withDataRoot(async () => {
    const { loadExecutionRunRecord } = await import('../backend/execution/run-store');
    const { calls, fetchImpl } = recordingFetchSequence([
      () => new Response(JSON.stringify({ run_id: 'run_abc', status: 'started' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }),
    ]);
    const adapter = new HermesExecutionAdapter(
      {
        HERMES_GATEWAY_URL: `${TEST_HERMES_GATEWAY_URL}/`,
        HERMES_API_SERVER_KEY: 'token-123',
        HERMES_SESSION_KEY: 'campaign-runtime',
        APP_BASE_URL: 'https://aries.example.com',
        HERMES_RUN_TIMEOUT_MS: '0',
        HERMES_POLL_INTERVAL_MS: '0',
      },
      fetchImpl,
      NO_SLEEP,
    );

    const result = await adapter.runWorkflow('demo_start', {
      user: { email: 'founder@example.com' },
      surface: 'marketing-site',
    });

    assert.equal(result.kind, 'ok');
    if (result.kind !== 'ok') assert.fail('expected ok result');
    assert.equal(result.primaryOutput, null);
    assert.equal(result.envelope.status, 'accepted');
    assert.equal(result.envelope.provider, 'hermes');
    assert.equal(result.envelope.hermes_run_id, 'run_abc');
    assert.match(String(result.envelope.aries_run_id), /^arun_/);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${TEST_HERMES_GATEWAY_URL}/v1/runs`);
    assert.equal(calls[0].init.method, 'POST');
    const headers0 = calls[0].init.headers as Record<string, string>;
    assert.equal(headers0.authorization, 'Bearer token-123');
    assert.equal(headers0['content-type'], 'application/json');
    const submitBody = JSON.parse(String(calls[0].init.body));
    assert.equal(submitBody.session_id, 'campaign-runtime');
    assert.equal(submitBody.callback_url, 'https://aries.example.com/api/internal/hermes/runs');
    assert.match(submitBody.input, /Workflow: demo_start/);
    assert.match(submitBody.input, /Aries run ID: arun_/);
    assert.match(submitBody.input, /"user":\{"email":"founder@example.com"\}/);
    assert.match(submitBody.instructions, /Aries demo provisioning/);

    const stored = loadExecutionRunRecord(String(result.envelope.aries_run_id));
    assert.equal(stored?.external_run_id, 'run_abc');
    assert.equal(stored?.workflow_key, 'demo_start');
    assert.equal(stored?.domain, 'route');
  });
});

test('HermesExecutionAdapter returns unreachable when /v1/runs submission throws', async () => {
  await withDataRoot(async () => {
    const adapter = new HermesExecutionAdapter(
      {
        HERMES_GATEWAY_URL: TEST_UNREACHABLE_URL,
        HERMES_API_SERVER_KEY: 'token-123',
        APP_BASE_URL: 'https://aries.example.com',
        HERMES_POLL_INTERVAL_MS: '0',
      },
      async () => {
        throw new Error('ECONNREFUSED');
      },
      NO_SLEEP,
    );

    const result = await adapter.runWorkflow('demo_start', { user: { email: 'a@b.co' } });

    assert.equal(result.kind, 'gateway_error');
    if (result.kind !== 'gateway_error') assert.fail('expected gateway_error');
    assert.equal(result.error.code, 'unreachable');
    assert.equal(result.error.status, 503);
  });
});

test('HermesExecutionAdapter surfaces non-2xx submission HTTP status as a structured ExecutionError', async () => {
  await withDataRoot(async () => {
    const { fetchImpl } = recordingFetchSequence([
      () => new Response('{"error":{"message":"unauthorized"}}', {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    ]);
    const adapter = new HermesExecutionAdapter(
      {
        HERMES_GATEWAY_URL: TEST_HERMES_GATEWAY_URL,
        HERMES_API_SERVER_KEY: 'token-bad',
        APP_BASE_URL: 'https://aries.example.com',
        HERMES_POLL_INTERVAL_MS: '0',
      },
      fetchImpl,
      NO_SLEEP,
    );

    const result = await adapter.runWorkflow('demo_start', { user: { email: 'a@b.co' } });

    assert.equal(result.kind, 'gateway_error');
    if (result.kind !== 'gateway_error') assert.fail('expected gateway_error');
    assert.equal(result.error.code, 'unauthorized');
    assert.equal(result.error.status, 401);
  });
});

test('buildHermesRequestEnvelope retains the run/resume/cancel contract for upstream callers', () => {
  assert.deepEqual(
    buildHermesRequestEnvelope({
      action: 'run',
      workflowId: 'marketing_demo',
      args: { tenantId: 'tenant-123' },
      cwd: '/home/node/aries-app',
      timeoutMs: 45_000,
      maxStdoutBytes: 65_536,
      sessionKey: 'campaign-runtime',
    }),
    {
      provider: 'hermes',
      action: 'run',
      workflowId: 'marketing_demo',
      argsJson: '{"tenantId":"tenant-123"}',
      cwd: '/home/node/aries-app',
      timeoutMs: 45_000,
      maxStdoutBytes: 65_536,
      sessionKey: 'campaign-runtime',
    },
  );

  assert.deepEqual(
    buildHermesRequestEnvelope({
      action: 'resume',
      workflowId: 'marketing_pipeline',
      args: { reviewer: 'tenant_admin' },
      approvalResumeToken: 'approval_resume_token_123',
      approve: true,
      sessionKey: 'campaign-runtime',
    }),
    {
      provider: 'hermes',
      action: 'resume',
      workflowId: 'marketing_pipeline',
      argsJson: '{"reviewer":"tenant_admin"}',
      approvalResumeToken: 'approval_resume_token_123',
      approve: true,
      sessionKey: 'campaign-runtime',
    },
  );

  assert.deepEqual(
    buildHermesRequestEnvelope({
      action: 'cancel',
      cancelCorrelationId: 'job-123',
      sessionKey: 'campaign-runtime',
    }),
    {
      provider: 'hermes',
      action: 'cancel',
      cancelCorrelationId: 'job-123',
      sessionKey: 'campaign-runtime',
    },
  );
});
