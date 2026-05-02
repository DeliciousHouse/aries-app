import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  cancelAriesWorkflow,
  mapAriesExecutionError,
  runAriesWorkflow,
} from '../backend/execution';
import { OpenClawGatewayError } from '../backend/openclaw/gateway-client';

const APP_API_ROOT = path.join(process.cwd(), 'app', 'api');

function setOpenClawTestInvoker(
  impl: (payload: Record<string, unknown>) => unknown | Promise<unknown>,
): void {
  (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__ = impl;
}

function clearOpenClawTestInvoker(): void {
  delete (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__;
}

async function collectRouteFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return collectRouteFiles(fullPath);
      }
      if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
        return [fullPath];
      }
      return [];
    }),
  );
  return files.flat();
}

test('backend/execution exports provider-neutral route helpers', () => {
  assert.equal(typeof runAriesWorkflow, 'function');
  assert.equal(typeof mapAriesExecutionError, 'function');
  assert.equal(typeof cancelAriesWorkflow, 'function');
});

test('runAriesWorkflow maps legacy gateway errors into provider-neutral route errors', async () => {
  setOpenClawTestInvoker(() => {
    throw new OpenClawGatewayError('openclaw_gateway_request_invalid', 'bad payload', 400);
  });

  try {
    const executed = await runAriesWorkflow('demo_start', {
      source: 'marketing-site',
      surface: 'marketing-site',
      user: { name: 'Test', email: 'test@example.com' },
      details: {},
    });

    assert.equal(executed.kind, 'gateway_error');
    if (executed.kind !== 'gateway_error') {
      assert.fail('expected gateway_error result');
      return;
    }

    const mapped = mapAriesExecutionError(executed.error);
    assert.deepEqual(mapped, {
      status: 400,
      body: {
        error: 'bad payload',
        reason: 'openclaw_gateway_request_invalid',
      },
    });
  } finally {
    clearOpenClawTestInvoker();
  }
});

test('cancelAriesWorkflow delegates the legacy cancel payload through the neutral helper', async () => {
  const captured: Record<string, unknown>[] = [];
  setOpenClawTestInvoker((payload) => {
    captured.push(payload);
    return { ok: true, status: 'ok', output: [], requiresApproval: null };
  });

  try {
    const result = await cancelAriesWorkflow({
      correlationId: 'job-123',
      cwd: '/tmp/aries-workflow',
      timeoutMs: 2_500,
    });

    assert.deepEqual(result, { cancelled: true });
    assert.deepEqual(captured, [
      {
        tool: 'lobster',
        sessionKey: 'main',
        args: {
          action: 'cancel',
          correlationId: 'job-123',
          cwd: '/tmp/aries-workflow',
          timeoutMs: 2_500,
        },
      },
    ]);
  } finally {
    clearOpenClawTestInvoker();
  }
});

test('app/api route handlers no longer import backend/openclaw directly', async () => {
  const routeFiles = await collectRouteFiles(APP_API_ROOT);
  const offenders: string[] = [];

  for (const filePath of routeFiles) {
    const source = await readFile(filePath, 'utf8');
    if (source.includes('backend/openclaw')) {
      offenders.push(path.relative(process.cwd(), filePath));
    }
  }

  assert.deepEqual(offenders, []);
});
