import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function withDataRoot<T>(run: (dataRoot: string) => Promise<T>): Promise<T> {
  const previousDataRoot = process.env.DATA_ROOT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-execution-runs-'));

  process.env.DATA_ROOT = dataRoot;
  try {
    return await run(dataRoot);
  } finally {
    if (previousDataRoot === undefined) {
      delete process.env.DATA_ROOT;
    } else {
      process.env.DATA_ROOT = previousDataRoot;
    }
    await rm(dataRoot, { recursive: true, force: true });
  }
}

test('execution run records persist provider correlation and callback idempotency', async () => {
  await withDataRoot(async () => {
    const {
      createExecutionRunRecord,
      hasExecutionRunEvent,
      loadExecutionRunRecord,
      markExecutionRunEventApplied,
      markExecutionRunSubmitted,
    } = await import('../backend/execution/run-store');

    const created = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'marketing',
      workflowKey: 'marketing_pipeline',
      action: 'run',
      tenantId: 'tenant-123',
      marketingJobId: 'job-123',
      stage: 'research',
    });

    assert.match(created.aries_run_id, /^arun_/);
    assert.equal(created.status, 'submitted');
    assert.equal(created.external_run_id, null);

    const submitted = markExecutionRunSubmitted(created.aries_run_id, {
      externalRunId: 'hermes-run-123',
    });
    assert.equal(submitted?.external_run_id, 'hermes-run-123');

    assert.equal(hasExecutionRunEvent(created.aries_run_id, 'evt-1'), false);
    const first = markExecutionRunEventApplied(created.aries_run_id, {
      eventId: 'evt-1',
      status: 'running',
      result: { progress: 'researching' },
    });
    const duplicate = markExecutionRunEventApplied(created.aries_run_id, {
      eventId: 'evt-1',
      status: 'completed',
      result: { progress: 'done' },
    });

    assert.equal(first?.status, 'running');
    assert.equal(duplicate?.status, 'running');
    assert.equal(hasExecutionRunEvent(created.aries_run_id, 'evt-1'), true);

    const reloaded = loadExecutionRunRecord(created.aries_run_id);
    assert.equal(reloaded?.provider, 'hermes');
    assert.equal(reloaded?.domain, 'marketing');
    assert.equal(reloaded?.workflow_key, 'marketing_pipeline');
    assert.equal(reloaded?.marketing_job_id, 'job-123');
    assert.deepEqual(reloaded?.event_ids, ['evt-1']);
    assert.deepEqual(reloaded?.result, { progress: 'researching' });
  });
});

test('execution run submission preserves a status already advanced by callback', async () => {
  await withDataRoot(async () => {
    const {
      createExecutionRunRecord,
      loadExecutionRunRecord,
      markExecutionRunEventApplied,
      markExecutionRunSubmitted,
    } = await import('../backend/execution/run-store');

    const created = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'route',
      workflowKey: 'demo_start',
      action: 'run',
    });

    markExecutionRunEventApplied(created.aries_run_id, {
      eventId: 'evt-fast-callback',
      status: 'completed',
      result: [{ provisioned: true }],
      externalRunId: 'hermes-run-fast',
    });
    markExecutionRunSubmitted(created.aries_run_id, {
      externalRunId: 'hermes-run-fast',
    });

    const reloaded = loadExecutionRunRecord(created.aries_run_id);
    assert.equal(reloaded?.status, 'completed');
    assert.equal(reloaded?.external_run_id, 'hermes-run-fast');
  });
});

test('executionRunPath throws for path-traversal aries_run_id values', async () => {
  await withDataRoot(async () => {
    const { executionRunPath } = await import('../backend/execution/run-store');

    const traversalIds = [
      '../../etc/passwd',
      '/etc/passwd',
      '../arun_00000000-0000-0000-0000-000000000000',
    ];

    for (const id of traversalIds) {
      assert.throws(
        () => executionRunPath(id),
        /path escapes execution-runs directory/,
        `expected throw for id: ${id}`,
      );
    }
  });
});
