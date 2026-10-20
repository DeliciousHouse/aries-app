import assert from 'node:assert/strict';
import test from 'node:test';
import { createDrainingWorker } from '../scripts/automations/worker-drain';

  test('protects active-cycle drain; fails_when pool closes early or new cycle starts; no_claim provider reconciliation', async () => {
    let finish!: () => void;
    let calls = 0;
    let closed = 0;
    const worker = createDrainingWorker(async () => {
      calls++;
      await new Promise<void>((resolve) => { finish = resolve; });
    }, async () => { closed++; });
    const active = worker.run();
    await Promise.resolve();
    await worker.run();
    const shutdown = worker.shutdown(1000);
    await worker.run();
    assert.equal(calls, 1);
    assert.equal(closed, 0);
    finish();
    await active;
    assert.equal(await shutdown, true);
    assert.equal(await worker.shutdown(1000), true);
    assert.equal(closed, 1);
    await worker.run();
    assert.equal(calls, 1);
  });

test('protects unknown timeout; fails_when active pool is closed; no_claim external cancellation', async () => {
  let closed = false;
  let finish!: () => void;
  const worker = createDrainingWorker(() => new Promise<void>((resolve) => { finish = resolve; }), async () => { closed = true; });
  const active = worker.run();
  await Promise.resolve();
  assert.equal(await worker.shutdown(5), false);
  assert.equal(closed, false);
  finish();
  await active;
  assert.equal(closed, false, 'late completion cannot resume a timed-out shutdown');
  assert.equal(await worker.shutdown(5), false);
});

test('protects admission cutoff; fails_when queued cycle starts after stop; no_claim host fence', async () => {
  let calls = 0;
  const worker = createDrainingWorker(async () => { calls++; }, async () => {});
  const queued = worker.run();
  await worker.shutdown(100);
  await queued;
  assert.equal(calls, 0);
});

test('protects failed cycle and pool-close errors; fails_when drain reports success; no_claim provider outcome', async () => {
  const worker = createDrainingWorker(async () => { throw new Error('cycle failed'); }, async () => {});
  await assert.rejects(worker.run(), /cycle failed/);
  assert.equal(await worker.shutdown(100), false);
  const closeFailure = createDrainingWorker(async () => {}, async () => { throw new Error('close failed'); });
  await assert.rejects(closeFailure.shutdown(100), /close failed/);
});
