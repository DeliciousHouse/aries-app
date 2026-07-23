/**
 * AA-158 — granular token & timing telemetry.
 *
 * Pins the acceptance criteria that a cost/latency dashboard would silently get
 * wrong:
 *   - the payload carries company/user/task ids, the prompt/completion/total
 *     token vocabulary, model, start/end time and duration;
 *   - total_tokens is derived from the pair but NEVER partially (one known half
 *     plus an unknown half is unknown, not a half-total that understates spend);
 *   - emitting is asynchronous: the caller is not blocked on the DB, events
 *     batch into one multi-row INSERT, and a stalled DB drops bounded rather
 *     than growing unbounded or throwing;
 *   - a retried attempt is its own event with its own tokens and a 'retry'
 *     status, so retry spend is separable from settled spend.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  emitTaskExecution,
  normalizeTaskExecutionRow,
  recordTaskExecution,
  resetTaskExecutionBuffer,
  settleTaskExecutionBuffer,
  taskExecutionBufferStats,
  withTaskExecutionLog,
} from '@/backend/telemetry/task-execution-log';

const ON = { ARIES_TASK_TELEMETRY_ENABLED: '1' };
const OFF = {} as Record<string, string | undefined>;

type Captured = { sql: string; params: unknown[] };

function fakeDb() {
  const calls: Captured[] = [];
  return {
    calls,
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      return { rows: [] };
    },
  };
}

const COLUMNS = [
  'tenant_id',
  'user_id',
  'task_id',
  'execution_engine',
  'task_key',
  'status',
  'attempt_number',
  'error_code',
  'duration_ms',
  'cpu_ms',
  'model_requested',
  'model_reported',
  'target_profile',
  'external_run_id',
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
  'cost_cents',
  'started_at',
  'end_time',
] as const;

const COLUMN_COUNT = COLUMNS.length;

/** Read the Nth row out of a (possibly multi-row) INSERT's flat param list. */
function rowAt(captured: Captured, index = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  COLUMNS.forEach((name, i) => {
    out[name] = captured.params[index * COLUMN_COUNT + i];
  });
  return out;
}

test('the payload carries company, user, task, model, token and timing fields', () => {
  const started = new Date('2026-07-22T10:00:00.000Z');
  const ended = new Date('2026-07-22T10:00:12.500Z');
  const row = normalizeTaskExecutionRow({
    engine: 'AI_LLM',
    taskKey: 'marketing.stage.production',
    taskId: 'arun_abc',
    tenantId: 15,
    userId: 88,
    status: 'succeeded',
    modelRequested: 'gemini/gemini-3-flash-preview',
    modelReported: 'gpt-4o',
    promptTokens: 900,
    completionTokens: 100,
    startedAt: started,
    endTime: ended,
    durationMs: 12_500,
  });

  assert.equal(row.tenant_id, 15, 'company_id');
  assert.equal(row.user_id, 88);
  assert.equal(row.task_id, 'arun_abc');
  assert.equal(row.model_reported, 'gpt-4o');
  assert.equal(row.prompt_tokens, 900);
  assert.equal(row.completion_tokens, 100);
  assert.equal(row.total_tokens, 1000);
  assert.equal(row.started_at, started);
  assert.equal(row.end_time, ended);
  assert.equal(row.duration_ms, 12_500);
});

test('user_id is NULL for userless executions (cron, sidecars, callbacks)', () => {
  const row = normalizeTaskExecutionRow({
    engine: 'DETERMINISTIC_RULE',
    taskKey: 'marketing.draft_expiry_sweep',
    status: 'succeeded',
  });
  assert.equal(row.user_id, null);
  assert.equal(row.task_id, null);
});

test('an explicit gateway total wins over the derived sum', () => {
  const row = normalizeTaskExecutionRow({
    engine: 'AI_LLM',
    taskKey: 't',
    status: 'succeeded',
    promptTokens: 10,
    completionTokens: 20,
    // A gateway that bills differently (cached/reasoning tokens) is authoritative.
    totalTokens: 45,
  });
  assert.equal(row.total_tokens, 45);
});

test('a partially-known token pair yields an unknown total, never a half-sum', () => {
  const promptOnly = normalizeTaskExecutionRow({
    engine: 'AI_LLM',
    taskKey: 't',
    status: 'succeeded',
    promptTokens: 900,
  });
  assert.equal(promptOnly.prompt_tokens, 900);
  assert.equal(promptOnly.completion_tokens, null);
  // 900 would understate real spend and read as a complete number.
  assert.equal(promptOnly.total_tokens, null);
});

test('attempt_number defaults to 1 and rejects nonsense', () => {
  const base = { engine: 'AI_LLM', taskKey: 't', status: 'succeeded' } as const;
  assert.equal(normalizeTaskExecutionRow({ ...base }).attempt_number, 1);
  assert.equal(normalizeTaskExecutionRow({ ...base, attemptNumber: 3 }).attempt_number, 3);
  assert.equal(normalizeTaskExecutionRow({ ...base, attemptNumber: 0 }).attempt_number, 1);
  assert.equal(normalizeTaskExecutionRow({ ...base, attemptNumber: -2 }).attempt_number, 1);
});

test('a retry event keeps its own tokens and its reason', () => {
  const retry = normalizeTaskExecutionRow({
    engine: 'AI_LLM',
    taskKey: 'marketing.stage.production',
    taskId: 'arun_abc',
    status: 'retry',
    attemptNumber: 2,
    errorCode: 'hermes_gateway_timeout',
    promptTokens: 900,
    completionTokens: 0,
  });
  assert.equal(retry.status, 'retry');
  assert.equal(retry.attempt_number, 2);
  // A retry is a failed attempt that will be tried again — dropping the code
  // would lose WHY it is being retried.
  assert.equal(retry.error_code, 'hermes_gateway_timeout');
  // Tokens burned on the abandoned attempt are still real spend.
  assert.equal(retry.prompt_tokens, 900);
  assert.equal(retry.total_tokens, 900);
});

test('retry attempts and the settled attempt are separate rows sharing a task_id', async (t) => {
  t.after(() => resetTaskExecutionBuffer());
  resetTaskExecutionBuffer();
  const db = fakeDb();

  emitTaskExecution(
    { engine: 'AI_LLM', taskKey: 'k', taskId: 'task-1', status: 'retry', attemptNumber: 1, promptTokens: 500, completionTokens: 0 },
    { db, env: ON },
  );
  emitTaskExecution(
    { engine: 'AI_LLM', taskKey: 'k', taskId: 'task-1', status: 'succeeded', attemptNumber: 2, promptTokens: 500, completionTokens: 50 },
    { db, env: ON },
  );
  await settleTaskExecutionBuffer();

  const rows = db.calls.flatMap((c) => [rowAt(c, 0), ...(c.params.length > COLUMN_COUNT ? [rowAt(c, 1)] : [])]);
  assert.equal(rows.length, 2, 'one row per attempt');
  assert.deepEqual(rows.map((r) => r.status), ['retry', 'succeeded']);
  assert.deepEqual(rows.map((r) => r.attempt_number), [1, 2]);
  assert.ok(rows.every((r) => r.task_id === 'task-1'), 'attempts join on task_id');
  // Settled spend = 550; true spend including the abandoned attempt = 1050.
  assert.deepEqual(rows.map((r) => r.total_tokens), [500, 550]);
});

test('emitting does not block the caller on the database', async (t) => {
  t.after(() => resetTaskExecutionBuffer());
  resetTaskExecutionBuffer();

  const deferred: { release: () => void } = { release: () => {} };
  const gate = new Promise<void>((resolve) => {
    deferred.release = resolve;
  });
  let queries = 0;
  const slowDb = {
    query: async () => {
      queries++;
      await gate; // never resolves until the assertion below has run
      return { rows: [] };
    },
  };

  emitTaskExecution({ engine: 'AI_LLM', taskKey: 'k', status: 'succeeded' }, { db: slowDb, env: ON });

  // The emit returned synchronously; nothing has been written yet.
  assert.equal(queries, 0);
  assert.equal(taskExecutionBufferStats().pending, 1);

  deferred.release();
  await settleTaskExecutionBuffer();
});

test('a burst of events collapses into batched multi-row INSERTs', async (t) => {
  t.after(() => resetTaskExecutionBuffer());
  resetTaskExecutionBuffer();
  const db = fakeDb();

  for (let i = 0; i < 25; i++) {
    emitTaskExecution({ engine: 'LOCAL_EDGE', taskKey: `k${i}`, status: 'succeeded' }, { db, env: ON });
  }
  await settleTaskExecutionBuffer();

  assert.equal(db.calls.length, 1, '25 events => one INSERT, not 25 round-trips');
  assert.equal(db.calls[0].params.length, 25 * COLUMN_COUNT);
  assert.equal(taskExecutionBufferStats().pending, 0);
});

test('the buffer is bounded — sustained pressure drops events instead of memory', async (t) => {
  t.after(() => resetTaskExecutionBuffer());
  resetTaskExecutionBuffer();
  const db = fakeDb();

  // Emit far past the 500-event cap WITHOUT letting the flush run.
  for (let i = 0; i < 600; i++) {
    emitTaskExecution({ engine: 'LOCAL_EDGE', taskKey: 'flood', status: 'succeeded' }, { db, env: ON });
  }

  const stats = taskExecutionBufferStats();
  assert.ok(stats.pending <= 500, `buffer stays bounded (was ${stats.pending})`);
  assert.ok(stats.dropped >= 100, `overflow is counted, not silent (was ${stats.dropped})`);
  await settleTaskExecutionBuffer();
});

test('a flush failure drops events without throwing into the task path', async (t) => {
  t.after(() => resetTaskExecutionBuffer());
  resetTaskExecutionBuffer();
  const brokenDb = {
    query: async () => {
      throw new Error('pool exhausted');
    },
  };

  emitTaskExecution({ engine: 'AI_LLM', taskKey: 'k', status: 'succeeded' }, { db: brokenDb, env: ON });
  await settleTaskExecutionBuffer();

  assert.equal(taskExecutionBufferStats().pending, 0, 'a failed batch never wedges the buffer');
  assert.ok(taskExecutionBufferStats().dropped >= 1);
});

test('emit is a no-op when the flag is OFF', async (t) => {
  t.after(() => resetTaskExecutionBuffer());
  resetTaskExecutionBuffer();
  const db = fakeDb();

  emitTaskExecution({ engine: 'AI_LLM', taskKey: 'k', status: 'succeeded' }, { db, env: OFF });
  await settleTaskExecutionBuffer();

  assert.equal(db.calls.length, 0);
  assert.equal(taskExecutionBufferStats().pending, 0);
});

test('withTaskExecutionLog stamps start and end time around the work', async () => {
  const db = fakeDb();
  const before = Date.now();
  await withTaskExecutionLog(
    { engine: 'LOCAL_EDGE', taskKey: 'marketing.compose_reel_layer' },
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return 'done';
    },
    { db, env: ON },
  );
  const after = Date.now();

  const row = rowAt(db.calls[0]);
  const startedAt = row.started_at as Date;
  const endTime = row.end_time as Date;
  assert.ok(startedAt instanceof Date && endTime instanceof Date, 'both timestamps stamped');
  assert.ok(startedAt.getTime() >= before && endTime.getTime() <= after, 'bracketed by the call');
  assert.ok(endTime.getTime() >= startedAt.getTime(), 'end is not before start');
  assert.ok((row.duration_ms as number) >= 0);
});

test('recordTaskExecution still settles synchronously for callers holding a client', async () => {
  const db = fakeDb();
  const wrote = await recordTaskExecution(
    { engine: 'DETERMINISTIC_RULE', taskKey: 'insights.sweep_stranded_sync_runs', status: 'succeeded' },
    { db, env: ON },
  );
  // The awaited path is what lets a caller write on a client it is about to
  // release; only the emit path is fire-and-forget.
  assert.equal(wrote, true);
  assert.equal(db.calls.length, 1);
});
