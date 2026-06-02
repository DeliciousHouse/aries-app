/**
 * Oracle tests for the durable Hermes run reconciler — the standing-process
 * replacement for the in-process poll-bridge that stalled every marketing job
 * in prod (no success 2026-05-27 → fix).
 *
 * Two layers are covered:
 *  - runHermesReconciler (sweep): candidate filtering, outcome accounting,
 *    sequential error isolation, age gate. Uses an injected fake port + records,
 *    so no Hermes/DB.
 *  - HermesMarketingPort.reconcileExecutionRun (per-run): skip guards, the
 *    single-poll pending/transient classification, per-profile gateway routing,
 *    and the DETERMINISTIC event_id (reconcile-<hermesRunId>) that makes repeated
 *    passes idempotent. Uses a real run-store (temp DATA_ROOT) + fake fetch.
 */
import assert from 'node:assert/strict';
import { closeSync, openSync, utimesSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { ExecutionRunRecord } from '../backend/execution/run-store';
import type { ReconcileRunOutcome } from '../backend/marketing/ports/hermes';

async function withDataRoot<T>(run: (dataRoot: string) => Promise<T>): Promise<T> {
  const previousDataRoot = process.env.DATA_ROOT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-hermes-reconciler-'));
  process.env.DATA_ROOT = dataRoot;
  try {
    return await run(dataRoot);
  } finally {
    if (previousDataRoot === undefined) {
      delete process.env.DATA_ROOT;
    } else {
      process.env.DATA_ROOT = previousDataRoot;
    }
    await rm(dataRoot, { recursive: true, force: true });
  }
}

function makeRecord(partial: Partial<ExecutionRunRecord> & { aries_run_id: string }): ExecutionRunRecord {
  return {
    schema_name: 'aries_execution_run',
    schema_version: '1.0.0',
    provider: 'hermes',
    domain: 'marketing',
    workflow_key: 'marketing_pipeline',
    action: 'run',
    tenant_id: 'tenant-1',
    marketing_job_id: 'job-1',
    approval_id: null,
    stage: 'research',
    workflow_step_id: null,
    external_run_id: 'hrun-1',
    status: 'running',
    event_ids: [],
    created_at: '2020-01-01T00:00:00.000Z',
    updated_at: '2020-01-01T00:00:00.000Z',
    last_error: null,
    result: null,
    ...partial,
  };
}

const HERMES_ENV = {
  HERMES_GATEWAY_URL: 'http://hermes-default.test',
  HERMES_API_SERVER_KEY: 'default-key',
  HERMES_CONTENT_GATEWAY_URL: 'http://hermes-content.test',
  HERMES_CONTENT_API_SERVER_KEY: 'content-key',
  INTERNAL_API_SECRET: 'test-secret',
  APP_BASE_URL: 'https://aries.example.com',
};

// ── Sweep (runHermesReconciler) ──────────────────────────────────────────────

test('sweep reconciles only in-flight marketing runs with a Hermes run id', async () => {
  const { runHermesReconciler } = await import('../backend/marketing/hermes-reconciler');

  const records: ExecutionRunRecord[] = [
    makeRecord({ aries_run_id: 'arun_inflight', status: 'running', external_run_id: 'hrun-a' }),
    makeRecord({ aries_run_id: 'arun_submitted', status: 'submitted', external_run_id: 'hrun-b' }),
    makeRecord({ aries_run_id: 'arun_terminal', status: 'completed', external_run_id: 'hrun-c' }),
    makeRecord({ aries_run_id: 'arun_failed', status: 'failed', external_run_id: 'hrun-d' }),
    makeRecord({ aries_run_id: 'arun_await', status: 'awaiting_approval', external_run_id: 'hrun-e' }),
    makeRecord({ aries_run_id: 'arun_noext', status: 'running', external_run_id: null }),
    makeRecord({ aries_run_id: 'arun_route', status: 'running', domain: 'route' }),
    makeRecord({ aries_run_id: 'arun_nostage', status: 'running', stage: null }),
  ];

  const called: string[] = [];
  const report = await runHermesReconciler({
    listRecords: () => records,
    port: {
      async reconcileExecutionRun(id: string): Promise<ReconcileRunOutcome> {
        called.push(id);
        return { status: 'pending' };
      },
    },
  });

  // Only the two in-flight marketing runs with a Hermes run id are candidates.
  assert.deepEqual(called.sort(), ['arun_inflight', 'arun_submitted']);
  assert.equal(report.scanned, records.length);
  assert.equal(report.candidates, 2);
  assert.equal(report.pending, 2);
  assert.equal(report.ingested, 0);
  assert.equal(report.errors, 0);
});

test('sweep tallies outcomes and isolates a throwing reconcile', async () => {
  const { runHermesReconciler } = await import('../backend/marketing/hermes-reconciler');

  const records: ExecutionRunRecord[] = [
    makeRecord({ aries_run_id: 'arun_ingest', external_run_id: 'hrun-1' }),
    makeRecord({ aries_run_id: 'arun_throw', external_run_id: 'hrun-2' }),
    makeRecord({ aries_run_id: 'arun_pending', external_run_id: 'hrun-3' }),
  ];

  const report = await runHermesReconciler({
    listRecords: () => records,
    port: {
      async reconcileExecutionRun(id: string): Promise<ReconcileRunOutcome> {
        if (id === 'arun_ingest') return { status: 'ingested', callbackStatus: 'completed', duplicate: false };
        if (id === 'arun_throw') throw new Error('boom');
        return { status: 'pending' };
      },
    },
  });

  assert.equal(report.candidates, 3);
  assert.equal(report.ingested, 1);
  assert.equal(report.pending, 1);
  assert.equal(report.errors, 1);
  // The throw did not abort the sweep — the pending run after it still ran.
  assert.ok(report.details.some((d) => d.outcome === 'error' && d.detail === 'boom'));
  assert.ok(report.details.some((d) => d.outcome === 'ingested:completed'));
});

test('sweep age gate skips runs younger than minAgeMs', async () => {
  const { runHermesReconciler } = await import('../backend/marketing/hermes-reconciler');

  const nowMs = Date.parse('2026-06-02T12:00:00.000Z');
  const records: ExecutionRunRecord[] = [
    makeRecord({ aries_run_id: 'arun_fresh', external_run_id: 'hrun-1', created_at: '2026-06-02T11:59:50.000Z' }), // 10s old
    makeRecord({ aries_run_id: 'arun_old', external_run_id: 'hrun-2', created_at: '2026-06-02T11:58:00.000Z' }), // 120s old
  ];

  const called: string[] = [];
  const report = await runHermesReconciler({
    now: () => nowMs,
    minAgeMs: 60_000,
    listRecords: () => records,
    port: {
      async reconcileExecutionRun(id: string): Promise<ReconcileRunOutcome> {
        called.push(id);
        return { status: 'pending' };
      },
    },
  });

  assert.deepEqual(called, ['arun_old']);
  assert.equal(report.candidates, 1);
});

// ── Per-run (reconcileExecutionRun) ──────────────────────────────────────────

async function makePort(fetchImpl: typeof fetch, env: Record<string, string> = HERMES_ENV) {
  const { HermesMarketingPort } = await import('../backend/marketing/ports/hermes');
  return new HermesMarketingPort(
    env,
    fetchImpl as never,
    async () => {},
    async () => ({ refreshed: false, enriched: false }),
    { query: async () => ({ rows: [], rowCount: 0 }) },
  );
}

async function seedMarketingJob(jobId: string, tenantId: string) {
  const { createSocialContentJobRuntimeDocument, saveSocialContentJobRuntime } = await import(
    '../backend/marketing/runtime-state'
  );
  const doc = createSocialContentJobRuntimeDocument({
    jobId,
    tenantId,
    payload: {
      brandUrl: 'https://brand.example',
      businessType: 'performance marketing agency',
      competitorUrl: 'https://betterup.com',
    },
    brandKit: {
      path: '/tmp/brand-kit.json',
      source_url: 'https://brand.example',
      canonical_url: 'https://brand.example',
      brand_name: 'Brand',
      logo_urls: [],
      colors: { primary: null, secondary: null, accent: null, palette: [] },
      font_families: [],
      external_links: [],
      extracted_at: new Date().toISOString(),
      brand_voice_summary: 'clear',
      offer_summary: null,
      positioning: null,
      audience: null,
      tone_of_voice: null,
      style_vibe: null,
    },
  });
  saveSocialContentJobRuntime(doc.job_id, doc);
  return doc;
}

test('reconcileExecutionRun skips non-candidate runs without polling Hermes', async () => {
  await withDataRoot(async () => {
    const store = await import('../backend/execution/run-store');

    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const port = await makePort(fetchImpl);

    // not_found
    assert.deepEqual(await port.reconcileExecutionRun('arun_missing'), { status: 'skipped', reason: 'not_found' });

    // already terminal
    const terminal = store.createExecutionRunRecord({ provider: 'hermes', domain: 'marketing', workflowKey: 'marketing_pipeline', action: 'run', stage: 'research', marketingJobId: 'job-1' });
    store.markExecutionRunSubmitted(terminal.aries_run_id, { externalRunId: 'hrun-t' });
    store.markExecutionRunEventApplied(terminal.aries_run_id, { eventId: 'e1', status: 'completed' });
    assert.deepEqual(await port.reconcileExecutionRun(terminal.aries_run_id), { status: 'skipped', reason: 'already_terminal' });

    // awaiting_approval
    const awaiting = store.createExecutionRunRecord({ provider: 'hermes', domain: 'marketing', workflowKey: 'marketing_pipeline', action: 'run', stage: 'research', marketingJobId: 'job-1' });
    store.markExecutionRunSubmitted(awaiting.aries_run_id, { externalRunId: 'hrun-w' });
    store.markExecutionRunEventApplied(awaiting.aries_run_id, { eventId: 'e2', status: 'awaiting_approval' });
    assert.deepEqual(await port.reconcileExecutionRun(awaiting.aries_run_id), { status: 'skipped', reason: 'awaiting_approval' });

    // not submitted (no external_run_id)
    const unsub = store.createExecutionRunRecord({ provider: 'hermes', domain: 'marketing', workflowKey: 'marketing_pipeline', action: 'run', stage: 'research', marketingJobId: 'job-1' });
    assert.deepEqual(await port.reconcileExecutionRun(unsub.aries_run_id), { status: 'skipped', reason: 'not_submitted' });

    // non-marketing
    const route = store.createExecutionRunRecord({ provider: 'hermes', domain: 'route', workflowKey: 'route_run', action: 'run' });
    store.markExecutionRunSubmitted(route.aries_run_id, { externalRunId: 'hrun-r' });
    assert.deepEqual(await port.reconcileExecutionRun(route.aries_run_id), { status: 'skipped', reason: 'non_marketing' });

    assert.equal(fetchCalls, 0, 'skip guards must short-circuit before any Hermes GET');
  });
});

test('reconcileExecutionRun returns pending (no mutation) when not terminal or on transient error', async () => {
  await withDataRoot(async () => {
    const store = await import('../backend/execution/run-store');

    async function freshRunningRun(externalRunId: string) {
      const rec = store.createExecutionRunRecord({ provider: 'hermes', domain: 'marketing', workflowKey: 'marketing_pipeline', action: 'run', stage: 'research', marketingJobId: 'job-1' });
      store.markExecutionRunSubmitted(rec.aries_run_id, { externalRunId });
      store.markExecutionRunEventApplied(rec.aries_run_id, { eventId: `run-${externalRunId}`, status: 'running' });
      return rec.aries_run_id;
    }

    // Still running → pending.
    const running = await freshRunningRun('hrun-run');
    const portRunning = await makePort((async () => new Response(JSON.stringify({ run_id: 'hrun-run', status: 'running' }), { status: 200 })) as unknown as typeof fetch);
    assert.deepEqual(await portRunning.reconcileExecutionRun(running), { status: 'pending' });

    // Gateway throws → transient → pending.
    const thrower = await freshRunningRun('hrun-throw');
    const portThrow = await makePort((async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch);
    assert.deepEqual(await portThrow.reconcileExecutionRun(thrower), { status: 'pending' });

    // Non-2xx → transient → pending.
    const non200 = await freshRunningRun('hrun-500');
    const port500 = await makePort((async () => new Response('nope', { status: 503 })) as unknown as typeof fetch);
    assert.deepEqual(await port500.reconcileExecutionRun(non200), { status: 'pending' });

    // Missing status field → transient → pending.
    const noStatus = await freshRunningRun('hrun-nostatus');
    const portNoStatus = await makePort((async () => new Response(JSON.stringify({ run_id: 'hrun-nostatus' }), { status: 200 })) as unknown as typeof fetch);
    assert.deepEqual(await portNoStatus.reconcileExecutionRun(noStatus), { status: 'pending' });

    // No run was advanced to terminal by a pending/transient poll.
    for (const ext of ['hrun-run', 'hrun-throw', 'hrun-500', 'hrun-nostatus']) {
      const all = store.listExecutionRunRecords().filter((r) => r.external_run_id === ext);
      assert.equal(all.length, 1);
      assert.equal(all[0].status, 'running', `${ext} must remain running after a non-terminal poll`);
    }
  });
});

test('reconcileExecutionRun polls the per-profile gateway for the run stage', async () => {
  await withDataRoot(async () => {
    const store = await import('../backend/execution/run-store');

    const rec = store.createExecutionRunRecord({ provider: 'hermes', domain: 'marketing', workflowKey: 'marketing_pipeline', action: 'run', stage: 'production', marketingJobId: 'job-1' });
    store.markExecutionRunSubmitted(rec.aries_run_id, { externalRunId: 'hrun-prod' });
    store.markExecutionRunEventApplied(rec.aries_run_id, { eventId: 'p1', status: 'running' });

    const urls: string[] = [];
    const port = await makePort((async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ run_id: 'hrun-prod', status: 'running' }), { status: 200 });
    }) as unknown as typeof fetch);

    await port.reconcileExecutionRun(rec.aries_run_id);

    // production → aries-content-generator → HERMES_CONTENT_GATEWAY_URL.
    assert.equal(urls.length, 1);
    assert.equal(urls[0], 'http://hermes-content.test/v1/runs/hrun-prod');
  });
});

test('reconcileExecutionRun uses a deterministic event_id so repeated passes dedupe', async () => {
  await withDataRoot(async () => {
    const store = await import('../backend/execution/run-store');

    const rec = store.createExecutionRunRecord({ provider: 'hermes', domain: 'marketing', workflowKey: 'marketing_pipeline', action: 'run', stage: 'research', marketingJobId: 'job-1' });
    store.markExecutionRunSubmitted(rec.aries_run_id, { externalRunId: 'hrun-det' });
    // Keep the run non-terminal but pre-seed the deterministic event_id a prior
    // reconcile pass would have written. If reconcileExecutionRun built a random
    // event_id (the bridge's behavior) this would NOT dedupe and would fall
    // through to applyHermesMarketingCallback; duplicate:true proves the id is
    // exactly `reconcile-<hermesRunId>`.
    store.markExecutionRunEventApplied(rec.aries_run_id, { eventId: 'reconcile-hrun-det', status: 'running' });

    const port = await makePort((async () => new Response(JSON.stringify({ run_id: 'hrun-det', status: 'completed' }), { status: 200 })) as unknown as typeof fetch);

    const outcome = await port.reconcileExecutionRun(rec.aries_run_id);
    assert.deepEqual(outcome, { status: 'ingested', callbackStatus: 'completed', duplicate: true });

    // The run record was not double-applied: still exactly one reconcile event.
    const reloaded = store.loadExecutionRunRecord(rec.aries_run_id);
    assert.equal(reloaded?.event_ids.filter((e) => e === 'reconcile-hrun-det').length, 1);
  });
});

// ── run-store enumerator ─────────────────────────────────────────────────────

test('listExecutionRunRecords enumerates every record and isTerminalExecutionStatus is correct', async () => {
  await withDataRoot(async () => {
    const store = await import('../backend/execution/run-store');

    assert.deepEqual(store.listExecutionRunRecords(), [], 'empty store → empty list');

    const a = store.createExecutionRunRecord({ provider: 'hermes', domain: 'marketing', workflowKey: 'k', action: 'run', stage: 'research' });
    const b = store.createExecutionRunRecord({ provider: 'hermes', domain: 'route', workflowKey: 'k', action: 'run' });

    const ids = store.listExecutionRunRecords().map((r) => r.aries_run_id).sort();
    assert.deepEqual(ids, [a.aries_run_id, b.aries_run_id].sort());

    assert.equal(store.isTerminalExecutionStatus('completed'), true);
    assert.equal(store.isTerminalExecutionStatus('failed'), true);
    assert.equal(store.isTerminalExecutionStatus('cancelled'), true);
    assert.equal(store.isTerminalExecutionStatus('running'), false);
    assert.equal(store.isTerminalExecutionStatus('submitted'), false);
    assert.equal(store.isTerminalExecutionStatus('awaiting_approval'), false);
  });
});

// ── Real ingestion path (duplicate:false through applyHermesMarketingCallback) ──

test('reconcileExecutionRun delivers a fresh terminal run into the marketing doc (duplicate:false)', async () => {
  await withDataRoot(async () => {
    const prevAutoApprove = process.env.ARIES_AUTO_APPROVE_MARKETING_PIPELINE;
    process.env.ARIES_AUTO_APPROVE_MARKETING_PIPELINE = '0'; // hold at approval; don't cascade into the next stage
    try {
      const store = await import('../backend/execution/run-store');
      const { loadSocialContentJobRuntime } = await import('../backend/marketing/runtime-state');
      const doc = await seedMarketingJob('job-recon-fresh', 'tenant-recon');

      const run = store.createExecutionRunRecord({
        provider: 'hermes',
        domain: 'marketing',
        workflowKey: 'social_content_weekly',
        action: 'run',
        tenantId: doc.tenant_id,
        marketingJobId: doc.job_id,
        stage: 'research',
      });
      store.markExecutionRunSubmitted(run.aries_run_id, { externalRunId: 'hrun-fresh', targetProfile: null });
      store.markExecutionRunEventApplied(run.aries_run_id, { eventId: 'init-running', status: 'running' });

      // Hermes GET returns a completed research run that paused for strategy approval.
      const port = await makePort((async () => new Response(JSON.stringify({
        run_id: 'hrun-fresh',
        status: 'completed',
        output: {
          status: 'requires_approval',
          approval: {
            stage: 'research_to_strategy',
            approval_step: 'approve_weekly_plan',
            workflowStepId: 'approve_stage_2',
            prompt: 'Approve strategy?',
            resume_token: 'tok-x',
          },
        },
      }), { status: 200 })) as unknown as typeof fetch);

      const outcome = await port.reconcileExecutionRun(run.aries_run_id);
      // The whole point of the fix: a fresh, never-applied terminal run is
      // actually ingested (NOT a duplicate short-circuit).
      assert.deepEqual(outcome, { status: 'ingested', callbackStatus: 'requires_approval', duplicate: false });

      // applyHermesMarketingCallback really ran: the doc advanced.
      const after = await loadSocialContentJobRuntime(doc.job_id);
      assert.equal(after?.stages.research.status, 'completed');
      assert.equal(after?.approvals.current?.stage, 'strategy');

      // The deterministic reconcile event was recorded and the run paused.
      const reloaded = store.loadExecutionRunRecord(run.aries_run_id);
      assert.ok(reloaded?.event_ids.includes('reconcile-hrun-fresh'));
      assert.equal(reloaded?.status, 'awaiting_approval');
    } finally {
      if (prevAutoApprove === undefined) delete process.env.ARIES_AUTO_APPROVE_MARKETING_PIPELINE;
      else process.env.ARIES_AUTO_APPROVE_MARKETING_PIPELINE = prevAutoApprove;
    }
  });
});

test('reconcileExecutionRun delivers a Hermes failure into the marketing doc', async () => {
  await withDataRoot(async () => {
    const store = await import('../backend/execution/run-store');
    const { loadSocialContentJobRuntime } = await import('../backend/marketing/runtime-state');
    const doc = await seedMarketingJob('job-recon-fail', 'tenant-recon');

    const run = store.createExecutionRunRecord({
      provider: 'hermes',
      domain: 'marketing',
      workflowKey: 'social_content_weekly',
      action: 'run',
      tenantId: doc.tenant_id,
      marketingJobId: doc.job_id,
      stage: 'research',
    });
    store.markExecutionRunSubmitted(run.aries_run_id, { externalRunId: 'hrun-fail', targetProfile: null });
    store.markExecutionRunEventApplied(run.aries_run_id, { eventId: 'init-running', status: 'running' });

    const port = await makePort((async () => new Response(JSON.stringify({
      run_id: 'hrun-fail',
      status: 'failed',
      error: 'boom',
    }), { status: 200 })) as unknown as typeof fetch);

    const outcome = await port.reconcileExecutionRun(run.aries_run_id);
    assert.deepEqual(outcome, { status: 'ingested', callbackStatus: 'failed', duplicate: false });

    const reloaded = store.loadExecutionRunRecord(run.aries_run_id);
    assert.equal(reloaded?.status, 'failed');
    assert.equal(reloaded?.last_error?.code, 'hermes_run_failed');

    const after = await loadSocialContentJobRuntime(doc.job_id);
    assert.equal(after?.state, 'failed');
  });
});

// ── Gateway routing: persisted profile vs legacy stage-derived fallback ───────

test('reconcileExecutionRun polls the DEFAULT gateway for a submitRawRun-style run (target_profile=null)', async () => {
  await withDataRoot(async () => {
    const store = await import('../backend/execution/run-store');

    // production stage, but submitted to the DEFAULT gateway (submitRawRun) →
    // target_profile=null. The reconciler must poll the default gateway, NOT the
    // stage-derived content gateway. (Regression test for the submit/poll mismatch.)
    const run = store.createExecutionRunRecord({ provider: 'hermes', domain: 'marketing', workflowKey: 'social_copy_finalize', action: 'run', stage: 'production', marketingJobId: 'job-x' });
    store.markExecutionRunSubmitted(run.aries_run_id, { externalRunId: 'hrun-raw', targetProfile: null });
    store.markExecutionRunEventApplied(run.aries_run_id, { eventId: 'r1', status: 'running' });

    const urls: string[] = [];
    const port = await makePort((async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ run_id: 'hrun-raw', status: 'running' }), { status: 200 });
    }) as unknown as typeof fetch);

    await port.reconcileExecutionRun(run.aries_run_id);
    assert.deepEqual(urls, ['http://hermes-default.test/v1/runs/hrun-raw']);
  });
});

test('reconcileExecutionRun falls back to stage-derived gateway for legacy records (no target_profile)', async () => {
  await withDataRoot(async () => {
    const store = await import('../backend/execution/run-store');

    // Simulate a record written before profile persistence: submitted via the
    // OLD markExecutionRunSubmitted shape (no targetProfile) → target_profile absent.
    const run = store.createExecutionRunRecord({ provider: 'hermes', domain: 'marketing', workflowKey: 'marketing_pipeline', action: 'run', stage: 'production', marketingJobId: 'job-y' });
    store.markExecutionRunSubmitted(run.aries_run_id, { externalRunId: 'hrun-legacy' });
    store.markExecutionRunEventApplied(run.aries_run_id, { eventId: 'r1', status: 'running' });

    const reloaded = store.loadExecutionRunRecord(run.aries_run_id);
    assert.equal(reloaded?.target_profile, undefined, 'legacy record must have no persisted profile');

    const urls: string[] = [];
    const port = await makePort((async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ run_id: 'hrun-legacy', status: 'running' }), { status: 200 });
    }) as unknown as typeof fetch);

    await port.reconcileExecutionRun(run.aries_run_id);
    // production → aries-content-generator → content gateway (stage-derived).
    assert.deepEqual(urls, ['http://hermes-content.test/v1/runs/hrun-legacy']);
  });
});

// ── Additional skip-guard + age coverage ─────────────────────────────────────

test('reconcileExecutionRun skips non-hermes and stage-less runs without polling', async () => {
  await withDataRoot(async () => {
    const store = await import('../backend/execution/run-store');

    let fetchCalls = 0;
    const port = await makePort((async () => { fetchCalls += 1; return new Response('{}', { status: 200 }); }) as unknown as typeof fetch);

    // stage-less submitted marketing run → no_stage (would otherwise index STAGE_TO_PROFILE[null]).
    const noStage = store.createExecutionRunRecord({ provider: 'hermes', domain: 'marketing', workflowKey: 'k', action: 'run' });
    store.markExecutionRunSubmitted(noStage.aries_run_id, { externalRunId: 'hrun-ns', targetProfile: null });
    store.markExecutionRunEventApplied(noStage.aries_run_id, { eventId: 'r1', status: 'running' });
    assert.deepEqual(await port.reconcileExecutionRun(noStage.aries_run_id), { status: 'skipped', reason: 'no_stage' });

    assert.equal(fetchCalls, 0);
  });
});

// ── Callback-error branches (locked → pending, generic → error) ──────────────

test('reconcileExecutionRun maps execution_run_locked to pending (benign live-callback race)', async () => {
  await withDataRoot(async () => {
    const store = await import('../backend/execution/run-store');

    const run = store.createExecutionRunRecord({ provider: 'hermes', domain: 'marketing', workflowKey: 'marketing_pipeline', action: 'run', stage: 'research', marketingJobId: 'job-1' });
    store.markExecutionRunSubmitted(run.aries_run_id, { externalRunId: 'hrun-lock', targetProfile: null });
    store.markExecutionRunEventApplied(run.aries_run_id, { eventId: 'r1', status: 'running' });

    // Hold the per-run lock so handleHermesRunCallback's withExecutionRunLock
    // hits EEXIST → ExecutionRunLockError → {status:'error',reason:'execution_run_locked'}.
    const lockPath = `${store.executionRunPath(run.aries_run_id)}.lock`;
    closeSync(openSync(lockPath, 'wx'));

    const port = await makePort((async () => new Response(JSON.stringify({ run_id: 'hrun-lock', status: 'completed' }), { status: 200 })) as unknown as typeof fetch);
    const outcome = await port.reconcileExecutionRun(run.aries_run_id);
    assert.deepEqual(outcome, { status: 'pending' });
  });
});

test('reconcileExecutionRun surfaces a generic callback error (and honors opts.record)', async () => {
  await withDataRoot(async () => {
    const { HermesMarketingPort } = await import('../backend/marketing/ports/hermes');
    const port = new HermesMarketingPort(
      HERMES_ENV,
      (async () => new Response(JSON.stringify({ run_id: 'hrun-ghost', status: 'completed' }), { status: 200 })) as never,
      async () => {},
      async () => ({ refreshed: false, enriched: false }),
      { query: async () => ({ rows: [], rowCount: 0 }) },
    );

    // Pass a record via opts.record that is NOT on disk. reconcileExecutionRun
    // uses it (proving the double-read-avoidance passthrough), polls terminal,
    // then handleHermesRunCallback can't load the record → execution_run_not_found.
    const ghost = {
      schema_name: 'aries_execution_run' as const,
      schema_version: '1.0.0' as const,
      aries_run_id: 'arun_ghost',
      provider: 'hermes' as const,
      domain: 'marketing' as const,
      workflow_key: 'marketing_pipeline',
      action: 'run' as const,
      tenant_id: 't1',
      marketing_job_id: 'job-1',
      approval_id: null,
      stage: 'research' as const,
      workflow_step_id: null,
      external_run_id: 'hrun-ghost',
      target_profile: null,
      status: 'running' as const,
      event_ids: [],
      created_at: '2020-01-01T00:00:00.000Z',
      updated_at: '2020-01-01T00:00:00.000Z',
      last_error: null,
      result: null,
    };
    const outcome = await port.reconcileExecutionRun('arun_ghost', { record: ghost });
    assert.deepEqual(outcome, { status: 'error', reason: 'execution_run_not_found' });
  });
});

// ── markExecutionRunFailed terminal-immutability guard ───────────────────────

test('markExecutionRunFailed never overwrites a terminal run', async () => {
  await withDataRoot(async () => {
    const store = await import('../backend/execution/run-store');

    const run = store.createExecutionRunRecord({ provider: 'hermes', domain: 'marketing', workflowKey: 'k', action: 'run', stage: 'research' });
    store.markExecutionRunEventApplied(run.aries_run_id, { eventId: 'done', status: 'completed', result: { ok: true } });

    const after = store.markExecutionRunFailed(run.aries_run_id, { code: 'late_failure', message: 'should not apply' });
    assert.equal(after?.status, 'completed', 'completed run must stay completed');
    assert.equal(after?.last_error, null, 'last_error must be unchanged');

    const reloaded = store.loadExecutionRunRecord(run.aries_run_id);
    assert.equal(reloaded?.status, 'completed');
    assert.equal(reloaded?.last_error, null);

    // A non-terminal run still flips to failed (guard is terminal-only).
    const live = store.createExecutionRunRecord({ provider: 'hermes', domain: 'marketing', workflowKey: 'k', action: 'run', stage: 'research' });
    store.markExecutionRunEventApplied(live.aries_run_id, { eventId: 'r1', status: 'running' });
    const failed = store.markExecutionRunFailed(live.aries_run_id, { code: 'boom', message: 'real failure' });
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.last_error?.code, 'boom');
  });
});

// ── mtime scan filter + window wiring ────────────────────────────────────────

test('listExecutionRunRecords mtime filter skips files older than the window', async () => {
  await withDataRoot(async () => {
    const store = await import('../backend/execution/run-store');

    const fresh = store.createExecutionRunRecord({ provider: 'hermes', domain: 'marketing', workflowKey: 'k', action: 'run', stage: 'research' });
    const old = store.createExecutionRunRecord({ provider: 'hermes', domain: 'marketing', workflowKey: 'k', action: 'run', stage: 'research' });
    // Backdate the "old" run's file to 48h ago.
    const oldPath = store.executionRunPath(old.aries_run_id);
    const longAgo = new Date('2020-01-01T00:00:00.000Z');
    utimesSync(oldPath, longAgo, longAgo);

    // No filter → both.
    assert.equal(store.listExecutionRunRecords().length, 2);
    // 24h window → only the fresh one (no parse of the old file).
    const within = store.listExecutionRunRecords({ modifiedWithinMs: 24 * 60 * 60 * 1000 });
    assert.deepEqual(within.map((r) => r.aries_run_id), [fresh.aries_run_id]);
  });
});

test('runHermesReconciler default scan honors maxRecordAgeMs window (real listExecutionRunRecords)', async () => {
  await withDataRoot(async () => {
    const store = await import('../backend/execution/run-store');
    const { runHermesReconciler } = await import('../backend/marketing/hermes-reconciler');

    const fresh = store.createExecutionRunRecord({ provider: 'hermes', domain: 'marketing', workflowKey: 'k', action: 'run', stage: 'research' });
    store.markExecutionRunSubmitted(fresh.aries_run_id, { externalRunId: 'hrun-fresh', targetProfile: null });
    store.markExecutionRunEventApplied(fresh.aries_run_id, { eventId: 'r1', status: 'running' });
    const old = store.createExecutionRunRecord({ provider: 'hermes', domain: 'marketing', workflowKey: 'k', action: 'run', stage: 'research' });
    store.markExecutionRunSubmitted(old.aries_run_id, { externalRunId: 'hrun-old', targetProfile: null });
    store.markExecutionRunEventApplied(old.aries_run_id, { eventId: 'r1', status: 'running' });
    const longAgo = new Date('2020-01-01T00:00:00.000Z');
    utimesSync(store.executionRunPath(old.aries_run_id), longAgo, longAgo);

    const reconciled: string[] = [];
    const report = await runHermesReconciler({
      maxRecordAgeMs: 24 * 60 * 60 * 1000,
      port: { async reconcileExecutionRun(id) { reconciled.push(id); return { status: 'pending' }; } },
    });
    // The backdated run is filtered out by the mtime window before parse.
    assert.deepEqual(reconciled, [fresh.aries_run_id]);
    assert.equal(report.candidates, 1);
  });
});

test('runHermesReconciler default minAgeMs (0) treats a 1s-old run as a candidate; env parsing is robust', async () => {
  const { runHermesReconciler } = await import('../backend/marketing/hermes-reconciler');
  const nowMs = Date.parse('2026-06-02T12:00:00.000Z');
  const records: ExecutionRunRecord[] = [
    makeRecord({ aries_run_id: 'arun_1s', external_run_id: 'hrun-1', created_at: '2026-06-02T11:59:59.000Z' }), // 1s old
  ];

  // Default (no minAgeMs option, env unset) → age gate disabled → candidate.
  const prev = process.env.ARIES_RECONCILER_MIN_AGE_MS;
  delete process.env.ARIES_RECONCILER_MIN_AGE_MS;
  try {
    let called = 0;
    const report = await runHermesReconciler({
      now: () => nowMs,
      listRecords: () => records,
      port: { async reconcileExecutionRun() { called += 1; return { status: 'pending' }; } },
    });
    assert.equal(report.candidates, 1);
    assert.equal(called, 1);

    // Non-numeric env → treated as 0 (no skipping).
    process.env.ARIES_RECONCILER_MIN_AGE_MS = 'abc';
    const report2 = await runHermesReconciler({
      now: () => nowMs,
      listRecords: () => records,
      port: { async reconcileExecutionRun() { return { status: 'pending' }; } },
    });
    assert.equal(report2.candidates, 1);

    // Valid env → enforced (1s-old run skipped under a 60s floor).
    process.env.ARIES_RECONCILER_MIN_AGE_MS = '60000';
    const report3 = await runHermesReconciler({
      now: () => nowMs,
      listRecords: () => records,
      port: { async reconcileExecutionRun() { return { status: 'pending' }; } },
    });
    assert.equal(report3.candidates, 0);
  } finally {
    if (prev === undefined) delete process.env.ARIES_RECONCILER_MIN_AGE_MS;
    else process.env.ARIES_RECONCILER_MIN_AGE_MS = prev;
  }
});
