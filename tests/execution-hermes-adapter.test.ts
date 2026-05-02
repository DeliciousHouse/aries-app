import assert from 'node:assert/strict';
import test from 'node:test';

import { ExecutionError } from '../backend/execution';
import {
  HermesExecutionAdapter,
  buildHermesRequestEnvelope,
} from '../backend/execution/providers/hermes';

test('HermesExecutionAdapter reports missing HERMES_GATEWAY_URL with an actionable ExecutionError', async () => {
  const adapter = new HermesExecutionAdapter({
    HERMES_GATEWAY_TOKEN: 'token-123',
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

test('HermesExecutionAdapter reports missing HERMES_GATEWAY_TOKEN with an actionable ExecutionError', async () => {
  const adapter = new HermesExecutionAdapter({
    HERMES_GATEWAY_URL: 'http://127.0.0.1:8787',
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
  assert.match(result.error.message, /HERMES_GATEWAY_TOKEN/);
  assert.match(result.error.message, /ARIES_EXECUTION_PROVIDER=legacy-openclaw/);
});

test('HermesExecutionAdapter returns an honest not_implemented result when configured before real Hermes calls land', async () => {
  const adapter = new HermesExecutionAdapter({
    HERMES_GATEWAY_URL: 'http://127.0.0.1:8787',
    HERMES_GATEWAY_TOKEN: 'token-123',
    HERMES_SESSION_KEY: 'campaign-runtime',
  });

  const result = await adapter.runWorkflow('marketing_demo', { tenantId: 'tenant-123' });

  assert.equal(result.kind, 'not_implemented');
  if (result.kind !== 'not_implemented') {
    assert.fail('expected not_implemented result');
  }

  assert.equal(result.payload.status, 'not_implemented');
  assert.equal(result.payload.code, 'workflow_missing_for_route');
  assert.equal(result.payload.route, 'marketing_demo');
  assert.match(result.payload.message, /Hermes execution adapter/);
  assert.equal(result.payload.provider, 'hermes');
});

test('HermesExecutionAdapter invokes the Hermes gateway for the low-risk demo_start workflow', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const adapter = new HermesExecutionAdapter(
    {
      HERMES_GATEWAY_URL: 'http://127.0.0.1:8787/',
      HERMES_GATEWAY_TOKEN: 'token-123',
      HERMES_SESSION_KEY: 'campaign-runtime',
    },
    async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(
        JSON.stringify({
          ok: true,
          status: 'ok',
          output: [{ provisioned: true, lead_id: 'lead-123' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  );

  const result = await adapter.runWorkflow('demo_start', {
    user: { email: 'founder@example.com' },
    surface: 'marketing-site',
  });

  assert.equal(result.kind, 'ok');
  if (result.kind !== 'ok') {
    assert.fail('expected ok result');
  }

  assert.deepEqual(result.primaryOutput, { provisioned: true, lead_id: 'lead-123' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:8787/tools/invoke');
  assert.deepEqual(calls[0].init.headers, {
    authorization: 'Bearer token-123',
    'content-type': 'application/json',
  });
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    tool: 'aries.workflow.run',
    sessionKey: 'campaign-runtime',
    args: {
      provider: 'hermes',
      action: 'run',
      workflowId: 'demo_start',
      argsJson: '{"user":{"email":"founder@example.com"},"surface":"marketing-site"}',
      sessionKey: 'campaign-runtime',
    },
  });
});

test('HermesExecutionAdapter leaves unsupported workflows as not_implemented without calling Hermes', async () => {
  let called = false;
  const adapter = new HermesExecutionAdapter(
    {
      HERMES_GATEWAY_URL: 'http://127.0.0.1:8787',
      HERMES_GATEWAY_TOKEN: 'token-123',
    },
    async () => {
      called = true;
      return new Response('{}');
    },
  );

  const result = await adapter.runWorkflow('calendar_sync', { tenant_id: 'tenant-123' });

  assert.equal(called, false);
  assert.equal(result.kind, 'not_implemented');
  if (result.kind !== 'not_implemented') {
    assert.fail('expected not_implemented result');
  }
  assert.equal(result.payload.route, 'calendar_sync');
});

test('buildHermesRequestEnvelope defines the run request contract', () => {
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
});

test('HermesExecutionAdapter surfaces tool-level ok:false payloads as gateway_error rather than success', async () => {
  const adapter = new HermesExecutionAdapter(
    {
      HERMES_GATEWAY_URL: 'http://127.0.0.1:8787',
      HERMES_GATEWAY_TOKEN: 'token-123',
      HERMES_SESSION_KEY: 'campaign-runtime',
    },
    async () =>
      new Response(
        JSON.stringify({
          ok: false,
          error: { message: 'tool blew up: gateway refused workflow' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  );

  const result = await adapter.runWorkflow('demo_start', {
    user: { email: 'founder@example.com' },
    surface: 'marketing-site',
  });

  assert.equal(result.kind, 'gateway_error');
  if (result.kind !== 'gateway_error') {
    assert.fail('expected gateway_error result for tool-level ok:false');
  }
  assert.ok(result.error instanceof ExecutionError);
  assert.equal(result.error.provider, 'hermes');
  assert.equal(result.error.code, 'response_invalid');
  assert.equal(result.error.status, 200);
  assert.match(result.error.message, /tool blew up/);
});

test('HermesExecutionAdapter surfaces ok:false with a string error as gateway_error', async () => {
  const adapter = new HermesExecutionAdapter(
    {
      HERMES_GATEWAY_URL: 'http://127.0.0.1:8787',
      HERMES_GATEWAY_TOKEN: 'token-123',
    },
    async () =>
      new Response(JSON.stringify({ ok: false, error: 'workflow_unavailable' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );

  const result = await adapter.runWorkflow('demo_start', { user: { email: 'a@b.co' } });

  assert.equal(result.kind, 'gateway_error');
  if (result.kind !== 'gateway_error') {
    assert.fail('expected gateway_error result for tool-level ok:false');
  }
  assert.equal(result.error.message, 'workflow_unavailable');
});

test('HermesExecutionAdapter surfaces ok:false with no error detail as a generic tool failure', async () => {
  const adapter = new HermesExecutionAdapter(
    {
      HERMES_GATEWAY_URL: 'http://127.0.0.1:8787',
      HERMES_GATEWAY_TOKEN: 'token-123',
    },
    async () =>
      new Response(JSON.stringify({ ok: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );

  const result = await adapter.runWorkflow('demo_start', { user: { email: 'a@b.co' } });

  assert.equal(result.kind, 'gateway_error');
  if (result.kind !== 'gateway_error') {
    assert.fail('expected gateway_error result for tool-level ok:false');
  }
  assert.match(result.error.message, /tool-level failure/);
});

test('buildHermesRequestEnvelope defines approval resume and cancel correlation fields', () => {
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
