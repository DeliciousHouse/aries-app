/**
 * AA-159 — the Hermes callback path logs AI_LLM executions.
 *
 * Callback-driven runs converge through the run store; raw submit/poll callers
 * log at their terminal boundary. The contracts pinned here are the ones a cost
 * query would silently get wrong:
 *   - exactly ONE row per finished run, on TERMINAL deliveries only (a
 *     'running' progress ping is not a finished execution);
 *   - a reconciler/duplicate re-delivery never double-writes;
 *   - a failed run is logged as failed, not dropped;
 *   - flag OFF writes nothing.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import pool from '../../lib/db';
import { settleTaskExecutionBuffer } from '../../backend/telemetry/task-execution-log';

type Insert = { sql: string; params: unknown[] };

/**
 * Runs `body` with an isolated DATA_ROOT and pool.query stubbed, returning every
 * task_execution_log INSERT that was attempted.
 */
async function withCallbackHarness(
  t: { mock: { method: typeof import('node:test').mock.method } },
  telemetry: '1' | 'off',
  body: (ctx: { inserts: Insert[] }) => Promise<void>,
): Promise<void> {
  const previousDataRoot = process.env.DATA_ROOT;
  const previousFlag = process.env.ARIES_TASK_TELEMETRY_ENABLED;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-aa159-callback-'));
  process.env.DATA_ROOT = dataRoot;
  if (telemetry === '1') process.env.ARIES_TASK_TELEMETRY_ENABLED = '1';
  else delete process.env.ARIES_TASK_TELEMETRY_ENABLED;

  const inserts: Insert[] = [];
  t.mock.method(pool, 'query', (async (sql: string, params: unknown[] = []) => {
    if (String(sql).includes('INSERT INTO task_execution_log')) {
      inserts.push({ sql: String(sql), params });
    }
    return { rows: [], rowCount: 0 };
  }) as typeof pool.query);

  const { resetTaskExecutionBuffer } = await import('../../backend/telemetry/task-execution-log');
  resetTaskExecutionBuffer();

  try {
    await body({ inserts });
  } finally {
    resetTaskExecutionBuffer();
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    if (previousFlag === undefined) delete process.env.ARIES_TASK_TELEMETRY_ENABLED;
    else process.env.ARIES_TASK_TELEMETRY_ENABLED = previousFlag;
    await rm(dataRoot, { recursive: true, force: true });
  }
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

function row(insert: Insert): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  COLUMNS.forEach((name, i) => {
    out[name] = insert.params[i];
  });
  return out;
}

test('a terminal Hermes callback logs exactly one AI_LLM execution', async (t) => {
  await withCallbackHarness(t, '1', async ({ inserts }) => {
    const { createExecutionRunRecord } = await import('../../backend/execution/run-store');
    const { handleHermesRunCallback } = await import('../../backend/execution/hermes-callbacks');

    const record = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'route',
      workflowKey: 'demo_start',
      action: 'run',
      tenantId: '42',
    });

    const result = await handleHermesRunCallback({
      event_id: 'evt-terminal',
      aries_run_id: record.aries_run_id,
      hermes_run_id: 'hermes-run-1',
      status: 'completed',
      output: [{ ok: true }],
    } as never);

    assert.equal(result.status, 'accepted');
    await settleTaskExecutionBuffer();
    assert.equal(inserts.length, 1, 'one execution row');
    const logged = row(inserts[0]);
    assert.equal(logged.execution_engine, 'AI_LLM');
    assert.equal(logged.task_key, 'execution.demo_start');
    assert.equal(logged.status, 'succeeded');
    assert.equal(logged.tenant_id, 42);
    assert.equal(logged.external_run_id, 'hermes-run-1');
    assert.equal(typeof logged.duration_ms, 'number');
    // Hermes reports neither the resolved model nor usage — NULL, not a zero.
    assert.equal(logged.model_reported, null);
    assert.equal(logged.prompt_tokens, null);
    assert.equal(logged.cost_cents, null);
  });
});

test('a marketing stage run is keyed by its stage', async (t) => {
  await withCallbackHarness(t, '1', async ({ inserts }) => {
    const { createExecutionRunRecord } = await import('../../backend/execution/run-store');
    const { handleHermesRunCallback } = await import('../../backend/execution/hermes-callbacks');

    const record = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'marketing',
      workflowKey: 'marketing_pipeline',
      action: 'run',
      tenantId: '7',
      // No marketing_job_id, so the marketing callback body is an early no-op —
      // this test is about the execution-log seam, not stage advancement.
      stage: 'production',
    });

    await handleHermesRunCallback({
      event_id: 'evt-stage',
      aries_run_id: record.aries_run_id,
      hermes_run_id: 'hermes-run-2',
      status: 'completed',
      output: [{ ok: true }],
    } as never);

    await settleTaskExecutionBuffer();
    assert.equal(inserts.length, 1);
    assert.equal(row(inserts[0]).task_key, 'marketing.stage.production');
  });
});

test('reported Hermes tokens produce a clearly calibrated cost estimate', async (t) => {
  await withCallbackHarness(t, '1', async ({ inserts }) => {
    const { createExecutionRunRecord } = await import('../../backend/execution/run-store');
    const { handleHermesRunCallback } = await import('../../backend/execution/hermes-callbacks');
    const record = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'route',
      workflowKey: 'estimated_cost_demo',
      action: 'run',
      tenantId: '15',
    });

    await handleHermesRunCallback({
      event_id: 'evt-estimated-cost',
      aries_run_id: record.aries_run_id,
      hermes_run_id: 'hermes-cost-1',
      status: 'completed',
      output: [{ ok: true }],
      usage: {
        model: 'example/model',
        prompt_tokens: 800_000,
        completion_tokens: 200_000,
        total_tokens: 1_000_000,
      },
    } as never);

    await settleTaskExecutionBuffer();
    assert.equal(inserts.length, 1);
    assert.equal(row(inserts[0]).cost_cents, 250, 'default estimate is $2.50 per million reported tokens');
  });
});

test('a non-terminal progress callback logs nothing', async (t) => {
  await withCallbackHarness(t, '1', async ({ inserts }) => {
    const { createExecutionRunRecord } = await import('../../backend/execution/run-store');
    const { handleHermesRunCallback } = await import('../../backend/execution/hermes-callbacks');

    const record = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'route',
      workflowKey: 'demo_start',
      action: 'run',
      tenantId: '42',
    });

    await handleHermesRunCallback({
      event_id: 'evt-running',
      aries_run_id: record.aries_run_id,
      hermes_run_id: 'hermes-run-3',
      status: 'running',
    } as never);

    await settleTaskExecutionBuffer();
    assert.equal(inserts.length, 0, 'a progress ping is not a finished execution');
  });
});

test('a duplicate re-delivery does not double-count the execution', async (t) => {
  await withCallbackHarness(t, '1', async ({ inserts }) => {
    const { createExecutionRunRecord } = await import('../../backend/execution/run-store');
    const { handleHermesRunCallback } = await import('../../backend/execution/hermes-callbacks');

    const record = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'route',
      workflowKey: 'demo_start',
      action: 'run',
      tenantId: '42',
    });

    const payload = {
      event_id: 'reconcile-hermes-run-4',
      aries_run_id: record.aries_run_id,
      hermes_run_id: 'hermes-run-4',
      status: 'completed',
      output: [{ ok: true }],
    };

    const first = await handleHermesRunCallback(payload as never);
    const second = await handleHermesRunCallback(payload as never);

    assert.equal(first.status === 'accepted' && first.duplicate, false);
    assert.equal(second.status === 'accepted' && second.duplicate, true);
    await settleTaskExecutionBuffer();
    assert.equal(inserts.length, 1, 'reconciler re-delivery must not re-log');
  });
});

test('a failed run is logged as a failed execution with its error code', async (t) => {
  await withCallbackHarness(t, '1', async ({ inserts }) => {
    const { createExecutionRunRecord } = await import('../../backend/execution/run-store');
    const { handleHermesRunCallback } = await import('../../backend/execution/hermes-callbacks');

    const record = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'route',
      workflowKey: 'demo_start',
      action: 'run',
      tenantId: '42',
    });

    await handleHermesRunCallback({
      event_id: 'evt-failed',
      aries_run_id: record.aries_run_id,
      hermes_run_id: 'hermes-run-5',
      status: 'failed',
      error: { code: 'hermes_gateway_timeout', message: 'timed out', retryable: true },
    } as never);

    await settleTaskExecutionBuffer();
    assert.equal(inserts.length, 1);
    const logged = row(inserts[0]);
    assert.equal(logged.status, 'failed');
    assert.equal(logged.error_code, 'hermes_gateway_timeout');
  });
});

test('a pre-callback Hermes launch failure logs ENOENT exactly once', async (t) => {
  await withCallbackHarness(t, '1', async ({ inserts }) => {
    const { HermesExecutionAdapter } = await import('../../backend/execution/providers/hermes');
    const missingBinary = Object.assign(new Error('spawn hermes ENOENT'), { code: 'ENOENT' });
    const adapter = new HermesExecutionAdapter(
      {
        HERMES_GATEWAY_URL: 'https://hermes.example.com',
        HERMES_API_SERVER_KEY: 'test-key',
      },
      async () => { throw missingBinary; },
      async () => {},
    );
    const result = await adapter.runWorkflow('calendar_sync', { tenant_id: 15 });
    assert.equal(result.kind, 'gateway_error');

    await settleTaskExecutionBuffer();
    assert.equal(inserts.length, 1);
    const logged = row(inserts[0]);
    assert.equal(logged.execution_engine, 'AI_LLM');
    assert.equal(logged.status, 'failed');
    assert.equal(logged.error_code, 'ENOENT');
    assert.equal(logged.tenant_id, 15);
  });
});

test('raw posting-time Hermes research logs its terminal execution', async (t) => {
  await withCallbackHarness(t, '1', async ({ inserts }) => {
    const { deriveCompetitorPostingTimes } = await import('../../backend/marketing/posting-time-advisor');
    const fetchImpl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ run_id: 'posting-time-run-1' }), { status: 200 });
      }
      assert.match(String(url), /posting-time-run-1$/);
      return new Response(JSON.stringify({
        status: 'completed',
        output: JSON.stringify({
          status: 'ok',
          output: [{ platform: 'instagram', hour: 9, minute: 0, days: [2], rationale: 'Observed.' }],
        }),
      }), { status: 200 });
    };

    const result = await deriveCompetitorPostingTimes({
      tenantId: 15,
      competitorUrl: 'https://competitor.example.com',
      timezone: 'America/Los_Angeles',
      platforms: ['instagram'],
      env: {
        HERMES_GATEWAY_URL: 'https://hermes.example.com',
        HERMES_API_SERVER_KEY: 'test-key',
      },
      fetchImpl,
      sleep: async () => {},
    });

    assert.equal(result.ok, true);
    await settleTaskExecutionBuffer();
    assert.equal(inserts.length, 1);
    const logged = row(inserts[0]);
    assert.equal(logged.task_key, 'marketing.posting_time_research');
    assert.equal(logged.tenant_id, 15);
    assert.equal(logged.external_run_id, 'posting-time-run-1');
    assert.equal(logged.status, 'succeeded');
  });
});

test('raw brand-kit Hermes enrichment logs its terminal execution', async (t) => {
  await withCallbackHarness(t, '1', async ({ inserts }) => {
    const { enrichBrandKitWithGemini } = await import('../../backend/marketing/brand-kit-enrich');
    const responses = [
      new Response('<html><body>Brand copy</body></html>', { status: 200 }),
      new Response(JSON.stringify({ run_id: 'brand-run-1' }), { status: 200 }),
      new Response(JSON.stringify({
        status: 'completed',
        output: JSON.stringify({ output: [{ brandVoiceSummary: 'Warm and direct.' }] }),
      }), { status: 200 }),
    ];
    const result = await enrichBrandKitWithGemini({
      tenantId: 15,
      brandUrl: 'https://brand.example.com',
      scrapedBrandKit: { brand_name: 'Brand' },
      env: {
        ARIES_BRAND_ENRICHMENT_ENABLED: '1',
        HERMES_GATEWAY_URL: 'https://hermes.example.com',
        HERMES_API_SERVER_KEY: 'test-key',
        HERMES_POLL_INTERVAL_MS: '0',
      },
      fetchImpl: async () => responses.shift()!,
      sleep: async () => {},
    } as never);

    assert.equal(result.ok, true);
    await settleTaskExecutionBuffer();
    assert.equal(inserts.length, 1);
    const logged = row(inserts[0]);
    assert.equal(logged.task_key, 'marketing.brand_kit_enrichment');
    assert.equal(logged.tenant_id, 15);
    assert.equal(logged.external_run_id, 'brand-run-1');
    assert.equal(logged.status, 'succeeded');
  });
});

test('raw feedback-severity Hermes failure is logged before heuristic fallback', async (t) => {
  await withCallbackHarness(t, '1', async ({ inserts }) => {
    const { classifySeverity } = await import('../../lib/feedback/severity-classifier');
    const result = await classifySeverity(
      { comment: 'cannot log in', category: 'Login issue', tenantId: 15, taskId: 'feedback-1' } as never,
      { gatewayUrl: 'https://hermes.example.com', apiKey: 'test-key', sessionKey: 'feedback', timeoutMs: 100 },
      {
        fetchImpl: async () => { throw new Error('spawn hermes ENOENT'); },
        sleep: async () => {},
        nowMs: () => 0,
      },
    );

    assert.equal(result.source, 'heuristic');
    await settleTaskExecutionBuffer();
    assert.equal(inserts.length, 1);
    const logged = row(inserts[0]);
    assert.equal(logged.task_key, 'feedback.classify_severity');
    assert.equal(logged.tenant_id, 15);
    assert.equal(logged.task_id, 'feedback-1');
    assert.equal(logged.status, 'failed');
  });
});

test('raw workflow adapter polling logs a completed Hermes execution', async (t) => {
  await withCallbackHarness(t, '1', async ({ inserts }) => {
    const { HermesExecutionAdapter } = await import('../../backend/execution/providers/hermes');
    const responses = [
      new Response(JSON.stringify({ run_id: 'workflow-run-1' }), { status: 202 }),
      new Response(JSON.stringify({
        status: 'completed',
        output: JSON.stringify({ status: 'ok', output: [{ synced: true }] }),
      }), { status: 200 }),
    ];
    const adapter = new HermesExecutionAdapter(
      {
        HERMES_GATEWAY_URL: 'https://hermes.example.com',
        HERMES_API_SERVER_KEY: 'test-key',
        HERMES_POLL_INTERVAL_MS: '0',
      },
      async () => responses.shift()!,
      async () => {},
    );

    const result = await adapter.runWorkflow('calendar_sync', { tenant_id: 15 });
    assert.equal(result.kind, 'ok');
    await settleTaskExecutionBuffer();
    assert.equal(inserts.length, 1);
    const logged = row(inserts[0]);
    assert.equal(logged.task_key, 'execution.calendar_sync');
    assert.equal(logged.tenant_id, 15);
    assert.equal(logged.external_run_id, 'workflow-run-1');
    assert.equal(logged.status, 'succeeded');
  });
});

test('flag OFF logs nothing on the callback path', async (t) => {
  await withCallbackHarness(t, 'off', async ({ inserts }) => {
    const { createExecutionRunRecord } = await import('../../backend/execution/run-store');
    const { handleHermesRunCallback } = await import('../../backend/execution/hermes-callbacks');

    const record = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'route',
      workflowKey: 'demo_start',
      action: 'run',
      tenantId: '42',
    });

    const result = await handleHermesRunCallback({
      event_id: 'evt-off',
      aries_run_id: record.aries_run_id,
      hermes_run_id: 'hermes-run-6',
      status: 'completed',
      output: [{ ok: true }],
    } as never);

    assert.equal(result.status, 'accepted');
    await settleTaskExecutionBuffer();
    assert.equal(inserts.length, 0);
  });
});
