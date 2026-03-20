import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { startOnboarding } from '../backend/onboarding/start';
import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

async function withOnboardingRuntimeEnv<T>(run: (dataRoot: string) => Promise<T>): Promise<T> {
  const previousCodeRoot = process.env.CODE_ROOT;
  const previousDataRoot = process.env.DATA_ROOT;
  const previousOpenClawLobsterCwd = process.env.OPENCLAW_LOBSTER_CWD;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-onboarding-'));

  process.env.CODE_ROOT = PROJECT_ROOT;
  process.env.DATA_ROOT = dataRoot;
  process.env.OPENCLAW_LOBSTER_CWD = path.join(PROJECT_ROOT, 'lobster');

  try {
    return await run(dataRoot);
  } finally {
    if (previousCodeRoot === undefined) {
      delete process.env.CODE_ROOT;
    } else {
      process.env.CODE_ROOT = previousCodeRoot;
    }

    if (previousDataRoot === undefined) {
      delete process.env.DATA_ROOT;
    } else {
      process.env.DATA_ROOT = previousDataRoot;
    }

    if (previousOpenClawLobsterCwd === undefined) {
      delete process.env.OPENCLAW_LOBSTER_CWD;
    } else {
      process.env.OPENCLAW_LOBSTER_CWD = previousOpenClawLobsterCwd;
    }

    await rm(dataRoot, { recursive: true, force: true });
  }
}

function setOpenClawTestInvoker(
  impl: (payload: Record<string, unknown>) => unknown | Promise<unknown>
): void {
  (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__ = impl;
}

function clearOpenClawTestInvoker(): void {
  delete (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__;
}

test('startOnboarding delegates to OpenClaw and surfaces parity-stub not-implemented status', async () => {
  await withOnboardingRuntimeEnv(async (dataRoot) => {
    let captured: Record<string, unknown> | null = null;
    setOpenClawTestInvoker((payload) => {
      captured = payload;
      return {
        ok: true,
        status: 'ok',
        output: [{
          status: 'not_implemented',
          code: 'workflow_missing_for_route',
          route: 'onboarding.start',
          message: 'No production-parity OpenClaw workflow is installed for this route yet.',
        }],
        requiresApproval: null,
      };
    });

    const result = await startOnboarding({
      tenant_id: 'tenant-local',
      tenant_type: 'single_user',
      signup_event_id: 'signup-local',
      metadata: { source: 'test' },
    });

    assert.equal(result.status, 'error');
    assert.equal(result.tenant_id, 'tenant-local');
    assert.equal(result.tenant_type, 'single_user');
    assert.equal(result.signup_event_id, 'signup-local');
    assert.equal(result.reason, 'workflow_missing_for_route');
    assert.equal((captured as any)?.args?.pipeline, 'parity/onboarding-start/workflow.lobster');
    assert.equal(JSON.parse(String((captured as any)?.args?.argsJson)).tenant_id, 'tenant-local');
    clearOpenClawTestInvoker();
  });
});
