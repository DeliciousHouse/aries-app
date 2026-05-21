import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  cancelAriesWorkflow,
  mapAriesExecutionError,
  runAriesWorkflow,
  ExecutionError,
} from '../backend/execution';

const APP_API_ROOT = path.join(process.cwd(), 'app', 'api');

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

test('backend/execution exports route helpers', () => {
  assert.equal(typeof runAriesWorkflow, 'function');
  assert.equal(typeof mapAriesExecutionError, 'function');
  assert.equal(typeof cancelAriesWorkflow, 'function');
});

test('mapAriesExecutionError maps ExecutionError into a route-shaped response', () => {
  const mapped = mapAriesExecutionError(
    new ExecutionError({
      provider: 'hermes',
      code: 'tool_unavailable',
      message: 'Hermes does not expose the requested tool.',
      status: 404,
    }),
  );

  assert.deepEqual(mapped, {
    status: 500,
    body: {
      status: 'error',
      error: 'Hermes does not expose the requested tool.',
      reason: 'tool_unavailable',
      message: 'Hermes does not expose the requested tool.',
    },
  });
});

test('mapAriesExecutionError returns null for non-ExecutionError inputs', () => {
  assert.equal(mapAriesExecutionError(new Error('plain')), null);
});

test('cancelAriesWorkflow is a best-effort no-op for Hermes execution', async () => {
  const result = await cancelAriesWorkflow({ correlationId: 'job-123' });
  assert.deepEqual(result, { cancelled: false, reason: 'cancel_not_supported' });
});

test('app/api route handlers do not import backend/openclaw', async () => {
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
