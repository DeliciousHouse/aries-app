/**
 * AA-159 — task-execution engine classification.
 *
 * Covers the contracts an analyst's cost query depends on:
 *   - the engine vocabulary is exactly the three documented values;
 *   - zero-cost engines log a HARD 0 token/cost count, never NULL;
 *   - AI rows leave token/cost NULL ("not reported") rather than a fake 0, and
 *     carry the model routing hint;
 *   - model/routing columns never appear on a non-AI row;
 *   - the flag OFF path writes nothing and is a pure pass-through;
 *   - a telemetry failure never propagates into the measured task.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EXECUTION_ENGINES,
  normalizeTaskExecutionRow,
  recordTaskExecution,
  withTaskExecutionLog,
  type ExecutionEngine,
} from '@/backend/telemetry/task-execution-log';

const ON = { ARIES_TASK_TELEMETRY_ENABLED: '1' };
const OFF = {} as Record<string, string | undefined>;

type Captured = { sql: string; params: unknown[] };

function fakeDb(onQuery?: () => void) {
  const calls: Captured[] = [];
  return {
    calls,
    query: async (sql: string, params?: unknown[]) => {
      onQuery?.();
      calls.push({ sql, params: params ?? [] });
      return { rows: [] };
    },
  };
}

/** Column order of the INSERT, so params can be read by name in assertions. */
const COLUMNS = [
  'tenant_id',
  'execution_engine',
  'task_key',
  'status',
  'error_code',
  'duration_ms',
  'cpu_ms',
  'model_requested',
  'model_reported',
  'target_profile',
  'external_run_id',
  'input_tokens',
  'output_tokens',
  'cost_cents',
  'started_at',
] as const;

function paramsByColumn(captured: Captured): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  COLUMNS.forEach((name, i) => {
    out[name] = captured.params[i];
  });
  return out;
}

test('engine vocabulary is exactly the three documented values', () => {
  assert.deepEqual([...EXECUTION_ENGINES], ['AI_LLM', 'DETERMINISTIC_RULE', 'LOCAL_EDGE']);
});

test('zero-cost engines log hard zero tokens and cost, never NULL', () => {
  for (const engine of ['DETERMINISTIC_RULE', 'LOCAL_EDGE'] as ExecutionEngine[]) {
    const row = normalizeTaskExecutionRow({
      engine,
      taskKey: 'x.y',
      status: 'succeeded',
      // Even if a caller passes nothing, the zero-cost contract holds.
    });
    assert.equal(row.input_tokens, 0, `${engine} input_tokens`);
    assert.equal(row.output_tokens, 0, `${engine} output_tokens`);
    assert.equal(row.cost_cents, 0, `${engine} cost_cents`);
  }
});

test('non-AI rows never carry model routing columns', () => {
  const row = normalizeTaskExecutionRow({
    engine: 'LOCAL_EDGE',
    taskKey: 'creative.apply_brand_frame',
    status: 'succeeded',
    // A caller passing these by mistake must not pollute the analytics table.
    modelRequested: 'gpt-4o',
    modelReported: 'gpt-4o',
    targetProfile: 'aries-content-generator',
    externalRunId: 'run_123',
  });
  assert.equal(row.model_requested, null);
  assert.equal(row.model_reported, null);
  assert.equal(row.target_profile, null);
  assert.equal(row.external_run_id, null);
});

test('AI rows keep unreported usage NULL (not a fabricated zero) and record the requested model', () => {
  const row = normalizeTaskExecutionRow({
    engine: 'AI_LLM',
    taskKey: 'insights.classify_comments',
    status: 'succeeded',
    modelRequested: 'gemini/gemini-3-flash-preview',
  });
  assert.equal(row.model_requested, 'gemini/gemini-3-flash-preview');
  // Hermes does not report the resolved model or usage back to Aries today.
  assert.equal(row.model_reported, null);
  assert.equal(row.input_tokens, null);
  assert.equal(row.output_tokens, null);
  assert.equal(row.cost_cents, null);
});

test('AI rows persist gateway-reported usage when it is available', () => {
  const row = normalizeTaskExecutionRow({
    engine: 'AI_LLM',
    taskKey: 'insights.classify_comments',
    status: 'succeeded',
    modelRequested: 'gemini/gemini-3-flash-preview',
    modelReported: 'claude-3-5-sonnet',
    inputTokens: 1200,
    outputTokens: 340,
    costCents: 0.42,
  });
  assert.equal(row.model_reported, 'claude-3-5-sonnet');
  assert.equal(row.input_tokens, 1200);
  assert.equal(row.output_tokens, 340);
  assert.equal(row.cost_cents, 0.42);
});

test('a failed execution records a machine-readable error code; a success records none', () => {
  const failed = normalizeTaskExecutionRow({
    engine: 'AI_LLM',
    taskKey: 't',
    status: 'failed',
    errorCode: 'timeout',
  });
  assert.equal(failed.error_code, 'timeout');

  const unlabelled = normalizeTaskExecutionRow({ engine: 'AI_LLM', taskKey: 't', status: 'failed' });
  assert.equal(unlabelled.error_code, 'error');

  const ok = normalizeTaskExecutionRow({
    engine: 'AI_LLM',
    taskKey: 't',
    status: 'succeeded',
    errorCode: 'ignored',
  });
  assert.equal(ok.error_code, null);
});

test('tenant id normalizes to an integer column; system tasks stay NULL', () => {
  assert.equal(normalizeTaskExecutionRow({ engine: 'LOCAL_EDGE', taskKey: 't', status: 'succeeded', tenantId: '15' }).tenant_id, 15);
  assert.equal(normalizeTaskExecutionRow({ engine: 'LOCAL_EDGE', taskKey: 't', status: 'succeeded', tenantId: 15 }).tenant_id, 15);
  assert.equal(normalizeTaskExecutionRow({ engine: 'LOCAL_EDGE', taskKey: 't', status: 'succeeded' }).tenant_id, null);
  assert.equal(normalizeTaskExecutionRow({ engine: 'LOCAL_EDGE', taskKey: 't', status: 'succeeded', tenantId: 'not-a-number' }).tenant_id, null);
});

test('flag OFF writes nothing', async () => {
  const db = fakeDb();
  const wrote = await recordTaskExecution(
    { engine: 'AI_LLM', taskKey: 't', status: 'succeeded' },
    { db, env: OFF },
  );
  assert.equal(wrote, false);
  assert.equal(db.calls.length, 0);
});

test('flag ON writes exactly one row with the classified engine', async () => {
  const db = fakeDb();
  const wrote = await recordTaskExecution(
    {
      engine: 'AI_LLM',
      taskKey: 'insights.classify_comments',
      tenantId: 15,
      status: 'succeeded',
      modelRequested: 'gemini/gemini-3-flash-preview',
    },
    { db, env: ON },
  );
  assert.equal(wrote, true);
  assert.equal(db.calls.length, 1);
  const row = paramsByColumn(db.calls[0]);
  assert.match(db.calls[0].sql, /INSERT INTO task_execution_log/);
  assert.equal(row.execution_engine, 'AI_LLM');
  assert.equal(row.task_key, 'insights.classify_comments');
  assert.equal(row.tenant_id, 15);
  assert.equal(row.model_requested, 'gemini/gemini-3-flash-preview');
});

test('a telemetry write failure is swallowed — it never breaks the caller', async () => {
  const db = {
    query: async () => {
      throw new Error('relation "task_execution_log" does not exist');
    },
  };
  const wrote = await recordTaskExecution(
    { engine: 'LOCAL_EDGE', taskKey: 't', status: 'succeeded' },
    { db, env: ON },
  );
  assert.equal(wrote, false);
});

test('withTaskExecutionLog is a pass-through when the flag is OFF', async () => {
  const db = fakeDb();
  let ran = 0;
  const result = await withTaskExecutionLog(
    { engine: 'LOCAL_EDGE', taskKey: 'creative.apply_brand_frame' },
    async () => {
      ran++;
      return 'composited';
    },
    { db, env: OFF },
  );
  assert.equal(result, 'composited');
  assert.equal(ran, 1);
  assert.equal(db.calls.length, 0);
});

test('withTaskExecutionLog records a LOCAL_EDGE success with compute time and zero tokens', async () => {
  const db = fakeDb();
  const result = await withTaskExecutionLog(
    { engine: 'LOCAL_EDGE', taskKey: 'marketing.compose_reel_layer', tenantId: 7 },
    async () => {
      // Burn a little real CPU so cpu_ms is a measured value, not a constant.
      let acc = 0;
      for (let i = 0; i < 200_000; i++) acc += i % 7;
      return acc;
    },
    { db, env: ON },
  );
  assert.equal(typeof result, 'number');
  assert.equal(db.calls.length, 1);
  const row = paramsByColumn(db.calls[0]);
  assert.equal(row.execution_engine, 'LOCAL_EDGE');
  assert.equal(row.status, 'succeeded');
  assert.equal(row.input_tokens, 0);
  assert.equal(row.output_tokens, 0);
  assert.equal(row.cost_cents, 0);
  assert.equal(typeof row.duration_ms, 'number');
  assert.equal(typeof row.cpu_ms, 'number');
  assert.ok((row.cpu_ms as number) >= 0, 'cpu_ms is measured');
  assert.ok(row.started_at instanceof Date, 'started_at stamped');
});

test('withTaskExecutionLog records the failure and re-throws the original error', async () => {
  const db = fakeDb();
  const boom = Object.assign(new Error('ffmpeg exited 1'), { code: 'ffmpeg_failed' });
  await assert.rejects(
    withTaskExecutionLog(
      { engine: 'LOCAL_EDGE', taskKey: 'marketing.compose_reel_layer' },
      async () => {
        throw boom;
      },
      { db, env: ON },
    ),
    (err: unknown) => err === boom,
  );
  assert.equal(db.calls.length, 1);
  const row = paramsByColumn(db.calls[0]);
  assert.equal(row.status, 'failed');
  assert.equal(row.error_code, 'ffmpeg_failed');
});

test('a telemetry failure inside the wrapper still returns the task result', async () => {
  const db = {
    query: async () => {
      throw new Error('pool exhausted');
    },
  };
  const result = await withTaskExecutionLog(
    { engine: 'DETERMINISTIC_RULE', taskKey: 'marketing.draft_expiry_sweep' },
    async () => 'swept',
    { db, env: ON },
  );
  assert.equal(result, 'swept');
});
