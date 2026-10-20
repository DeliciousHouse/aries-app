import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import pool from '../lib/db';
import { HermesMarketingPort } from '../backend/marketing/ports/hermes';
import * as store from '../backend/execution/run-store';
import { handleHermesRunCallback } from '../backend/execution/hermes-callbacks';

async function isolated(fn: () => Promise<void>) {
  const previous = process.env.DATA_ROOT;
  process.env.DATA_ROOT = await mkdtemp(path.join(tmpdir(), 'aries-receipts-'));
  try { await fn(); } finally {
    await rm(process.env.DATA_ROOT, { recursive: true, force: true });
    if (previous === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previous;
  }
}

const create = () => store.createExecutionRunRecord({ provider: 'hermes', domain: 'route', workflowKey: 'demo', action: 'run' });

test('protects lost HTTP reply and original wire identity; fails_when POST replayed; no_claim native authority', async (t) => {
  await isolated(async () => {
    t.mock.method(pool, 'query', async () => ({ rows: [], rowCount: 0 }));
    const run = create();
    let received = 0;
    const server = createServer(async (req) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      const saved = store.loadExecutionRunRecord(run.aries_run_id)!;
      assert.equal(saved.submission?.state, 'unknown');
      assert.equal(saved.submission?.idempotency_key, 'original arbitrary key');
      assert.equal(saved.submission?.request_sha256, createHash('sha256').update(body).digest('hex'));
      received++;
      req.socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    try {
      const port = new HermesMarketingPort({ HERMES_GATEWAY_URL: `http://127.0.0.1:${address.port}`,
        HERMES_API_SERVER_KEY: 'local-test', INTERNAL_API_SECRET: 'local-test',
        APP_BASE_URL: 'https://aries.example.com', HERMES_POLL_BRIDGE_ENABLED: '0' });
      const input = { ariesRunId: run.aries_run_id, tenantId: 'test', workflowKey: 'demo',
        stage: 'research' as const, payload: { idempotency_key: 'original arbitrary key', input: 'isolated test' }, callbackToken: 'test-token' };
      await assert.rejects(port.submitRawRun(input), /hermes_gateway_unreachable/);
      assert.equal(store.loadExecutionRunRecord(run.aries_run_id)?.status, 'submitted');
      await assert.rejects(port.submitRawRun(input), /already dispatched/);
      assert.equal(received, 1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

test('protects persistence fault boundaries; fails_when callback replays after effects; no_claim power-loss recovery', async (t) => {
  await isolated(async () => {
    const run = create();
    store.markExecutionRunSubmitted(run.aries_run_id, { externalRunId: 'native-1' });
    const original = fs.renameSync;
    let writes = 0;
    // pending, applying, event marker, final unknown receipt: refuse the fourth
    // rename, after actual route-domain effects but before final receipt.
    const fault = t.mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
      if (++writes === 4) throw new Error('injected persistence failure');
      return original(...args);
    });
    const payload = { aries_run_id: run.aries_run_id, hermes_run_id: 'native-1', event_id: 'event', status: 'completed' as const };
    await assert.rejects(handleHermesRunCallback(payload), /injected persistence failure/);
    fault.mock.restore();
    assert.equal(store.loadExecutionRunRecord(run.aries_run_id)?.callback_receipts?.[0].state, 'applying');
    assert.deepEqual(await handleHermesRunCallback(payload), { status: 'error', reason: 'callback_outcome_unknown' });
    assert.deepEqual(store.loadExecutionRunRecord(run.aries_run_id)?.event_ids, ['event']);
    assert.throws(() => store.listExecutionRunRecords({ strict: true }), /interrupted or active writes/);
  });
});

test('protects original submission identity; fails_when redispatched; no_claim native acceptance', async () => {
  await isolated(async () => {
    const run = create();
    const identity = { idempotency_key: 'original-key', request_sha256: 'a'.repeat(64), gateway_scope_sha256: 'b'.repeat(64), target_profile: null };
    store.prepareExecutionRunSubmission(run.aries_run_id, identity);
    assert.deepEqual(store.loadExecutionRunRecord(run.aries_run_id)?.submission, { ...identity, state: 'unknown' });
    assert.throws(() => store.prepareExecutionRunSubmission(run.aries_run_id, identity), /already dispatched/);
    store.markExecutionRunFailed(run.aries_run_id, { code: 'lost_reply', message: 'unknown' });
    assert.equal(store.loadExecutionRunRecord(run.aries_run_id)?.status, 'submitted');
    store.markExecutionRunSubmitted(run.aries_run_id, { externalRunId: 'native-1' });
    assert.equal(store.loadExecutionRunRecord(run.aries_run_id)?.submission?.state, 'accepted');
    assert.throws(() => store.markExecutionRunSubmitted(run.aries_run_id, { externalRunId: 'native-2' }), /binding conflict/);
    const legacy = create();
    delete legacy.submission;
    store.saveExecutionRunRecord(legacy);
    assert.throws(() => store.prepareExecutionRunSubmission(legacy.aries_run_id, identity), /already dispatched/);
    assert.equal(store.loadExecutionRunRecord(legacy.aries_run_id)?.submission, undefined);
  });
});

test('protects callback identity across transports; fails_when conflicting duplicate accepted; no_claim effect delivery', async () => {
  await isolated(async () => {
    const run = create();
    store.markExecutionRunSubmitted(run.aries_run_id, { externalRunId: 'native-1' });
    const payload = { aries_run_id: run.aries_run_id, hermes_run_id: 'native-1', event_id: 'http-1', status: 'completed' as const, output: { ok: true } };
    assert.equal((await handleHermesRunCallback(payload)).status, 'accepted');
    const receipts = store.loadExecutionRunRecord(run.aries_run_id)!.callback_receipts!;
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].state, 'unknown');
    assert.deepEqual(await handleHermesRunCallback({ ...payload, event_id: 'bridge-1' }), { status: 'error', reason: 'callback_outcome_unknown' });
    assert.deepEqual(await handleHermesRunCallback({ ...payload, output: { ok: false } }), { status: 'error', reason: 'callback_identity_conflict' });
    assert.equal(store.loadExecutionRunRecord(run.aries_run_id)!.callback_receipts!.length, 2);
  });
});

test('protects crash and late callbacks; fails_when applying replayed; no_claim recovery or provider acceptance', async () => {
  await isolated(async () => {
    const run = create();
    store.markExecutionRunSubmitted(run.aries_run_id, { externalRunId: 'native-1' });
    const payload = { aries_run_id: run.aries_run_id, hermes_run_id: 'native-1', event_id: 'event', status: 'completed' as const };
    await handleHermesRunCallback(payload);
    const saved = store.loadExecutionRunRecord(run.aries_run_id)!;
    saved.event_ids = [];
    saved.callback_receipts![0].state = 'applying';
    store.saveExecutionRunRecord(saved);
    assert.deepEqual(await handleHermesRunCallback(payload), { status: 'error', reason: 'callback_outcome_unknown' });
    assert.equal(store.loadExecutionRunRecord(run.aries_run_id)!.callback_receipts![0].state, 'unknown');
    const late = create();
    store.markExecutionRunFailed(late.aries_run_id, { code: 'old_failure', message: 'old' });
    assert.deepEqual(await handleHermesRunCallback({ ...payload, aries_run_id: late.aries_run_id }), { status: 'error', reason: 'callback_terminal_outcome_unknown' });
    assert.equal(store.loadExecutionRunRecord(late.aries_run_id)!.callback_receipts![0].state, 'unknown');
  });
});
