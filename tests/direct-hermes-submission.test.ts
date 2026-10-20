import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { submitDirectHermesRun } from '../backend/execution/direct-hermes-submission';
import { createExecutionRunRecord, listExecutionRunRecords } from '../backend/execution/run-store';

async function isolated(fn: () => Promise<void>) {
  const previous = process.env.DATA_ROOT;
  process.env.DATA_ROOT = await mkdtemp(path.join(tmpdir(), 'aries-direct-'));
  try { await fn(); } finally {
    await rm(process.env.DATA_ROOT, { recursive: true, force: true });
    if (previous === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previous;
  }
}

test('protects direct original identity; fails_when lost response replayed; no_claim native scope or provider delivery', async () => {
  await isolated(async () => {
    let posts = 0;
    const run = createExecutionRunRecord({ provider: 'hermes', domain: 'route', workflowKey: 'test.direct', tenantId: 'fixture', action: 'run' });
    const input = { ariesRunId: run.aries_run_id, workflowKey: 'test.direct', tenantId: 'fixture', gatewayUrl: 'http://127.0.0.1:1',
      authorization: 'Bearer fixture', body: JSON.stringify({ input: 'test' }),
      fetchImpl: async (_url: string | URL, init?: RequestInit): Promise<Response> => {
        posts++;
        const saved = listExecutionRunRecords({ strict: true });
        assert.equal(saved.length, 1);
        assert.equal(saved[0].submission?.state, 'unknown');
        assert.equal(saved[0].submission?.idempotency_key, new Headers(init?.headers).get('idempotency-key'));
        assert.equal(saved[0].submission?.request_sha256, createHash('sha256').update(String(init?.body)).digest('hex'));
        throw new Error('lost response');
      } };
    await assert.rejects(submitDirectHermesRun(input), /lost response/);
    await assert.rejects(submitDirectHermesRun(input), /reconciliation required/);
    await assert.rejects(submitDirectHermesRun({ ...input, authorization: 'Bearer rotated-fixture' }), /reconciliation required/);
    assert.equal(posts, 1);
  });
});

test('protects accepted direct ID reuse and tenant separation; fails_when second POST sent; no_claim effect acceptance', async () => {
  await isolated(async () => {
    let posts = 0;
    const run = createExecutionRunRecord({ provider: 'hermes', domain: 'route', workflowKey: 'test.direct', tenantId: 'fixture', action: 'run' });
    const input = { ariesRunId: run.aries_run_id, workflowKey: 'test.direct', tenantId: 'fixture', gatewayUrl: 'http://127.0.0.1:1',
      authorization: 'Bearer fixture', body: JSON.stringify({ input: 'test' }),
      fetchImpl: async () => { posts++; return Response.json({ run_id: `native-${posts}` }); } };
    assert.deepEqual(await submitDirectHermesRun(input), { ok: true, runId: 'native-1' });
    assert.deepEqual(await submitDirectHermesRun(input), { ok: true, runId: 'native-1' });
    await assert.rejects(submitDirectHermesRun({ ...input, tenantId: 'other' }), /binding unavailable/);
    assert.deepEqual(await submitDirectHermesRun({ ...input, ariesRunId: undefined, tenantId: 'other' }), { ok: true, runId: 'native-2' });
    assert.equal(posts, 2);
    assert.ok(listExecutionRunRecords({ strict: true }).every((run) => run.status === 'submitted'));
  });
});
