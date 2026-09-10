import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { HermesExecutionAdapter } from '@/backend/execution/providers/hermes';
import pool from '@/lib/db';

type Insert = { sql: string; params: unknown[] };

const COLUMNS = [
  'tenant_id',
  'user_id',
  'task_id',
  'execution_engine',
  'task_key',
  'status',
  'attempt_number',
  'error_code',
  'error_class',
  'error_message',
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

function row(insert: Insert): Record<string, unknown> {
  return Object.fromEntries(COLUMNS.map((column, index) => [column, insert.params[index]]));
}

async function withHarness(
  t: { mock: { method: typeof import('node:test').mock.method } },
  body: (inserts: Insert[]) => Promise<void>,
): Promise<void> {
  const previousDataRoot = process.env.DATA_ROOT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-hermes-log-'));
  process.env.DATA_ROOT = dataRoot;
  const inserts: Insert[] = [];
  t.mock.method(pool, 'query', (async (sql: string, params: unknown[] = []) => {
    if (sql.includes('INSERT INTO task_execution_log')) inserts.push({ sql, params });
    return { rows: [], rowCount: 0 };
  }) as typeof pool.query);

  try {
    await body(inserts);
  } finally {
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

const ENV = {
  ARIES_TASK_TELEMETRY_ENABLED: '1',
  HERMES_GATEWAY_URL: 'http://hermes.test',
  HERMES_API_SERVER_KEY: 'test-key',
  HERMES_POLL_INTERVAL_MS: '0',
};

const NO_SLEEP = async () => {};

test('a successful Hermes invocation writes one execution row', async (t) => {
  await withHarness(t, async (inserts) => {
    let calls = 0;
    const adapter = new HermesExecutionAdapter(
      ENV,
      async () => {
        calls += 1;
        if (calls === 1) return Response.json({ run_id: 'run_success' }, { status: 202 });
        return Response.json({
          run_id: 'run_success',
          status: 'completed',
          output: JSON.stringify({ status: 'ok', output: [{ ok: true }] }),
        });
      },
      NO_SLEEP,
    );

    const result = await adapter.runWorkflow('demo_start', { tenantId: 42 });

    assert.equal(result.kind, 'ok');
    assert.equal(inserts.length, 1);
    const logged = row(inserts[0]);
    assert.equal(logged.execution_engine, 'AI_LLM');
    assert.equal(logged.task_key, 'execution.demo_start');
    assert.equal(logged.tenant_id, 42);
    assert.equal(logged.status, 'succeeded');
    assert.equal(logged.external_run_id, 'run_success');
    assert.equal(logged.cost_cents, null, 'unknown estimated cost stays NULL, never fake zero');
  });
});

test('an ENOENT Hermes invocation failure writes a row before returning the unchanged error', async (t) => {
  await withHarness(t, async (inserts) => {
    const missingEngine = Object.assign(new Error('spawn hermes-engine ENOENT'), { code: 'ENOENT' });
    const adapter = new HermesExecutionAdapter(
      ENV,
      async () => {
        throw missingEngine;
      },
      NO_SLEEP,
    );

    const result = await adapter.runWorkflow('demo_start', { tenantId: 42 });

    assert.equal(result.kind, 'gateway_error');
    if (result.kind !== 'gateway_error') assert.fail('expected gateway_error');
    assert.equal(result.error.code, 'unreachable');
    assert.equal(result.error.cause, missingEngine, 'existing error behavior is unchanged');
    assert.equal(inserts.length, 1, 'failure is persisted before runWorkflow resolves');
    const logged = row(inserts[0]);
    assert.equal(logged.status, 'failed');
    assert.equal(logged.error_code, 'ENOENT');
    assert.equal(logged.error_class, 'Error');
    assert.equal(logged.error_message, 'spawn hermes-engine ENOENT');
  });
});
