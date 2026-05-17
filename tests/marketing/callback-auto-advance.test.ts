import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { MarketingExecutionPort, MarketingExecutionResult, MarketingPipelineNextStageInput, MarketingPipelineResumeInput, MarketingPipelineRunInput } from '../../backend/marketing/execution-port';
import type { MarketingJobRuntimeDocument, MarketingStage } from '../../backend/marketing/runtime-state';
import { maybeAutoAdvanceNextStage } from '../../backend/marketing/hermes-callbacks';

// ---------------------------------------------------------------------------
// Test environment
// ---------------------------------------------------------------------------

async function withDataRoot<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.DATA_ROOT;
  const dir = await mkdtemp(path.join(tmpdir(), 'aries-auto-advance-'));
  process.env.DATA_ROOT = dir;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BRAND_URL = 'https://example.com';

function makeBrandKit() {
  return {
    source_url: BRAND_URL,
    canonical_url: BRAND_URL,
    brand_name: 'Test Brand',
    logo_urls: [],
    colors: { primary: null, secondary: null, accent: null, palette: [] },
    font_families: [],
    external_links: [],
    extracted_at: new Date().toISOString(),
    brand_voice_summary: null,
    offer_summary: null,
    positioning: null,
    audience: null,
    tone_of_voice: null,
    style_vibe: null,
    path: '/tmp/brand-kit.json',
  };
}

function makeDoc(overrides: Partial<MarketingJobRuntimeDocument> = {}): MarketingJobRuntimeDocument {
  const ts = new Date().toISOString();
  function stage(s: MarketingStage) {
    return {
      stage: s,
      status: 'not_started' as const,
      started_at: null,
      completed_at: null,
      failed_at: null,
      run_id: null,
      summary: null,
      primary_output: null,
      outputs: {},
      artifacts: [],
      errors: [],
    };
  }
  return {
    schema_name: 'marketing_job_state_schema',
    schema_version: '1.0.0',
    job_id: 'job_test_001',
    tenant_id: '42',
    job_type: 'brand_campaign',
    state: 'running',
    status: 'running',
    current_stage: 'research',
    stage_order: ['research', 'strategy', 'production', 'publish'],
    stages: {
      research: { ...stage('research'), status: 'completed', completed_at: ts },
      strategy: stage('strategy'),
      production: stage('production'),
      publish: stage('publish'),
    },
    approvals: { current: null, history: [] },
    publish_config: { platforms: [], live_publish_platforms: [], video_render_platforms: [] },
    brand_kit: makeBrandKit(),
    inputs: {
      request: {},
      brand_url: BRAND_URL,
    },
    errors: [],
    last_error: null,
    history: [],
    created_at: ts,
    updated_at: ts,
    social_content_runtime: null,
    created_by: null,
    deleted_at: null,
    deleted_by: null,
    soft_cancel_requested_at: null,
    ...overrides,
  };
}

function makePort(opts: {
  submitNextStage?: (input: MarketingPipelineNextStageInput) => Promise<MarketingExecutionResult>;
} = {}): MarketingExecutionPort & { submitCalls: MarketingPipelineNextStageInput[] } {
  const calls: MarketingPipelineNextStageInput[] = [];
  return {
    name: 'hermes',
    submitCalls: calls,
    async runPipeline(_input: MarketingPipelineRunInput): Promise<MarketingExecutionResult> {
      return { kind: 'submitted', provider: 'hermes', ariesRunId: 'aries_run_stub' };
    },
    async resumePipeline(_input: MarketingPipelineResumeInput): Promise<MarketingExecutionResult> {
      return { kind: 'submitted', provider: 'hermes', ariesRunId: 'aries_run_stub' };
    },
    async submitNextStage(input: MarketingPipelineNextStageInput): Promise<MarketingExecutionResult> {
      calls.push(input);
      if (opts.submitNextStage) return opts.submitNextStage(input);
      return { kind: 'submitted', provider: 'hermes', ariesRunId: 'aries_run_next' };
    },
  };
}

function makePayload(overrides: Record<string, unknown> = {}): {
  status: string;
  stage?: string;
  approval?: unknown;
  output?: unknown[];
  hermes_run_id?: string;
  [key: string]: unknown;
} {
  return {
    status: 'completed',
    hermes_run_id: 'hermes_run_001',
    output: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test 1: research completed without approval → strategy stage submitted
// ---------------------------------------------------------------------------

test('research completed without approval → strategy stage submitted to Hermes', async () => {
  await withDataRoot(async () => {
    const doc = makeDoc();
    doc.stages.research.status = 'completed';
    const port = makePort();

    await maybeAutoAdvanceNextStage(doc, 'research', makePayload() as never, port);

    assert.equal(port.submitCalls.length, 1, 'submitNextStage must be called once');
    assert.equal(port.submitCalls[0]?.stage, 'strategy');
    assert.equal(port.submitCalls[0]?.jobId, 'job_test_001');
    assert.equal(port.submitCalls[0]?.tenantId, '42');
    assert.equal(doc.stages.strategy.status, 'in_progress', 'strategy stage must be flipped to in_progress before submit');
  });
});

// ---------------------------------------------------------------------------
// Test 2: strategy completed without approval → production stage submitted
// ---------------------------------------------------------------------------

test('strategy completed without approval → production stage submitted', async () => {
  await withDataRoot(async () => {
    const ts = new Date().toISOString();
    const doc = makeDoc({
      current_stage: 'strategy',
      stages: {
        research: { stage: 'research', status: 'completed', started_at: null, completed_at: ts, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
        strategy: { stage: 'strategy', status: 'completed', started_at: null, completed_at: ts, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
        production: { stage: 'production', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
        publish: { stage: 'publish', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
      },
    });
    const port = makePort();

    await maybeAutoAdvanceNextStage(doc, 'strategy', makePayload() as never, port);

    assert.equal(port.submitCalls.length, 1);
    assert.equal(port.submitCalls[0]?.stage, 'production');
    assert.equal(doc.stages.production.status, 'in_progress');
  });
});

// ---------------------------------------------------------------------------
// Test 3: production completed without approval → publish stage submitted
// ---------------------------------------------------------------------------

test('production completed without approval → publish stage submitted', async () => {
  await withDataRoot(async () => {
    const ts = new Date().toISOString();
    const doc = makeDoc({
      current_stage: 'production',
      stages: {
        research: { stage: 'research', status: 'completed', started_at: null, completed_at: ts, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
        strategy: { stage: 'strategy', status: 'completed', started_at: null, completed_at: ts, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
        production: { stage: 'production', status: 'completed', started_at: null, completed_at: ts, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
        publish: { stage: 'publish', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
      },
    });
    const port = makePort();

    await maybeAutoAdvanceNextStage(doc, 'production', makePayload() as never, port);

    assert.equal(port.submitCalls.length, 1);
    assert.equal(port.submitCalls[0]?.stage, 'publish');
    assert.equal(doc.stages.publish.status, 'in_progress');
  });
});

// ---------------------------------------------------------------------------
// Test 4: publish completed without approval → no auto-advance fired (R4)
// ---------------------------------------------------------------------------

test('publish completed without approval → no auto-advance fired', async () => {
  await withDataRoot(async () => {
    const ts = new Date().toISOString();
    const doc = makeDoc({
      current_stage: 'publish',
      state: 'completed',
      status: 'completed',
      stages: {
        research: { stage: 'research', status: 'completed', started_at: null, completed_at: ts, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
        strategy: { stage: 'strategy', status: 'completed', started_at: null, completed_at: ts, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
        production: { stage: 'production', status: 'completed', started_at: null, completed_at: ts, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
        publish: { stage: 'publish', status: 'completed', started_at: null, completed_at: ts, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
      },
    });
    const port = makePort();

    await maybeAutoAdvanceNextStage(doc, 'publish', makePayload() as never, port);

    assert.equal(port.submitCalls.length, 0, 'submitNextStage must NOT be called for publish stage');
  });
});

// ---------------------------------------------------------------------------
// Test 5: next stage already in_progress → auto-advance is a no-op (R5 / multi-stage guard)
// ---------------------------------------------------------------------------

test('next stage already in_progress → auto-advance is a no-op', async () => {
  await withDataRoot(async () => {
    const doc = makeDoc();
    doc.stages.strategy.status = 'in_progress';
    const port = makePort();

    await maybeAutoAdvanceNextStage(doc, 'research', makePayload() as never, port);

    assert.equal(port.submitCalls.length, 0, 'submitNextStage must NOT be called when next stage is already in_progress');
  });
});

// ---------------------------------------------------------------------------
// Test 6: requires_approval payload → auto-advance does NOT fire (R1)
// ---------------------------------------------------------------------------

test('requires_approval payload → auto-advance does NOT fire', async () => {
  await withDataRoot(async () => {
    const doc = makeDoc();
    const port = makePort();

    await maybeAutoAdvanceNextStage(
      doc,
      'research',
      makePayload({
        status: 'completed',
        approval: { resume_token: 'tok_abc', workflow_step_id: 'step_1', prompt: 'Approve?' },
      }) as never,
      port,
    );

    assert.equal(port.submitCalls.length, 0, 'submitNextStage must NOT be called when approval is present');
  });
});

// ---------------------------------------------------------------------------
// Test 7: duplicate completed callback → second call is a no-op (R5)
// ---------------------------------------------------------------------------

test('duplicate completed callback → second auto-advance is a no-op', async () => {
  await withDataRoot(async () => {
    const doc = makeDoc();
    const port = makePort();

    await maybeAutoAdvanceNextStage(doc, 'research', makePayload() as never, port);
    // First call flips strategy to in_progress; second call must see that and bail.
    await maybeAutoAdvanceNextStage(doc, 'research', makePayload() as never, port);

    assert.equal(port.submitCalls.length, 1, 'submitNextStage must be called only once even on duplicate');
  });
});

// ---------------------------------------------------------------------------
// Test 8: submit-next-stage failure → stage marked failed with auto_advance_submit_failed (M4)
// ---------------------------------------------------------------------------

test('submit-next-stage failure → stage marked failed with auto_advance_submit_failed', async () => {
  await withDataRoot(async () => {
    const doc = makeDoc();
    const port = makePort({
      submitNextStage: async () => { throw new Error('network timeout'); },
    });

    await maybeAutoAdvanceNextStage(doc, 'research', makePayload() as never, port);

    assert.equal(doc.stages.strategy.status, 'failed', 'strategy stage must be marked failed on submission error');
    const lastErr = doc.stages.strategy.errors[doc.stages.strategy.errors.length - 1];
    assert.ok(lastErr, 'strategy stage must have an error record');
    assert.equal(lastErr?.code, 'auto_advance_submit_failed');
    assert.ok(lastErr?.retryable === true, 'error must be marked retryable');
  });
});

// ---------------------------------------------------------------------------
// Test 9: auto-advance submit throws → stage marked failed, doc saved, no second call
// ---------------------------------------------------------------------------

test('auto-advance submit throws → stage marked failed with auto_advance_submit_failed, no advance', async () => {
  await withDataRoot(async () => {
    const doc = makeDoc();
    let callCount = 0;
    const port = makePort({
      submitNextStage: async () => {
        callCount++;
        throw new Error('hermes_rejected');
      },
    });

    await maybeAutoAdvanceNextStage(doc, 'research', makePayload() as never, port);

    assert.equal(callCount, 1, 'port must be called exactly once');
    assert.equal(doc.stages.strategy.status, 'failed');
    const err = doc.stages.strategy.errors.at(-1);
    assert.equal(err?.code, 'auto_advance_submit_failed');
    assert.equal(doc.state, 'failed', 'doc.state must be set to failed');
  });
});
