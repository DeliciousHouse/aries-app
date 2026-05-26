import assert from 'node:assert/strict';
import test from 'node:test';

import { processConcurrent } from '../lib/process-concurrent';

test('processConcurrent: preserves input order in output (replaces serial loops directly)', async () => {
  const items = ['a', 'b', 'c', 'd', 'e'];
  // Intentionally make first item slowest — output order MUST stay input order.
  const delays: Record<string, number> = { a: 50, b: 5, c: 5, d: 5, e: 5 };
  const results = await processConcurrent(items, async (x) => {
    await new Promise((r) => setTimeout(r, delays[x]));
    return `${x}!`;
  }, 3);
  assert.deepEqual(results, ['a!', 'b!', 'c!', 'd!', 'e!']);
});

test('processConcurrent: empty input returns empty array', async () => {
  const results = await processConcurrent([] as number[], async (x) => x * 2, 4);
  assert.deepEqual(results, []);
});

test('processConcurrent: concurrency=1 behaves identically to serial', async () => {
  const items = [1, 2, 3];
  const order: number[] = [];
  await processConcurrent(items, async (x) => {
    order.push(x);
    await new Promise((r) => setTimeout(r, 10));
    return x;
  }, 1);
  assert.deepEqual(order, [1, 2, 3], 'concurrency=1 must process in order');
});

test('processConcurrent: never exceeds the configured concurrency', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);
  await processConcurrent(items, async (x) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return x;
  }, 4);
  assert.ok(maxInFlight <= 4, `must respect concurrency cap, saw ${maxInFlight}`);
  assert.ok(maxInFlight >= 2, `must actually parallelize, only saw ${maxInFlight} in flight`);
});

test('processConcurrent: yields wall-clock speedup over serial', async () => {
  // 6 items × 50ms each. Serial would be ~300ms; concurrency=3 should be ~100ms.
  const items = [1, 2, 3, 4, 5, 6];
  const start = Date.now();
  await processConcurrent(items, async () => {
    await new Promise((r) => setTimeout(r, 50));
  }, 3);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 200, `must be faster than serial: elapsed=${elapsed}ms`);
});

test('processConcurrent: re-throws the first error after in-flight work settles', async () => {
  const items = [1, 2, 3, 4, 5];
  let settled = 0;
  await assert.rejects(
    processConcurrent(items, async (x) => {
      await new Promise((r) => setTimeout(r, 10));
      if (x === 2) throw new Error('boom');
      settled++;
    }, 2),
    /boom/,
  );
  // Other workers should have completed their slots — we're not guaranteeing
  // every item runs but we ARE guaranteeing the error doesn't leak unhandled.
  assert.ok(settled >= 1, 'at least one non-erroring item completed');
});

test('processConcurrent: handles concurrency > items.length gracefully (clamps to items.length)', async () => {
  const items = [1, 2];
  const results = await processConcurrent(items, async (x) => x * 10, 100);
  assert.deepEqual(results, [10, 20]);
});

test('processConcurrent: invalid concurrency (0, negative) clamps to 1 (serial)', async () => {
  const items = [1, 2, 3];
  const r0 = await processConcurrent(items, async (x) => x, 0);
  assert.deepEqual(r0, [1, 2, 3]);
  const rneg = await processConcurrent(items, async (x) => x, -5);
  assert.deepEqual(rneg, [1, 2, 3]);
});

test('processConcurrent: index argument matches item position', async () => {
  const items = ['a', 'b', 'c'];
  const results = await processConcurrent(items, async (item, i) => `${i}:${item}`, 2);
  assert.deepEqual(results, ['0:a', '1:b', '2:c']);
});
