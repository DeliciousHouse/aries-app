/**
 * Multi-workspace Phase 4 hardening — the bounded deadlock/serialization retry
 * (backend/tenant/txn-retry.ts, PR #764 follow-up). This is the UNIT-level
 * contract behind the flipped-to-graceful requires-infra concurrency sentinel
 * (tests/tenant/multi-workspace-phase2-concurrency.requires-infra.test.ts):
 * that file proves the retry recovers a real deadlock against live Postgres;
 * THIS file pins the pure retry semantics deterministically, without any DB, so
 * a regression in the wrapper (unbounded loop, retrying the wrong errors, or
 * masking a real bug) fails loudly in `npm run verify`.
 *
 * The load-bearing properties, each an explicit assertion:
 *   1. a deadlock (40P01) is retried and the eventual success is returned;
 *   2. a serialization_failure (40001) is likewise retried;
 *   3. the retry is BOUNDED — it never loops forever; after maxAttempts it
 *      re-throws the last deadlock instead of spinning (proven by counting the
 *      attempts on an operation that ALWAYS deadlocks);
 *   4. a NON-deadlock error (a genuine bug, e.g. a not-null violation or a plain
 *      Error) is NOT retried — it propagates on the FIRST attempt so a real bug
 *      is never masked or spun on;
 *   5. a first-try success runs the operation exactly once (no speculative
 *      retry).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { withDeadlockRetry } from '../../backend/tenant/txn-retry';

function deadlockError(code = '40P01'): Error & { code: string } {
  const err = new Error(`simulated ${code}`) as Error & { code: string };
  err.code = code;
  return err;
}

test('retries a 40P01 deadlock and returns the eventual success', async () => {
  let attempts = 0;
  const result = await withDeadlockRetry(
    async () => {
      attempts += 1;
      if (attempts < 3) throw deadlockError('40P01');
      return 'ok';
    },
    { baseBackoffMs: 0 },
  );
  assert.equal(result, 'ok');
  assert.equal(attempts, 3, 'the deadlock is retried until the operation succeeds');
});

test('retries a 40001 serialization_failure as well', async () => {
  let attempts = 0;
  const result = await withDeadlockRetry(
    async () => {
      attempts += 1;
      if (attempts < 2) throw deadlockError('40001');
      return 42;
    },
    { baseBackoffMs: 0 },
  );
  assert.equal(result, 42);
  assert.equal(attempts, 2);
});

test('the retry is BOUNDED — an operation that always deadlocks stops after maxAttempts and re-throws (never loops forever)', async () => {
  let attempts = 0;
  await assert.rejects(
    () =>
      withDeadlockRetry(
        async () => {
          attempts += 1;
          throw deadlockError('40P01');
        },
        { maxAttempts: 4, baseBackoffMs: 0 },
      ),
    /simulated 40P01/,
    'a permanently-deadlocking op re-throws the deadlock after the bounded budget',
  );
  assert.equal(attempts, 4, 'the operation is attempted exactly maxAttempts times — no infinite spin');
});

test('a NON-deadlock error is NOT retried — it propagates on the first attempt so a real bug is never masked', async () => {
  let attempts = 0;
  const notNull = new Error('null value in column "role" violates not-null constraint') as Error & {
    code: string;
  };
  notNull.code = '23502'; // not_null_violation — a genuine bug, NOT a safe race abort
  await assert.rejects(
    () =>
      withDeadlockRetry(
        async () => {
          attempts += 1;
          throw notNull;
        },
        { maxAttempts: 5, baseBackoffMs: 0 },
      ),
    /not-null constraint/,
  );
  assert.equal(attempts, 1, 'a non-retryable error is thrown immediately — never retried/spun');
});

test('a plain Error with no SQLSTATE code is NOT retried (a real bug propagates once)', async () => {
  let attempts = 0;
  await assert.rejects(
    () =>
      withDeadlockRetry(
        async () => {
          attempts += 1;
          throw new Error('some application bug');
        },
        { baseBackoffMs: 0 },
      ),
    /some application bug/,
  );
  assert.equal(attempts, 1, 'an error without a retryable SQLSTATE is not retried');
});

test('a first-try success runs the operation exactly once (no speculative retry)', async () => {
  let attempts = 0;
  const result = await withDeadlockRetry(async () => {
    attempts += 1;
    return 'immediate';
  });
  assert.equal(result, 'immediate');
  assert.equal(attempts, 1);
});

test('maxAttempts is clamped to at least 1 (a 0/negative budget still runs the op once)', async () => {
  let attempts = 0;
  const result = await withDeadlockRetry(
    async () => {
      attempts += 1;
      return 'once';
    },
    { maxAttempts: 0, baseBackoffMs: 0 },
  );
  assert.equal(result, 'once');
  assert.equal(attempts, 1, 'a non-positive maxAttempts is clamped up to a single attempt (never zero)');
});
