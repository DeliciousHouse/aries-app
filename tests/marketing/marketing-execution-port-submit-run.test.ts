import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { HermesMarketingPort } from '../../backend/marketing/ports/hermes';
import { TEST_HERMES_GATEWAY_URL } from '../fixtures/service-urls';

const NO_OP_BRAND_KIT_REFRESHER = async () => ({ refreshed: false, enriched: false });
const NO_SLEEP = async () => {};

const HERMES_ENV = {
  HERMES_GATEWAY_URL: `${TEST_HERMES_GATEWAY_URL}/`,
  HERMES_API_SERVER_KEY: 'token-submit-run-test',
  HERMES_POLL_BRIDGE_ENABLED: '0',
  INTERNAL_API_SECRET: 'internal-secret-submit-run',
  APP_BASE_URL: 'https://aries.example.com',
  HERMES_SESSION_KEY: 'marketing-session',
};

type FetchCall = { url: string; init: RequestInit };

function recordingFetch(responses: Array<() => Response>): { calls: FetchCall[]; fetchImpl: typeof fetch } {
  const calls: FetchCall[] = [];
  let i = 0;
  const fetchImpl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} });
    const make = responses[i] ?? responses[responses.length - 1];
    if (i < responses.length - 1) i += 1;
    return make();
  };
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

async function withDataRoot<T>(run: () => Promise<T>): Promise<T> {
  const previousDataRoot = process.env.DATA_ROOT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-port-submit-run-'));
  process.env.DATA_ROOT = dataRoot;
  try {
    return await run();
  } finally {
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

test('HermesMarketingPort.getCallbackUrl returns the configured Hermes runs callback path', () => {
  const port = new HermesMarketingPort(HERMES_ENV, globalThis.fetch, NO_SLEEP, NO_OP_BRAND_KIT_REFRESHER);
  assert.equal(port.getCallbackUrl(), 'https://aries.example.com/api/internal/hermes/runs');
});

test('HermesMarketingPort.getSessionKey returns the configured session key', () => {
  const port = new HermesMarketingPort(HERMES_ENV, globalThis.fetch, NO_SLEEP, NO_OP_BRAND_KIT_REFRESHER);
  assert.equal(port.getSessionKey(), 'marketing-session');
});

test('HermesMarketingPort.getSessionKey falls back to "marketing" when HERMES_SESSION_KEY is unset', () => {
  const { HERMES_SESSION_KEY: _, ...envWithoutKey } = HERMES_ENV;
  const port = new HermesMarketingPort(envWithoutKey, globalThis.fetch, NO_SLEEP, NO_OP_BRAND_KIT_REFRESHER);
  assert.equal(port.getSessionKey(), 'marketing');
});

test('HermesMarketingPort.submitRawRun dispatches social_content_weekly payload and returns run IDs', async () => {
  await withDataRoot(async () => {
    const { createExecutionRunRecord, loadExecutionRunRecord } = await import('../../backend/execution/run-store');

    const { calls, fetchImpl } = recordingFetch([
      () => new Response(JSON.stringify({ run_id: 'hermes-scw-raw-run-1', status: 'started' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }),
    ]);

    const port = new HermesMarketingPort(HERMES_ENV, fetchImpl, NO_SLEEP, NO_OP_BRAND_KIT_REFRESHER);

    const run = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'marketing',
      workflowKey: 'social_content_weekly',
      action: 'run',
      tenantId: '42',
      marketingJobId: 'job-scw-raw-1',
      stage: 'research',
    });

    const payload: Record<string, unknown> = {
      input: 'Workflow: social_content_weekly\nAction: run',
      instructions: 'test instructions',
      session_id: port.getSessionKey(),
      workflow_key: 'social_content_weekly',
      callback_url: port.getCallbackUrl(),
      callback_auth: {
        type: 'internal_api_secret_bearer',
        secret_ref: 'INTERNAL_API_SECRET',
        callback_token: 'test-token-hex',
      },
      callback_context: {
        workflow_key: 'social_content_weekly',
        aries_run_id: run.aries_run_id,
        job_id: 'job-scw-raw-1',
        tenant_id: '42',
      },
      idempotency_key: 'test-idempotency-key-scw',
    };

    const result = await port.submitRawRun({
      ariesRunId: run.aries_run_id,
      tenantId: '42',
      workflowKey: 'social_content_weekly',
      stage: 'research',
      payload,
      callbackToken: 'test-token-hex',
    });

    assert.equal(result.ariesRunId, run.aries_run_id);
    assert.equal(result.hermesRunId, 'hermes-scw-raw-run-1');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${TEST_HERMES_GATEWAY_URL}/v1/runs`);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal((calls[0].init.headers as Record<string, string>)['authorization'], 'Bearer token-submit-run-test');
    assert.equal((calls[0].init.headers as Record<string, string>)['idempotency-key'], 'test-idempotency-key-scw');

    const record = loadExecutionRunRecord(run.aries_run_id);
    assert.equal(record?.status, 'submitted');
    assert.equal(record?.external_run_id, 'hermes-scw-raw-run-1');
  });
});

test('HermesMarketingPort.submitRawRun dispatches social_copy_finalize payload and returns run IDs', async () => {
  await withDataRoot(async () => {
    const { createExecutionRunRecord, loadExecutionRunRecord } = await import('../../backend/execution/run-store');

    const { calls, fetchImpl } = recordingFetch([
      () => new Response(JSON.stringify({ run_id: 'hermes-scf-raw-run-2', status: 'started' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }),
    ]);

    const port = new HermesMarketingPort(HERMES_ENV, fetchImpl, NO_SLEEP, NO_OP_BRAND_KIT_REFRESHER);

    const run = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'marketing',
      workflowKey: 'social_copy_finalize',
      action: 'run',
      tenantId: '42',
      marketingJobId: 'job-scf-raw-2',
      stage: 'production',
    });

    const payload: Record<string, unknown> = {
      input: 'Workflow: social_copy_finalize\nAction: run',
      instructions: 'social copy finalize instructions',
      session_id: port.getSessionKey(),
      workflow_key: 'social_copy_finalize',
      callback_url: port.getCallbackUrl(),
      callback_auth: {
        type: 'internal_api_secret_bearer',
        secret_ref: 'INTERNAL_API_SECRET',
        callback_token: 'scf-token-hex',
      },
      callback_context: {
        workflow_key: 'social_copy_finalize',
        aries_run_id: run.aries_run_id,
        job_id: 'job-scf-raw-2',
        tenant_id: '42',
      },
      idempotency_key: 'test-idempotency-key-scf',
    };

    const result = await port.submitRawRun({
      ariesRunId: run.aries_run_id,
      tenantId: '42',
      workflowKey: 'social_copy_finalize',
      stage: 'production',
      payload,
      callbackToken: 'scf-token-hex',
    });

    assert.equal(result.ariesRunId, run.aries_run_id);
    assert.equal(result.hermesRunId, 'hermes-scf-raw-run-2');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${TEST_HERMES_GATEWAY_URL}/v1/runs`);
    assert.equal((calls[0].init.headers as Record<string, string>)['idempotency-key'], 'test-idempotency-key-scf');

    const record = loadExecutionRunRecord(run.aries_run_id);
    assert.equal(record?.status, 'submitted');
    assert.equal(record?.external_run_id, 'hermes-scf-raw-run-2');
  });
});

test('HermesMarketingPort.submitRawRun throws with hermes_gateway_unreachable code on fetch failure', async () => {
  await withDataRoot(async () => {
    const { createExecutionRunRecord, loadExecutionRunRecord } = await import('../../backend/execution/run-store');

    const fetchImpl = async () => {
      throw new Error('ECONNREFUSED');
    };

    const port = new HermesMarketingPort(HERMES_ENV, fetchImpl as unknown as typeof fetch, NO_SLEEP, NO_OP_BRAND_KIT_REFRESHER);

    const run = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'marketing',
      workflowKey: 'social_copy_finalize',
      action: 'run',
      tenantId: '42',
      marketingJobId: 'job-unreachable',
      stage: 'production',
    });

    const payload: Record<string, unknown> = {
      input: 'test',
      idempotency_key: 'key-unreachable',
    };

    await assert.rejects(
      () => port.submitRawRun({
        ariesRunId: run.aries_run_id,
        tenantId: '42',
        workflowKey: 'social_copy_finalize',
        stage: 'production',
        payload,
        callbackToken: 'tok',
      }),
      (err: Error) => {
        assert.ok(err.message.startsWith('hermes_gateway_unreachable:'));
        return true;
      },
    );

    const record = loadExecutionRunRecord(run.aries_run_id);
    assert.equal(record?.status, 'failed');
  });
});

test('HermesMarketingPort.submitRawRun throws with hermes_gateway_request_failed code on non-ok response', async () => {
  await withDataRoot(async () => {
    const { createExecutionRunRecord, loadExecutionRunRecord } = await import('../../backend/execution/run-store');

    const { fetchImpl } = recordingFetch([
      () => new Response('Bad Request', { status: 400 }),
    ]);

    const port = new HermesMarketingPort(HERMES_ENV, fetchImpl, NO_SLEEP, NO_OP_BRAND_KIT_REFRESHER);

    const run = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'marketing',
      workflowKey: 'social_copy_finalize',
      action: 'run',
      tenantId: '42',
      marketingJobId: 'job-bad-request',
      stage: 'production',
    });

    const payload: Record<string, unknown> = {
      input: 'test',
      idempotency_key: 'key-bad-request',
    };

    await assert.rejects(
      () => port.submitRawRun({
        ariesRunId: run.aries_run_id,
        tenantId: '42',
        workflowKey: 'social_copy_finalize',
        stage: 'production',
        payload,
        callbackToken: 'tok',
      }),
      (err: Error) => {
        assert.ok(err.message.startsWith('hermes_gateway_request_failed:HTTP 400'));
        return true;
      },
    );

    const record = loadExecutionRunRecord(run.aries_run_id);
    assert.equal(record?.status, 'failed');
  });
});

test('HermesMarketingPort.submitRawRun throws with config error when HERMES_GATEWAY_URL is missing', async () => {
  await withDataRoot(async () => {
    const { createExecutionRunRecord } = await import('../../backend/execution/run-store');

    const { HERMES_GATEWAY_URL: _, ...envMissingGateway } = HERMES_ENV;
    const port = new HermesMarketingPort(envMissingGateway, globalThis.fetch, NO_SLEEP, NO_OP_BRAND_KIT_REFRESHER);

    const run = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'marketing',
      workflowKey: 'social_copy_finalize',
      action: 'run',
      tenantId: '42',
      marketingJobId: 'job-missing-config',
      stage: 'production',
    });

    const payload: Record<string, unknown> = { input: 'test', idempotency_key: 'key-config' };

    await assert.rejects(
      () => port.submitRawRun({
        ariesRunId: run.aries_run_id,
        tenantId: '42',
        workflowKey: 'social_copy_finalize',
        stage: 'production',
        payload,
        callbackToken: 'tok',
      }),
      (err: Error) => {
        assert.ok(err.message.includes('social_copy_finalize_config_missing'));
        return true;
      },
    );
  });
});
