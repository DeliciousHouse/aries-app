import assert from 'node:assert/strict';
import test from 'node:test';

import { ExecutionError, LegacyOpenClawExecutionAdapter } from '../backend/execution';
import { OpenClawGatewayError } from '../backend/openclaw/gateway-client';

function setOpenClawTestInvoker(
  impl: (payload: Record<string, unknown>) => unknown | Promise<unknown>,
): void {
  (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__ = impl;
}

function clearOpenClawTestInvoker(): void {
  delete (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__;
}

test('LegacyOpenClawExecutionAdapter.run delegates the legacy run payload shape and returns ok results', async () => {
  const adapter = new LegacyOpenClawExecutionAdapter();
  const captured: Record<string, unknown>[] = [];

  setOpenClawTestInvoker((payload) => {
    captured.push(payload);
    return {
      ok: true,
      status: 'ok',
      output: [{ accepted: true, runId: 'run-123' }],
      requiresApproval: null,
    };
  });

  try {
    const result = await adapter.run({
      pipeline: 'marketing-pipeline.lobster',
      cwd: '/tmp/aries-workflow',
      argsJson: '{"tenantId":"tenant-123"}',
      timeoutMs: 45_000,
      maxStdoutBytes: 65_536,
      allowLocalFallback: false,
    });

    assert.equal(adapter.name, 'openclaw');
    assert.equal(result.kind, 'ok');
    if (result.kind !== 'ok') {
      assert.fail('expected ok result');
    }

    assert.deepEqual(result.primaryOutput, { accepted: true, runId: 'run-123' });
    assert.equal(captured.length, 1);
    assert.deepEqual(captured[0], {
      tool: 'lobster',
      sessionKey: 'main',
      args: {
        action: 'run',
        pipeline: 'marketing-pipeline.lobster',
        argsJson: '{"tenantId":"tenant-123"}',
        cwd: '/tmp/aries-workflow',
        timeoutMs: 45_000,
        maxStdoutBytes: 65_536,
      },
    });
  } finally {
    clearOpenClawTestInvoker();
  }
});

test('LegacyOpenClawExecutionAdapter.run maps OpenClawGatewayError to ExecutionError without losing status or code', async () => {
  const adapter = new LegacyOpenClawExecutionAdapter();

  setOpenClawTestInvoker(() => {
    throw new OpenClawGatewayError(
      'openclaw_gateway_request_invalid',
      'workflow args are invalid',
      400,
    );
  });

  try {
    const result = await adapter.run({
      pipeline: 'marketing-pipeline.lobster',
      cwd: '/tmp/aries-workflow',
      argsJson: '{}',
      allowLocalFallback: false,
    });

    assert.equal(result.kind, 'gateway_error');
    if (result.kind !== 'gateway_error') {
      assert.fail('expected gateway_error result');
    }

    assert.ok(result.error instanceof ExecutionError);
    assert.equal(result.error.provider, 'openclaw');
    assert.equal(result.error.code, 'request_invalid');
    assert.equal(result.error.message, 'workflow args are invalid');
    assert.equal(result.error.status, 400);
    assert.ok(result.error.cause instanceof OpenClawGatewayError);
  } finally {
    clearOpenClawTestInvoker();
  }
});

test('LegacyOpenClawExecutionAdapter.resume delegates the legacy resume payload shape and returns ok results', async () => {
  const adapter = new LegacyOpenClawExecutionAdapter();
  const captured: Record<string, unknown>[] = [];

  setOpenClawTestInvoker((payload) => {
    captured.push(payload);
    return {
      ok: true,
      status: 'ok',
      output: [{ resumed: true }],
      requiresApproval: null,
    };
  });

  try {
    const result = await adapter.resume({
      token: 'workflow_resume_run-123',
      approve: true,
      cwd: '/tmp/aries-workflow',
      timeoutMs: 30_000,
      maxStdoutBytes: 4_096,
      allowLocalFallback: false,
    });

    assert.equal(result.kind, 'ok');
    if (result.kind !== 'ok') {
      assert.fail('expected ok result');
    }

    assert.deepEqual(result.primaryOutput, { resumed: true });
    assert.equal(captured.length, 1);
    assert.deepEqual(captured[0], {
      tool: 'lobster',
      sessionKey: 'main',
      args: {
        action: 'resume',
        token: 'workflow_resume_run-123',
        approve: true,
        cwd: '/tmp/aries-workflow',
        timeoutMs: 30_000,
        maxStdoutBytes: 4_096,
      },
    });
  } finally {
    clearOpenClawTestInvoker();
  }
});

test('LegacyOpenClawExecutionAdapter.cancel delegates the legacy cancel payload shape', async () => {
  const adapter = new LegacyOpenClawExecutionAdapter();
  const captured: Record<string, unknown>[] = [];

  setOpenClawTestInvoker((payload) => {
    captured.push(payload);
    return {
      ok: true,
      status: 'ok',
      output: [],
      requiresApproval: null,
    };
  });

  try {
    const result = await adapter.cancel({
      correlationId: 'job-123',
      cwd: '/tmp/aries-workflow',
      timeoutMs: 2_500,
    });

    assert.deepEqual(result, { cancelled: true });
    assert.equal(captured.length, 1);
    assert.deepEqual(captured[0], {
      tool: 'lobster',
      sessionKey: 'main',
      args: {
        action: 'cancel',
        correlationId: 'job-123',
        cwd: '/tmp/aries-workflow',
        timeoutMs: 2_500,
      },
    });
  } finally {
    clearOpenClawTestInvoker();
  }
});
