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

test('resolveOpenClawLobsterRuntimeContext defaults the remote Lobster state dir to /home/node instead of the app process HOME', async () => {
  const previousGatewayHome = process.env.OPENCLAW_GATEWAY_HOME;
  const previousOpenClawHome = process.env.OPENCLAW_HOME;
  const previousHome = process.env.HOME;

  delete process.env.OPENCLAW_GATEWAY_HOME;
  delete process.env.OPENCLAW_HOME;
  process.env.HOME = '/root';

  try {
    const { resolveOpenClawLobsterRuntimeContext } = await import('../backend/openclaw/gateway-client');
    const runtime = resolveOpenClawLobsterRuntimeContext();

    assert.equal(runtime.stateDir, '/home/node/.lobster');
  } finally {
    if (previousGatewayHome === undefined) {
      delete process.env.OPENCLAW_GATEWAY_HOME;
    } else {
      process.env.OPENCLAW_GATEWAY_HOME = previousGatewayHome;
    }
    if (previousOpenClawHome === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = previousOpenClawHome;
    }
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});

test('resumeOpenClawLobsterWorkflow retries compatible Lobster state keys when resume state lookup fails', async () => {
  const previousGatewayUrl = process.env.OPENCLAW_GATEWAY_URL;
  const previousGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  const previousGatewayLobsterCwd = process.env.OPENCLAW_GATEWAY_LOBSTER_CWD;
  const previousLobsterCwd = process.env.OPENCLAW_LOBSTER_CWD;

  process.env.OPENCLAW_GATEWAY_URL = 'http://gateway.example.test';
  process.env.OPENCLAW_GATEWAY_TOKEN = 'debug-token';
  delete process.env.OPENCLAW_GATEWAY_LOBSTER_CWD;
  process.env.OPENCLAW_LOBSTER_CWD = '/app/lobster';

  try {
    const {
      OpenClawGatewayError,
      resumeOpenClawLobsterWorkflow,
    } = await import('../backend/openclaw/gateway-client');

    const originalPayload = {
      protocolVersion: 1,
      v: 1,
      kind: 'workflow-file',
      stateKey: 'workflow_resume_compat_123',
    };
    const fallbackPayload = {
      ...originalPayload,
      stateKey: 'workflow-resume_compat_123',
    };
    const originalToken = Buffer.from(JSON.stringify(originalPayload)).toString('base64url');
    const fallbackToken = Buffer.from(JSON.stringify(fallbackPayload)).toString('base64url');
    const attemptedTokens: string[] = [];

    (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__ = (payload: Record<string, unknown>) => {
      const args = (payload.args as Record<string, unknown> | undefined) ?? {};
      const token = String(args.token || '');
      attemptedTokens.push(token);

      if (token === originalToken) {
        throw new OpenClawGatewayError(
          'openclaw_gateway_server_error',
          'lobster failed (1): {"message":"Workflow resume state not found"}',
          500,
        );
      }

      assert.equal(token, fallbackToken);
      return { ok: true, status: 'ok', output: [], requiresApproval: null };
    };

    const envelope = await resumeOpenClawLobsterWorkflow({
      token: originalToken,
      approve: true,
    });

    assert.equal(envelope.status, 'ok');
    assert.deepEqual(attemptedTokens, [originalToken, fallbackToken]);
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
