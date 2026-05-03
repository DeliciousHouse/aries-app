import assert from 'node:assert/strict';
import test from 'node:test';

import { ExecutionError } from '../backend/execution';
import {
  HermesExecutionAdapter,
  buildHermesRequestEnvelope,
} from '../backend/execution/providers/hermes';

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
    HERMES_GATEWAY_URL: 'http://127.0.0.1:8787',
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
      HERMES_GATEWAY_URL: 'http://127.0.0.1:8787',
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

test('HermesExecutionAdapter submits demo_start to /v1/runs and parses the polled JSON output', async () => {
  const completedJson = JSON.stringify({
    status: 'ok',
    output: [{ provisioned: true, lead_id: 'lead-123' }],
    message: 'demo provisioned',
  });
  const { calls, fetchImpl } = recordingFetchSequence([
    () => new Response(JSON.stringify({ run_id: 'run_abc', status: 'started' }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    }),
    () => new Response(JSON.stringify({ run_id: 'run_abc', status: 'running' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    () => new Response(JSON.stringify({ run_id: 'run_abc', status: 'completed', output: completedJson }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  ]);
  const adapter = new HermesExecutionAdapter(
    {
      HERMES_GATEWAY_URL: 'http://127.0.0.1:8787/',
      HERMES_API_SERVER_KEY: 'token-123',
      HERMES_SESSION_KEY: 'campaign-runtime',
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
  assert.deepEqual(result.primaryOutput, { provisioned: true, lead_id: 'lead-123' });
  assert.equal(result.envelope.status, 'ok');
  assert.equal(result.envelope.run_id, 'run_abc');

  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'http://127.0.0.1:8787/v1/runs');
  assert.equal(calls[0].init.method, 'POST');
  const headers0 = calls[0].init.headers as Record<string, string>;
  assert.equal(headers0.authorization, 'Bearer token-123');
  assert.equal(headers0['content-type'], 'application/json');
  const submitBody = JSON.parse(String(calls[0].init.body));
  assert.equal(submitBody.session_id, 'campaign-runtime');
  assert.match(submitBody.input, /Workflow: demo_start/);
  assert.match(submitBody.input, /"user":\{"email":"founder@example.com"\}/);
  assert.match(submitBody.instructions, /Aries demo provisioning/);

  assert.equal(calls[1].url, 'http://127.0.0.1:8787/v1/runs/run_abc');
  assert.equal(calls[1].init.method, 'GET');
  assert.equal(calls[2].url, 'http://127.0.0.1:8787/v1/runs/run_abc');
});

test('HermesExecutionAdapter wraps non-JSON run output as a generic envelope without failing', async () => {
  const { fetchImpl } = recordingFetchSequence([
    () => new Response(JSON.stringify({ run_id: 'run_xyz', status: 'started' }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    }),
    () => new Response(JSON.stringify({ run_id: 'run_xyz', status: 'completed', output: 'plain text response' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  ]);
  const adapter = new HermesExecutionAdapter(
    {
      HERMES_GATEWAY_URL: 'http://127.0.0.1:8787',
      HERMES_API_SERVER_KEY: 'token-123',
      HERMES_POLL_INTERVAL_MS: '0',
    },
    fetchImpl,
    NO_SLEEP,
  );

  const result = await adapter.runWorkflow('demo_start', { user: { email: 'a@b.co' } });

  assert.equal(result.kind, 'ok');
  if (result.kind !== 'ok') assert.fail('expected ok result');
  assert.equal(result.envelope.status, 'ok');
  assert.equal(result.envelope.run_id, 'run_xyz');
  assert.equal(result.envelope.output_text, 'plain text response');
  assert.equal(result.primaryOutput, null);
});

test('HermesExecutionAdapter surfaces failed runs as gateway_error with the agent error text', async () => {
  const { fetchImpl } = recordingFetchSequence([
    () => new Response(JSON.stringify({ run_id: 'run_fail', status: 'started' }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    }),
    () => new Response(JSON.stringify({ run_id: 'run_fail', status: 'failed', error: 'agent crashed' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  ]);
  const adapter = new HermesExecutionAdapter(
    {
      HERMES_GATEWAY_URL: 'http://127.0.0.1:8787',
      HERMES_API_SERVER_KEY: 'token-123',
      HERMES_POLL_INTERVAL_MS: '0',
    },
    fetchImpl,
    NO_SLEEP,
  );

  const result = await adapter.runWorkflow('demo_start', { user: { email: 'a@b.co' } });

  assert.equal(result.kind, 'gateway_error');
  if (result.kind !== 'gateway_error') assert.fail('expected gateway_error');
  assert.equal(result.error.provider, 'hermes');
  assert.equal(result.error.code, 'server_error');
  assert.match(result.error.message, /agent crashed/);
});

test('HermesExecutionAdapter returns unreachable when /v1/runs submission throws', async () => {
  const adapter = new HermesExecutionAdapter(
    {
      HERMES_GATEWAY_URL: 'http://127.0.0.1:65500',
      HERMES_API_SERVER_KEY: 'token-123',
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

test('HermesExecutionAdapter surfaces non-2xx submission HTTP status as a structured ExecutionError', async () => {
  const { fetchImpl } = recordingFetchSequence([
    () => new Response('{"error":{"message":"unauthorized"}}', {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }),
  ]);
  const adapter = new HermesExecutionAdapter(
    {
      HERMES_GATEWAY_URL: 'http://127.0.0.1:8787',
      HERMES_API_SERVER_KEY: 'token-bad',
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

test('HermesExecutionAdapter times out runs that never reach a terminal status', async () => {
  const { fetchImpl } = recordingFetchSequence([
    () => new Response(JSON.stringify({ run_id: 'run_slow', status: 'started' }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    }),
    () => new Response(JSON.stringify({ run_id: 'run_slow', status: 'running' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  ]);
  const adapter = new HermesExecutionAdapter(
    {
      HERMES_GATEWAY_URL: 'http://127.0.0.1:8787',
      HERMES_API_SERVER_KEY: 'token-123',
      HERMES_RUN_TIMEOUT_MS: '0',
      HERMES_POLL_INTERVAL_MS: '0',
    },
    fetchImpl,
    NO_SLEEP,
  );

  const result = await adapter.runWorkflow('demo_start', { user: { email: 'a@b.co' } });

  assert.equal(result.kind, 'gateway_error');
  if (result.kind !== 'gateway_error') assert.fail('expected gateway_error');
  assert.equal(result.error.code, 'server_error');
  assert.equal(result.error.status, 504);
  assert.match(result.error.message, /did not reach a terminal status/);
});

test('HermesExecutionAdapter strips JSON code fences from agent output', async () => {
  const fenced = '```json\n{"status":"ok","output":[{"provisioned":true}]}\n```';
  const { fetchImpl } = recordingFetchSequence([
    () => new Response(JSON.stringify({ run_id: 'run_fenced', status: 'started' }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    }),
    () => new Response(JSON.stringify({ run_id: 'run_fenced', status: 'completed', output: fenced }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  ]);
  const adapter = new HermesExecutionAdapter(
    {
      HERMES_GATEWAY_URL: 'http://127.0.0.1:8787',
      HERMES_API_SERVER_KEY: 'token-123',
      HERMES_POLL_INTERVAL_MS: '0',
    },
    fetchImpl,
    NO_SLEEP,
  );

  const result = await adapter.runWorkflow('demo_start', { user: { email: 'a@b.co' } });

  assert.equal(result.kind, 'ok');
  if (result.kind !== 'ok') assert.fail('expected ok result');
  assert.deepEqual(result.primaryOutput, { provisioned: true });
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
