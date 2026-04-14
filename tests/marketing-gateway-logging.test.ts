import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('runOpenClawLobsterWorkflow logs missing gateway configuration before attempting local fallback', async () => {
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
        error.code === 'openclaw_gateway_unreachable' &&
        /local lobster cli failed/i.test(error.message)
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

test('runOpenClawLobsterWorkflow can disable PATH-based local fallback', async () => {
  const previousGatewayUrl = process.env.OPENCLAW_GATEWAY_URL;
  const previousGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;

  delete process.env.OPENCLAW_GATEWAY_URL;
  process.env.OPENCLAW_GATEWAY_TOKEN = 'debug-token';

  try {
    const { OpenClawGatewayError, runOpenClawLobsterWorkflow } = await import('../backend/openclaw/gateway-client');

    await assert.rejects(
      () =>
        runOpenClawLobsterWorkflow({
          pipeline: 'stage-1-research/workflow.lobster',
          cwd: 'lobster',
          argsJson: '{}',
          allowLocalFallback: false,
        }),
      (error: unknown) =>
        error instanceof OpenClawGatewayError &&
        error.code === 'openclaw_gateway_not_configured' &&
        /missing required openclaw environment variable: OPENCLAW_GATEWAY_URL/i.test(error.message),
    );
  } finally {
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

test('resumeOpenClawLobsterWorkflow preserves detailed gateway failure messages from error.details', async () => {
  const previousGatewayUrl = process.env.OPENCLAW_GATEWAY_URL;
  const previousGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  const previousFetch = globalThis.fetch;

  process.env.OPENCLAW_GATEWAY_URL = 'http://gateway.example.test';
  process.env.OPENCLAW_GATEWAY_TOKEN = 'debug-token';
  globalThis.fetch = ((async () =>
    new Response(
      JSON.stringify({
        ok: false,
        error: {
          type: 'tool_error',
          message: 'tool execution failed',
          details: {
            message: 'lobster failed (1): {"message":"Workflow resume state not found"}',
          },
        },
      }),
      {
        status: 500,
        headers: { 'content-type': 'application/json' },
      },
    )) as unknown) as typeof globalThis.fetch;

  try {
    const {
      OpenClawGatewayError,
      resumeOpenClawLobsterWorkflow,
    } = await import('../backend/openclaw/gateway-client');

    await assert.rejects(
      () =>
        resumeOpenClawLobsterWorkflow({
          token: 'resume_strategy',
          approve: true,
        }),
      (error: unknown) =>
        error instanceof OpenClawGatewayError &&
        /workflow resume state not found/i.test(error.message),
    );
  } finally {
    globalThis.fetch = previousFetch;
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

test('runOpenClawLobsterWorkflow normalizes OPENCLAW_LOBSTER_CWD when gateway-specific cwd is unset', async () => {
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
    assert.equal((captured[0]?.args as Record<string, unknown>)?.cwd, 'lobster');
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
    assert.equal((captured[0]?.args as Record<string, unknown>)?.cwd, 'lobster');
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

test('runOpenClawLobsterWorkflow normalizes the bind-mounted /app/aries-app lobster path for gateway calls', async () => {
  const previousCodeRoot = process.env.CODE_ROOT;
  const previousGatewayUrl = process.env.OPENCLAW_GATEWAY_URL;
  const previousGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  const previousGatewayLobsterCwd = process.env.OPENCLAW_GATEWAY_LOBSTER_CWD;
  const captured: Array<Record<string, unknown>> = [];

  process.env.CODE_ROOT = '/app';
  process.env.OPENCLAW_GATEWAY_URL = 'http://gateway.example.test';
  process.env.OPENCLAW_GATEWAY_TOKEN = 'debug-token';
  process.env.OPENCLAW_GATEWAY_LOBSTER_CWD = '/app/aries-app/lobster';
  (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__ = (payload: Record<string, unknown>) => {
    captured.push(payload);
    return { ok: true, status: 'ok', output: [], requiresApproval: null };
  };

  try {
    const {
      resolveOpenClawLobsterRuntimeContext,
      runOpenClawLobsterWorkflow,
    } = await import('../backend/openclaw/gateway-client');
    const runtime = resolveOpenClawLobsterRuntimeContext();
    await runOpenClawLobsterWorkflow({
      pipeline: 'marketing-pipeline.lobster',
      argsJson: '{}',
    });

    assert.equal(runtime.configuredCwd, '/app/aries-app/lobster');
    assert.equal(runtime.cwd, 'lobster');
    assert.equal(captured.length, 1);
    assert.equal((captured[0]?.args as Record<string, unknown>)?.cwd, 'lobster');
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
  }
});

test('runOpenClawLobsterWorkflow keeps gateway cwd relative to the gateway root when CODE_ROOT resolves to the mounted aries-app checkout', async () => {
  const previousCodeRoot = process.env.CODE_ROOT;
  const previousGatewayUrl = process.env.OPENCLAW_GATEWAY_URL;
  const previousGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  const previousGatewayLobsterCwd = process.env.OPENCLAW_GATEWAY_LOBSTER_CWD;
  const captured: Array<Record<string, unknown>> = [];
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'aries-gateway-cwd-'));
  const appRoot = path.join(fixtureRoot, 'aries-app');

  await mkdir(appRoot, { recursive: true });
  await Promise.all([
    mkdir(path.join(appRoot, 'app'), { recursive: true }),
    mkdir(path.join(appRoot, 'backend'), { recursive: true }),
    mkdir(path.join(appRoot, 'specs'), { recursive: true }),
    writeFile(path.join(appRoot, 'package.json'), '{}'),
  ]);

  process.env.CODE_ROOT = fixtureRoot;
  process.env.OPENCLAW_GATEWAY_URL = 'http://gateway.example.test';
  process.env.OPENCLAW_GATEWAY_TOKEN = 'debug-token';
  process.env.OPENCLAW_GATEWAY_LOBSTER_CWD = path.join(appRoot, 'lobster');
  (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__ = (payload: Record<string, unknown>) => {
    captured.push(payload);
    return { ok: true, status: 'ok', output: [], requiresApproval: null };
  };

  try {
    const {
      resolveOpenClawLobsterRuntimeContext,
      runOpenClawLobsterWorkflow,
    } = await import('../backend/openclaw/gateway-client');
    const runtime = resolveOpenClawLobsterRuntimeContext();
    await runOpenClawLobsterWorkflow({
      pipeline: 'marketing-pipeline.lobster',
      argsJson: '{}',
    });

    assert.equal(runtime.configuredCwd, path.join(appRoot, 'lobster'));
    assert.equal(runtime.cwd, 'lobster');
    assert.equal(captured.length, 1);
    assert.equal((captured[0]?.args as Record<string, unknown>)?.cwd, 'lobster');
  } finally {
    delete (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__;
    await rm(fixtureRoot, { recursive: true, force: true });
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
  }
});

test("resolveOpenClawLobsterRuntimeContext defaults the remote Lobster state dir to Lobster's real default state path", async () => {
  const previousGatewayHome = process.env.OPENCLAW_GATEWAY_HOME;
  const previousOpenClawHome = process.env.OPENCLAW_HOME;
  const previousLobsterStateDir = process.env.LOBSTER_STATE_DIR;
  const previousHome = process.env.HOME;

  delete process.env.OPENCLAW_GATEWAY_HOME;
  delete process.env.OPENCLAW_HOME;
  delete process.env.LOBSTER_STATE_DIR;
  process.env.HOME = '/root';

  try {
    const { resolveOpenClawLobsterRuntimeContext } = await import('../backend/openclaw/gateway-client');
    const runtime = resolveOpenClawLobsterRuntimeContext();

    assert.equal(runtime.stateDir, '/home/node/.lobster/state');
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
    if (previousLobsterStateDir === undefined) {
      delete process.env.LOBSTER_STATE_DIR;
    } else {
      process.env.LOBSTER_STATE_DIR = previousLobsterStateDir;
    }
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});

test('resolveOpenClawLobsterRuntimeContext prefers the Lobster-native state dir env when it is set', async () => {
  const previousLobsterStateDir = process.env.LOBSTER_STATE_DIR;
  const previousGatewayStateDir = process.env.OPENCLAW_GATEWAY_LOBSTER_STATE_DIR;
  const previousStateDir = process.env.OPENCLAW_LOBSTER_STATE_DIR;

  process.env.LOBSTER_STATE_DIR = '/persisted/lobster-state';
  delete process.env.OPENCLAW_GATEWAY_LOBSTER_STATE_DIR;
  delete process.env.OPENCLAW_LOBSTER_STATE_DIR;

  try {
    const { resolveOpenClawLobsterRuntimeContext } = await import('../backend/openclaw/gateway-client');
    const runtime = resolveOpenClawLobsterRuntimeContext();

    assert.equal(runtime.stateDir, '/persisted/lobster-state');
  } finally {
    if (previousLobsterStateDir === undefined) {
      delete process.env.LOBSTER_STATE_DIR;
    } else {
      process.env.LOBSTER_STATE_DIR = previousLobsterStateDir;
    }
    if (previousGatewayStateDir === undefined) {
      delete process.env.OPENCLAW_GATEWAY_LOBSTER_STATE_DIR;
    } else {
      process.env.OPENCLAW_GATEWAY_LOBSTER_STATE_DIR = previousGatewayStateDir;
    }
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_LOBSTER_STATE_DIR;
    } else {
      process.env.OPENCLAW_LOBSTER_STATE_DIR = previousStateDir;
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
