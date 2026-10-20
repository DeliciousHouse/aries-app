import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createExecutionRunRecord, executionRunPath, listExecutionRunRecords, markExecutionRunFailed } from '../backend/execution/run-store';

test('protects complete deployment inventory; fails_when missing/corrupt/history is silently empty; no_claim remote outcomes', async () => {
  const previous = process.env.DATA_ROOT;
  const root = await mkdtemp(path.join(tmpdir(), 'aries-inventory-'));
  process.env.DATA_ROOT = root;
  try {
    assert.throws(() => listExecutionRunRecords({ strict: true }), /inventory unavailable/);
    await mkdir(path.dirname(executionRunPath('probe')), { recursive: true });
    assert.deepEqual(listExecutionRunRecords({ strict: true }), []);
    const run = createExecutionRunRecord({ provider: 'hermes', domain: 'marketing', workflowKey: 'weekly', action: 'run' });
    markExecutionRunFailed(run.aries_run_id, { code: 'legacy_lost_response', message: 'Unknown' });
    await utimes(executionRunPath(run.aries_run_id), new Date(0), new Date(0));
    assert.equal(listExecutionRunRecords({ strict: true }).length, 1);
    assert.throws(() => listExecutionRunRecords({ strict: true, modifiedWithinMs: 1 }), /cannot truncate/);
    for (const content of ['{', '{}', JSON.stringify({ ...run, aries_run_id: 'different' }), JSON.stringify({ ...run, status: 'unknown' })]) {
      await writeFile(executionRunPath(run.aries_run_id), content);
      assert.throws(() => listExecutionRunRecords({ strict: true }), /inventory record invalid/);
    }
  } finally {
    if (previous === undefined) delete process.env.DATA_ROOT; else process.env.DATA_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});
