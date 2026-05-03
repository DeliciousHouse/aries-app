import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_MARKETING_EXECUTION_PORT,
  getMarketingExecutionPort,
  resolveMarketingExecutionPortName,
} from '../backend/marketing/execution-port';
import { HermesMarketingPort } from '../backend/marketing/ports/hermes';
import { LegacyOpenClawMarketingPort } from '../backend/marketing/ports/legacy-openclaw';
import type { MarketingJobRuntimeDocument } from '../backend/marketing/runtime-state';

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

test('marketing port name defaults to legacy-openclaw when no env var is set', () => {
  assert.equal(resolveMarketingExecutionPortName({}), 'legacy-openclaw');
  assert.equal(DEFAULT_MARKETING_EXECUTION_PORT, 'legacy-openclaw');
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

test('marketing port name does NOT promote to hermes when only the global flag is set', () => {
  // Marketing migration is opt-in; the global ARIES_EXECUTION_PROVIDER must
  // not silently switch approval-bearing campaigns onto unimplemented Hermes.
  assert.equal(
    resolveMarketingExecutionPortName({ ARIES_EXECUTION_PROVIDER: 'hermes' }),
    'legacy-openclaw',
  );
});

test('marketing port name falls back to legacy-openclaw on unknown values', () => {
  assert.equal(
    resolveMarketingExecutionPortName({ ARIES_MARKETING_EXECUTION_PROVIDER: 'unsupported' }),
    'legacy-openclaw',
  );
});

test('getMarketingExecutionPort returns the legacy port by default', () => {
  const port = getMarketingExecutionPort(() => STUB_RUNTIME_PATHS, {});
  assert.ok(port instanceof LegacyOpenClawMarketingPort);
  assert.equal(port.name, 'legacy-openclaw');
});

test('getMarketingExecutionPort returns the Hermes port when explicitly selected', () => {
  const port = getMarketingExecutionPort(
    () => STUB_RUNTIME_PATHS,
    { ARIES_MARKETING_EXECUTION_PROVIDER: 'hermes' },
  );
  assert.ok(port instanceof HermesMarketingPort);
  assert.equal(port.name, 'hermes');
});

test('HermesMarketingPort.runPipeline returns an honest not_implemented envelope', async () => {
  const port = new HermesMarketingPort();
  const envelope = await port.runPipeline(STUB_RUN_INPUT);

  assert.equal(envelope.ok, false);
  assert.equal(envelope.status, 'not_implemented');
  assert.equal(envelope.provider, 'hermes');
  assert.equal(envelope.action, 'run');
  assert.equal(envelope.code, 'hermes_marketing_pipeline_not_implemented');
  assert.match(String(envelope.message), /Hermes marketing/);
  assert.match(String(envelope.message), /ARIES_MARKETING_EXECUTION_PROVIDER=legacy-openclaw/);
  assert.deepEqual(envelope.detail, { jobId: 'job_test' });
});

test('HermesMarketingPort.resumePipeline returns honest not_implemented and never leaks raw resume tokens', async () => {
  const port = new HermesMarketingPort();
  const envelope = await port.resumePipeline(STUB_RESUME_INPUT);

  assert.equal(envelope.ok, false);
  assert.equal(envelope.status, 'not_implemented');
  assert.equal(envelope.action, 'resume');
  const detail = envelope.detail as Record<string, unknown>;
  assert.equal(detail.approve, true);
  // Resume token must never appear in plain text on the envelope — only a
  // truncated correlation id.
  const detailJson = JSON.stringify(envelope);
  assert.equal(detailJson.includes('opaque-token-123'), false);
  assert.match(String(detail.resumeTokenFingerprint), /^tok_/);
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
    const envelope = await port.runPipeline(STUB_RUN_INPUT);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.status, 'completed');
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
    const envelope = await port.resumePipeline(STUB_RESUME_INPUT);
    assert.equal(envelope.ok, true);
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
