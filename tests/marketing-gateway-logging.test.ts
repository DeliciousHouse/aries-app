import assert from 'node:assert/strict';
import test from 'node:test';

test('runOpenClawLobsterWorkflow logs missing gateway configuration before throwing', async () => {
  const previousGatewayUrl = process.env.OPENCLAW_GATEWAY_URL;
  const previousGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  const originalConsoleError = console.error;
  const logged: unknown[][] = [];

  delete process.env.OPENCLAW_GATEWAY_URL;
  process.env.OPENCLAW_GATEWAY_TOKEN = 'debug-token';
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };

  try {
    const { OpenClawGatewayError, runOpenClawLobsterWorkflow } = await import('../backend/openclaw/gateway-client');

    await assert.rejects(
      () =>
        runOpenClawLobsterWorkflow({
          pipeline: 'stage-1-research/workflow.lobster',
          cwd: '/tmp',
          argsJson: '{}',
        }),
      (error: unknown) =>
        error instanceof OpenClawGatewayError &&
        error.code === 'openclaw_gateway_not_configured'
    );

    assert.ok(logged.length > 0);
  } finally {
    console.error = originalConsoleError;
    if (previousGatewayUrl === undefined) {
      delete process.env.OPENCLAW_GATEWAY_URL;
    } else {
      process.env.OPENCLAW_GATEWAY_URL = previousGatewayUrl;
    }
    if (previousGatewayToken === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = previousGatewayToken;
    }
  }
});

test('runOpenClawLobsterWorkflow falls back to OPENCLAW_LOBSTER_CWD when gateway-specific cwd is unset', async () => {
  const previousGatewayUrl = process.env.OPENCLAW_GATEWAY_URL;
  const previousGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  const previousGatewayLobsterCwd = process.env.OPENCLAW_GATEWAY_LOBSTER_CWD;
  const previousLobsterCwd = process.env.OPENCLAW_LOBSTER_CWD;
  const captured: Array<Record<string, unknown>> = [];

  process.env.OPENCLAW_GATEWAY_URL = 'http://gateway.example.test';
  process.env.OPENCLAW_GATEWAY_TOKEN = 'debug-token';
  delete process.env.OPENCLAW_GATEWAY_LOBSTER_CWD;
  process.env.OPENCLAW_LOBSTER_CWD = '/app/lobster';
  (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__ = (payload: Record<string, unknown>) => {
    captured.push(payload);
    return { ok: true, status: 'ok', output: [], requiresApproval: null };
  };

  try {
    const { runOpenClawLobsterWorkflow } = await import('../backend/openclaw/gateway-client');
    await runOpenClawLobsterWorkflow({
      pipeline: 'stage-1-research/workflow.lobster',
      argsJson: '{}',
    });

    assert.equal(captured.length, 1);
    assert.equal((captured[0]?.args as Record<string, unknown>)?.cwd, '/app/lobster');
  } finally {
    delete (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__;
    if (previousGatewayUrl === undefined) {
      delete process.env.OPENCLAW_GATEWAY_URL;
    } else {
      process.env.OPENCLAW_GATEWAY_URL = previousGatewayUrl;
    }
    if (previousGatewayToken === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = previousGatewayToken;
    }
    if (previousGatewayLobsterCwd === undefined) {
      delete process.env.OPENCLAW_GATEWAY_LOBSTER_CWD;
    } else {
      process.env.OPENCLAW_GATEWAY_LOBSTER_CWD = previousGatewayLobsterCwd;
    }
    if (previousLobsterCwd === undefined) {
      delete process.env.OPENCLAW_LOBSTER_CWD;
    } else {
      process.env.OPENCLAW_LOBSTER_CWD = previousLobsterCwd;
    }
  }
});

test('runOpenClawLobsterWorkflow defaults to gateway-relative lobster cwd in container mode', async () => {
  const previousCodeRoot = process.env.CODE_ROOT;
  const previousGatewayUrl = process.env.OPENCLAW_GATEWAY_URL;
  const previousGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  const previousGatewayLobsterCwd = process.env.OPENCLAW_GATEWAY_LOBSTER_CWD;
  const previousLobsterCwd = process.env.OPENCLAW_LOBSTER_CWD;
  const captured: Array<Record<string, unknown>> = [];

  process.env.CODE_ROOT = '/app';
  process.env.OPENCLAW_GATEWAY_URL = 'http://gateway.example.test';
  process.env.OPENCLAW_GATEWAY_TOKEN = 'debug-token';
  delete process.env.OPENCLAW_GATEWAY_LOBSTER_CWD;
  delete process.env.OPENCLAW_LOBSTER_CWD;
  (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__ = (payload: Record<string, unknown>) => {
    captured.push(payload);
    return { ok: true, status: 'ok', output: [], requiresApproval: null };
  };

  try {
    const { runOpenClawLobsterWorkflow } = await import('../backend/openclaw/gateway-client');
    await runOpenClawLobsterWorkflow({
      pipeline: 'marketing-pipeline.lobster',
      argsJson: '{}',
    });

    assert.equal(captured.length, 1);
    assert.equal((captured[0]?.args as Record<string, unknown>)?.cwd, 'aries-app/lobster');
  } finally {
    delete (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__;
    if (previousCodeRoot === undefined) {
      delete process.env.CODE_ROOT;
    } else {
      process.env.CODE_ROOT = previousCodeRoot;
    }
    if (previousGatewayUrl === undefined) {
      delete process.env.OPENCLAW_GATEWAY_URL;
    } else {
      process.env.OPENCLAW_GATEWAY_URL = previousGatewayUrl;
    }
    if (previousGatewayToken === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = previousGatewayToken;
    }
    if (previousGatewayLobsterCwd === undefined) {
      delete process.env.OPENCLAW_GATEWAY_LOBSTER_CWD;
    } else {
      process.env.OPENCLAW_GATEWAY_LOBSTER_CWD = previousGatewayLobsterCwd;
    }
    if (previousLobsterCwd === undefined) {
      delete process.env.OPENCLAW_LOBSTER_CWD;
    } else {
      process.env.OPENCLAW_LOBSTER_CWD = previousLobsterCwd;
    }
  }
});
