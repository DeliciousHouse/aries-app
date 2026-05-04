import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_MARKETING_EXECUTION_PORT,
  getMarketingExecutionPort,
  resolveMarketingExecutionPortName,
} from '../backend/marketing/execution-port';
import { HermesMarketingPort } from '../backend/marketing/ports/hermes';
import { LegacyOpenClawMarketingPort } from '../backend/marketing/ports/legacy-openclaw';
import type { MarketingJobRuntimeDocument } from '../backend/marketing/runtime-state';
import { TEST_HERMES_GATEWAY_URL } from './fixtures/service-urls';

const STUB_RUNTIME_PATHS = { gatewayCwd: 'lobster', localCwd: '/tmp/lobster' };

const STUB_DOC = {
  job_id: 'job_test',
  tenant_id: 'tenant_test',
  inputs: {},
} as unknown as MarketingJobRuntimeDocument;

const STUB_RUN_INPUT = {
  jobId: 'job_test',
  doc: STUB_DOC,
  argsJson: '{"job_id":"job_test"}',
  timeoutMs: 1_000,
  maxStdoutBytes: 65_536,
};

const STUB_RESUME_INPUT = {
  resumeToken: 'opaque-token-123',
  approve: true,
  timeoutMs: 1_000,
  maxStdoutBytes: 65_536,
};

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

async function withDataRoot<T>(run: () => Promise<T>): Promise<T> {
  const previousDataRoot = process.env.DATA_ROOT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-marketing-port-'));

  process.env.DATA_ROOT = dataRoot;
  try {
    return await run();
  } finally {
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

test('marketing port name defaults to hermes when no env var is set', () => {
  assert.equal(resolveMarketingExecutionPortName({}), 'hermes');
  assert.equal(DEFAULT_MARKETING_EXECUTION_PORT, 'hermes');
});

test('marketing port name selects hermes only when ARIES_MARKETING_EXECUTION_PROVIDER=hermes', () => {
  assert.equal(
    resolveMarketingExecutionPortName({ ARIES_MARKETING_EXECUTION_PROVIDER: 'hermes' }),
    'hermes',
  );
  assert.equal(
    resolveMarketingExecutionPortName({ ARIES_MARKETING_EXECUTION_PROVIDER: ' Hermes ' }),
    'hermes',
  );
});

test('marketing port name accepts explicit legacy-openclaw selection', () => {
  assert.equal(
    resolveMarketingExecutionPortName({ ARIES_MARKETING_EXECUTION_PROVIDER: 'legacy-openclaw' }),
    'legacy-openclaw',
  );
});

test('marketing port name falls back to hermes on unknown values', () => {
  assert.equal(
    resolveMarketingExecutionPortName({ ARIES_MARKETING_EXECUTION_PROVIDER: 'unsupported' }),
    'hermes',
  );
});

test('getMarketingExecutionPort returns the Hermes port by default', () => {
  const port = getMarketingExecutionPort(() => STUB_RUNTIME_PATHS, {});
  assert.ok(port instanceof HermesMarketingPort);
  assert.equal(port.name, 'hermes');
});

test('getMarketingExecutionPort returns the Hermes port when explicitly selected', () => {
  const port = getMarketingExecutionPort(
    () => STUB_RUNTIME_PATHS,
    { ARIES_MARKETING_EXECUTION_PROVIDER: 'hermes' },
  );
  assert.ok(port instanceof HermesMarketingPort);
  assert.equal(port.name, 'hermes');
});

test('HermesMarketingPort.runPipeline submits a Hermes marketing run without polling', async () => {
  await withDataRoot(async () => {
    const { loadExecutionRunRecord } = await import('../backend/execution/run-store');
    const { calls, fetchImpl } = recordingFetchSequence([
      () => new Response(JSON.stringify({ run_id: 'hermes-marketing-run-1', status: 'started' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }),
    ]);
    const port = new HermesMarketingPort(
      {
        HERMES_GATEWAY_URL: `${TEST_HERMES_GATEWAY_URL}/`,
        HERMES_API_SERVER_KEY: 'token-123',
        HERMES_SESSION_KEY: 'marketing-session',
        APP_BASE_URL: 'https://aries.example.com',
      },
      fetchImpl,
    );
    const result = await port.runPipeline(STUB_RUN_INPUT);

    assert.equal(result.kind, 'submitted');
    assert.equal(result.provider, 'hermes');
    assert.equal(result.hermesRunId, 'hermes-marketing-run-1');
    assert.match(result.ariesRunId, /^arun_/);
    assert.equal(calls.length, 1);

    const body = JSON.parse(String(calls[0].init.body));
    assert.equal(body.callback_url, 'https://aries.example.com/api/internal/hermes/runs');
    assert.equal(body.session_id, 'marketing-session');
    assert.match(body.input, /Workflow: marketing_pipeline/);
    assert.match(body.input, /Action: run/);
    assert.match(body.input, /Aries run ID: arun_/);
    assert.match(body.input, /"job_id":"job_test"/);

    const stored = loadExecutionRunRecord(result.ariesRunId);
    assert.equal(stored?.domain, 'marketing');
    assert.equal(stored?.workflow_key, 'marketing_pipeline');
    assert.equal(stored?.marketing_job_id, 'job_test');
    assert.equal(stored?.stage, 'research');
    assert.equal(stored?.external_run_id, 'hermes-marketing-run-1');
  });
});

test('HermesMarketingPort.resumePipeline submits a Hermes resume decision without polling', async () => {
  await withDataRoot(async () => {
    const { calls, fetchImpl } = recordingFetchSequence([
      () => new Response(JSON.stringify({ run_id: 'hermes-resume-run-1', status: 'started' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }),
    ]);
    const port = new HermesMarketingPort(
      {
        HERMES_GATEWAY_URL: TEST_HERMES_GATEWAY_URL,
        HERMES_API_SERVER_KEY: 'token-123',
        APP_BASE_URL: 'https://aries.example.com',
      },
      fetchImpl,
    );

    const result = await port.resumePipeline(STUB_RESUME_INPUT);

    assert.equal(result.kind, 'submitted');
    assert.equal(result.provider, 'hermes');
    assert.equal(result.hermesRunId, 'hermes-resume-run-1');
    const body = JSON.parse(String(calls[0].init.body));
    assert.match(body.input, /Action: resume/);
    assert.match(body.input, /Approve: true/);
    assert.match(body.input, /Resume token: opaque-token-123/);
  });
});

test('HermesMarketingPort reports missing config as a completed error result', async () => {
  const port = new HermesMarketingPort({ HERMES_GATEWAY_URL: TEST_HERMES_GATEWAY_URL });
  const result = await port.runPipeline(STUB_RUN_INPUT);

  assert.equal(result.kind, 'completed');
  assert.equal(result.provider, 'hermes');
  assert.equal(result.envelope.ok, false);
  assert.equal(result.envelope.status, 'gateway_error');
  assert.equal(result.envelope.code, 'hermes_gateway_not_configured');
});

test('HermesMarketingPort marks accepted Aries runs failed when Hermes submission fails', async () => {
  await withDataRoot(async () => {
    const { loadExecutionRunRecord } = await import('../backend/execution/run-store');
    const { fetchImpl } = recordingFetchSequence([
      () => new Response(JSON.stringify({ error: 'no capacity' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
    ]);
    const port = new HermesMarketingPort(
      {
        HERMES_GATEWAY_URL: TEST_HERMES_GATEWAY_URL,
        HERMES_API_SERVER_KEY: 'token-123',
        APP_BASE_URL: 'https://aries.example.com',
      },
      fetchImpl,
    );

    const result = await port.runPipeline(STUB_RUN_INPUT);

    assert.equal(result.kind, 'completed');
    assert.equal(result.envelope.ok, false);
    const detail = result.envelope.detail as Record<string, unknown>;
    const ariesRunId = String(detail.aries_run_id);
    const stored = loadExecutionRunRecord(ariesRunId);
    assert.equal(stored?.status, 'failed');
    assert.equal(stored?.last_error?.code, 'hermes_gateway_request_failed');
  });
});

test('LegacyOpenClawMarketingPort delegates to the OpenClaw gateway client with the run-pipeline shape', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const previousInvoker = (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__;
  (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__ = (
    payload: Record<string, unknown>,
  ) => {
    calls.push(payload);
    return { ok: true, status: 'completed', output: [{ marker: 'legacy-port' }] };
  };
  try {
    const port = new LegacyOpenClawMarketingPort(() => STUB_RUNTIME_PATHS);
    const result = await port.runPipeline(STUB_RUN_INPUT);
    assert.equal(result.kind, 'completed');
    assert.equal(result.provider, 'legacy-openclaw');
    assert.equal(result.envelope.ok, true);
    assert.equal(result.envelope.status, 'completed');
    assert.equal(calls.length, 1);
    const payload = calls[0];
    assert.equal(payload.tool, 'lobster');
    const args = payload.args as Record<string, unknown>;
    assert.equal(args.action, 'run');
    assert.equal(args.pipeline, 'marketing-pipeline.lobster');
    assert.equal(args.cwd, 'lobster');
    assert.equal(args.argsJson, '{"job_id":"job_test"}');
    assert.equal(args.timeoutMs, 1_000);
    assert.equal(args.maxStdoutBytes, 65_536);
  } finally {
    (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__ = previousInvoker;
  }
});

test('LegacyOpenClawMarketingPort delegates to the OpenClaw gateway client with the resume-pipeline shape', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const previousInvoker = (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__;
  (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__ = (
    payload: Record<string, unknown>,
  ) => {
    calls.push(payload);
    return { ok: true, status: 'completed' };
  };
  try {
    const port = new LegacyOpenClawMarketingPort(() => STUB_RUNTIME_PATHS);
    const result = await port.resumePipeline(STUB_RESUME_INPUT);
    assert.equal(result.kind, 'completed');
    assert.equal(result.provider, 'legacy-openclaw');
    assert.equal(result.envelope.ok, true);
    assert.equal(calls.length, 1);
    const payload = calls[0];
    assert.equal(payload.tool, 'lobster');
    const args = payload.args as Record<string, unknown>;
    assert.equal(args.action, 'resume');
    assert.equal(args.token, 'opaque-token-123');
    assert.equal(args.approve, true);
    assert.equal(args.cwd, 'lobster');
    assert.equal(args.timeoutMs, 1_000);
  } finally {
    (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__ = previousInvoker;
  }
});
