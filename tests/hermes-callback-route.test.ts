import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function withCallbackEnv<T>(run: () => Promise<T>): Promise<T> {
  const previousDataRoot = process.env.DATA_ROOT;
  const previousSecret = process.env.INTERNAL_API_SECRET;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-hermes-callback-'));

  process.env.DATA_ROOT = dataRoot;
  process.env.INTERNAL_API_SECRET = 'internal-secret';
  try {
    return await run();
  } finally {
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    if (previousSecret === undefined) delete process.env.INTERNAL_API_SECRET;
    else process.env.INTERNAL_API_SECRET = previousSecret;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

function callbackRequest(body: unknown, token = 'internal-secret'): Request {
  return new Request('https://aries.example.com/api/internal/hermes/runs', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

test('Hermes callback route authenticates and applies run events idempotently', async () => {
  await withCallbackEnv(async () => {
    const { createExecutionRunRecord, loadExecutionRunRecord } = await import('../backend/execution/run-store');
    const { POST } = await import('../app/api/internal/hermes/runs/route');

    const record = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'route',
      workflowKey: 'demo_start',
      action: 'run',
      tenantId: 'tenant-123',
    });

    const payload = {
      event_id: 'evt-1',
      aries_run_id: record.aries_run_id,
      hermes_run_id: 'hermes-run-1',
      status: 'completed',
      output: [{ provisioned: true }],
    };

    const first = await POST(callbackRequest(payload));
    const duplicate = await POST(callbackRequest(payload));

    assert.equal(first.status, 200);
    assert.equal(duplicate.status, 200);
    assert.deepEqual(await first.json(), {
      status: 'accepted',
      ariesRunId: record.aries_run_id,
      duplicate: false,
    });
    assert.deepEqual(await duplicate.json(), {
      status: 'accepted',
      ariesRunId: record.aries_run_id,
      duplicate: true,
    });

    const reloaded = loadExecutionRunRecord(record.aries_run_id);
    assert.equal(reloaded?.external_run_id, 'hermes-run-1');
    assert.equal(reloaded?.status, 'completed');
    assert.deepEqual(reloaded?.event_ids, ['evt-1']);
    assert.deepEqual(reloaded?.result, [{ provisioned: true }]);
  });
});

test('Hermes callback route rejects missing and invalid internal secrets', async () => {
  await withCallbackEnv(async () => {
    const { POST } = await import('../app/api/internal/hermes/runs/route');

    const missing = await POST(new Request('https://aries.example.com/api/internal/hermes/runs', {
      method: 'POST',
      body: JSON.stringify({}),
    }));
    const invalid = await POST(callbackRequest({}, 'wrong-secret'));

    assert.equal(missing.status, 401);
    assert.equal(invalid.status, 403);
  });
});

test('Hermes callback route rejects callbacks with mismatched Hermes run ids', async () => {
  await withCallbackEnv(async () => {
    const {
      createExecutionRunRecord,
      markExecutionRunSubmitted,
    } = await import('../backend/execution/run-store');
    const { POST } = await import('../app/api/internal/hermes/runs/route');

    const record = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'route',
      workflowKey: 'demo_start',
      action: 'run',
    });
    markExecutionRunSubmitted(record.aries_run_id, { externalRunId: 'hermes-run-expected' });

    const response = await POST(callbackRequest({
      event_id: 'evt-mismatch',
      aries_run_id: record.aries_run_id,
      hermes_run_id: 'hermes-run-other',
      status: 'completed',
      output: [{ ok: true }],
    }));

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      status: 'error',
      reason: 'hermes_run_id_mismatch',
    });
  });
});

test('Hermes callback route rejects path-traversal aries_run_id values', async () => {
  await withCallbackEnv(async () => {
    const { POST } = await import('../app/api/internal/hermes/runs/route');

    const traversalIds = [
      '../../etc/passwd',
      '/etc/passwd',
      'arun_../../etc',
      '../arun_00000000-0000-0000-0000-000000000000',
      'arun_00000000-0000-0000-0000-000000000000/../../../etc/passwd',
    ];

    for (const ariesRunId of traversalIds) {
      const response = await POST(callbackRequest({
        event_id: 'evt-traversal',
        aries_run_id: ariesRunId,
        status: 'completed',
      }));
      assert.equal(response.status, 400, `expected 400 for aries_run_id: ${ariesRunId}`);
      assert.deepEqual(await response.json(), {
        status: 'error',
        reason: 'invalid_hermes_callback_payload',
      });
    }
  });
});

test('Hermes callback route rejects malformed approval payloads', async () => {
  await withCallbackEnv(async () => {
    const { createExecutionRunRecord } = await import('../backend/execution/run-store');
    const { POST } = await import('../app/api/internal/hermes/runs/route');

    const record = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'marketing',
      workflowKey: 'marketing_pipeline',
      action: 'run',
      marketingJobId: 'job-123',
      stage: 'research',
    });

    const response = await POST(callbackRequest({
      event_id: 'evt-bad-approval',
      aries_run_id: record.aries_run_id,
      status: 'requires_approval',
      approval: {
        stage: 'publish',
        workflow_step_id: 'approve_stage_2',
        prompt: '',
      },
    }));

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      status: 'error',
      reason: 'missing_approval_payload',
    });
  });
});
