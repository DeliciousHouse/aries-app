import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type {
  ApproveMarketingJobRequest,
  ApproveMarketingJobResponse,
} from '../../backend/marketing/orchestrator';
import type {
  MarketingApprovalCheckpoint,
  MarketingJobRuntimeDocument,
  MarketingStage,
} from '../../backend/marketing/runtime-state';
import { maybeAutoApproveMarketingCheckpoint } from '../../backend/marketing/hermes-callbacks';

// ---------------------------------------------------------------------------
// Test environment
// ---------------------------------------------------------------------------

async function withDataRoot<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.DATA_ROOT;
  const dir = await mkdtemp(path.join(tmpdir(), 'aries-auto-approve-'));
  process.env.DATA_ROOT = dir;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

function withEnvOverride<T>(key: string, value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  return fn().finally(() => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BRAND_URL = 'https://aries.sugarandleather.com/';

function makeCheckpoint(overrides: Partial<MarketingApprovalCheckpoint> = {}): MarketingApprovalCheckpoint {
  return {
    stage: 'strategy',
    status: 'awaiting_approval',
    approval_id: 'mkta_test_001',
    workflow_name: 'social_content_weekly',
    workflow_step_id: 'approve_weekly_plan',
    title: 'Approve strategy',
    message: 'Review research before strategy starts',
    requested_at: new Date().toISOString(),
    resume_token: 'resume_token_test_001',
    action_label: null,
    publish_config: null,
    ...overrides,
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
    job_type: 'weekly_social_content',
    state: 'approval_required',
    status: 'awaiting_approval',
    current_stage: 'strategy',
    stage_order: ['research', 'strategy', 'production', 'publish'],
    stages: {
      research: { ...stage('research'), status: 'completed', completed_at: ts },
      strategy: { ...stage('strategy'), status: 'awaiting_approval' },
      production: stage('production'),
      publish: stage('publish'),
    },
    approvals: { current: makeCheckpoint(), history: [] },
    publish_config: { platforms: [], live_publish_platforms: [], video_render_platforms: [] },
    brand_kit: {
      source_url: BRAND_URL,
      canonical_url: BRAND_URL,
      brand_name: 'Aries AI',
      logo_urls: [],
      colors: { primary: null, secondary: null, accent: null, palette: [] },
      font_families: [],
      external_links: [],
      extracted_at: ts,
      brand_voice_summary: null,
      offer_summary: null,
      positioning: null,
      audience: null,
      tone_of_voice: null,
      style_vibe: null,
      path: '/tmp/brand-kit.json',
    },
    inputs: { request: {}, brand_url: BRAND_URL },
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

type ApproveCall = { input: ApproveMarketingJobRequest; doc: MarketingJobRuntimeDocument };

function makeApproveStub(opts: {
  response?: ApproveMarketingJobResponse;
  throws?: Error;
} = {}): {
  approve: (input: ApproveMarketingJobRequest, doc: MarketingJobRuntimeDocument) => Promise<ApproveMarketingJobResponse>;
  calls: ApproveCall[];
} {
  const calls: ApproveCall[] = [];
  return {
    calls,
    approve: async (input, doc) => {
      calls.push({ input, doc });
      if (opts.throws) throw opts.throws;
      return opts.response ?? {
        status: 'resumed',
        jobId: input.jobId,
        tenantId: input.tenantId,
        resumedStage: 'production',
        completed: false,
        approvalId: input.approvalId ?? null,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Test 1: Flag OFF → no approve call (default behavior preserved)
// ---------------------------------------------------------------------------

test('flag OFF + requires_approval checkpoint → no approve call (default off)', async () => {
  await withDataRoot(async () => {
    await withEnvOverride('ARIES_AUTO_APPROVE_MARKETING_PIPELINE', undefined, async () => {
      const doc = makeDoc();
      const stub = makeApproveStub();

      await maybeAutoApproveMarketingCheckpoint(doc, stub.approve);

      assert.equal(stub.calls.length, 0, 'approve must NOT be called when flag is unset');
      assert.equal(doc.history.length, 0, 'no history entries written when flag off');
    });
  });
});

// ---------------------------------------------------------------------------
// Test 2: Flag ON + strategy checkpoint → approve fires
// ---------------------------------------------------------------------------

test('flag ON + strategy checkpoint → approveMarketingJob called with ai-orchestrator', async () => {
  await withDataRoot(async () => {
    await withEnvOverride('ARIES_AUTO_APPROVE_MARKETING_PIPELINE', '1', async () => {
      const doc = makeDoc();
      const stub = makeApproveStub();

      await maybeAutoApproveMarketingCheckpoint(doc, stub.approve);

      assert.equal(stub.calls.length, 1, 'approve must fire exactly once');
      assert.equal(stub.calls[0]?.input.approvedBy, 'ai-orchestrator');
      assert.equal(stub.calls[0]?.input.approvalId, 'mkta_test_001');
      assert.deepEqual(stub.calls[0]?.input.approvedStages, ['strategy']);
      assert.equal(stub.calls[0]?.input.tenantId, '42');
      assert.equal(stub.calls[0]?.input.jobId, 'job_test_001');
      assert.ok(
        doc.history.some((h) => /auto-approving strategy/.test(h.note ?? '')),
        'history must record auto-approving event',
      );
      assert.ok(
        doc.history.some((h) => /auto-approved strategy/.test(h.note ?? '')),
        'history must record successful auto-approve resolution',
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Test 3: Flag ON + production checkpoint → approve fires
// ---------------------------------------------------------------------------

test('flag ON + production checkpoint → approveMarketingJob called for production', async () => {
  await withDataRoot(async () => {
    await withEnvOverride('ARIES_AUTO_APPROVE_MARKETING_PIPELINE', '1', async () => {
      const ts = new Date().toISOString();
      const doc = makeDoc({
        current_stage: 'production',
        stages: {
          research: { stage: 'research', status: 'completed', started_at: null, completed_at: ts, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          strategy: { stage: 'strategy', status: 'completed', started_at: null, completed_at: ts, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          production: { stage: 'production', status: 'awaiting_approval', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          publish: { stage: 'publish', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
        },
        approvals: {
          current: makeCheckpoint({ stage: 'production', approval_id: 'mkta_prod_002', workflow_step_id: 'approve_image_creatives' }),
          history: [],
        },
      });
      const stub = makeApproveStub();

      await maybeAutoApproveMarketingCheckpoint(doc, stub.approve);

      assert.equal(stub.calls.length, 1);
      assert.equal(stub.calls[0]?.input.approvalId, 'mkta_prod_002');
      assert.deepEqual(stub.calls[0]?.input.approvedStages, ['production']);
    });
  });
});

// ---------------------------------------------------------------------------
// Test 4: Flag ON + doc terminal (publish-skip path) → no approve call
// ---------------------------------------------------------------------------

test('flag ON + doc.state=completed (publish-skip) → no approve call', async () => {
  await withDataRoot(async () => {
    await withEnvOverride('ARIES_AUTO_APPROVE_MARKETING_PIPELINE', '1', async () => {
      const doc = makeDoc({ state: 'completed', status: 'completed' });
      const stub = makeApproveStub();

      await maybeAutoApproveMarketingCheckpoint(doc, stub.approve);

      assert.equal(stub.calls.length, 0, 'approve must NOT fire on already-terminal doc');
    });
  });
});

// ---------------------------------------------------------------------------
// Test 5: Flag ON + approve throws → appendHistory only, no recordStageFailure, no loop
// ---------------------------------------------------------------------------

test('flag ON + approve throws → history records failure, no recordStageFailure, no infinite loop', async () => {
  await withDataRoot(async () => {
    await withEnvOverride('ARIES_AUTO_APPROVE_MARKETING_PIPELINE', '1', async () => {
      const doc = makeDoc();
      const stub = makeApproveStub({ throws: new Error('hermes_rejected') });

      await maybeAutoApproveMarketingCheckpoint(doc, stub.approve);

      assert.equal(stub.calls.length, 1, 'approve must be called exactly once (no retry)');
      // Stage must NOT be marked failed — the resolveMarketingApproval catch restores the checkpoint
      assert.notEqual(doc.stages.strategy.status, 'failed', 'must not call recordStageFailure (conflicts with checkpoint restore)');
      assert.ok(
        doc.history.some((h) => /auto-approve threw for strategy/.test(h.note ?? '')),
        'history must record the throw',
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Test 6: Flag ON + approve returns approval_not_available → benign no-op
// ---------------------------------------------------------------------------

test('flag ON + approve returns approval_not_available → benign no-op, no error recorded', async () => {
  await withDataRoot(async () => {
    await withEnvOverride('ARIES_AUTO_APPROVE_MARKETING_PIPELINE', '1', async () => {
      const doc = makeDoc();
      const stub = makeApproveStub({
        response: {
          status: 'error',
          jobId: doc.job_id,
          tenantId: doc.tenant_id,
          resumedStage: null,
          completed: false,
          reason: 'approval_not_available',
        },
      });

      await maybeAutoApproveMarketingCheckpoint(doc, stub.approve);

      assert.equal(stub.calls.length, 1);
      assert.notEqual(doc.stages.strategy.status, 'failed', 'must not mark stage failed on benign idempotent return');
      assert.ok(
        doc.history.some((h) => /already resolved/.test(h.note ?? '')),
        'history must record the idempotent no-op',
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Test 7: Flag ON + no checkpoint → no approve call (defensive guard)
// ---------------------------------------------------------------------------

test('flag ON + no checkpoint (doc.approvals.current is null) → no approve call', async () => {
  await withDataRoot(async () => {
    await withEnvOverride('ARIES_AUTO_APPROVE_MARKETING_PIPELINE', '1', async () => {
      const doc = makeDoc({ approvals: { current: null, history: [] } });
      const stub = makeApproveStub();

      await maybeAutoApproveMarketingCheckpoint(doc, stub.approve);

      assert.equal(stub.calls.length, 0, 'approve must NOT fire when no checkpoint exists');
    });
  });
});

// ---------------------------------------------------------------------------
// Test 8: Flag ON + missing tenantId → no approve call (defensive)
// ---------------------------------------------------------------------------

test('flag ON + doc.tenant_id is empty → no approve call', async () => {
  await withDataRoot(async () => {
    await withEnvOverride('ARIES_AUTO_APPROVE_MARKETING_PIPELINE', '1', async () => {
      const doc = makeDoc({ tenant_id: '' });
      const stub = makeApproveStub();

      await maybeAutoApproveMarketingCheckpoint(doc, stub.approve);

      assert.equal(stub.calls.length, 0, 'approve must NOT fire when tenant_id is empty');
    });
  });
});

// ---------------------------------------------------------------------------
// Test 9: Flag ON + approve returns approval_resolution_in_progress → benign no-op
// ---------------------------------------------------------------------------

test('flag ON + approve returns approval_resolution_in_progress → benign no-op', async () => {
  await withDataRoot(async () => {
    await withEnvOverride('ARIES_AUTO_APPROVE_MARKETING_PIPELINE', '1', async () => {
      const doc = makeDoc();
      const stub = makeApproveStub({
        response: {
          status: 'error',
          jobId: doc.job_id,
          tenantId: doc.tenant_id,
          resumedStage: null,
          completed: false,
          reason: 'approval_resolution_in_progress',
        },
      });

      await maybeAutoApproveMarketingCheckpoint(doc, stub.approve);

      assert.equal(stub.calls.length, 1);
      assert.notEqual(doc.stages.strategy.status, 'failed', 'must not mark stage failed when resolution is in flight');
      assert.ok(
        doc.history.some((h) => /resolution in flight/.test(h.note ?? '')),
        'history must record in-flight resolution',
      );
    });
  });
});
