import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function withRuntimeEnv<T>(run: () => Promise<T>): Promise<T> {
  const previousDataRoot = process.env.DATA_ROOT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-marketing-hermes-callback-'));

  process.env.DATA_ROOT = dataRoot;
  try {
    return await run();
  } finally {
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

async function seedMarketingJob() {
  const {
    createMarketingJobRuntimeDocument,
    saveMarketingJobRuntime,
  } = await import('../backend/marketing/runtime-state');

  const doc = createMarketingJobRuntimeDocument({
    jobId: 'job-hermes-callback',
    tenantId: 'tenant-hermes',
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
      colors: {
        primary: null,
        secondary: null,
        accent: null,
        palette: [],
      },
      font_families: [],
      external_links: [],
      extracted_at: new Date().toISOString(),
      brand_voice_summary: 'clear',
      offer_summary: null,
    },
  });
  saveMarketingJobRuntime(doc.job_id, doc);
  return doc;
}

test('Hermes marketing callbacks advance runtime docs and create provider-neutral approvals', async () => {
  await withRuntimeEnv(async () => {
    const { createExecutionRunRecord } = await import('../backend/execution/run-store');
    const { handleHermesRunCallback } = await import('../backend/execution/hermes-callbacks');
    const {
      listMarketingApprovalRecordsForJob,
      loadMarketingApprovalRecord,
    } = await import('../backend/marketing/approval-store');
    const { loadMarketingJobRuntime } = await import('../backend/marketing/runtime-state');
    const doc = await seedMarketingJob();

    const researchRun = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'marketing',
      workflowKey: 'social_content_weekly',
      action: 'run',
      tenantId: doc.tenant_id,
      marketingJobId: doc.job_id,
      stage: 'research',
    });

    const researchResult = await handleHermesRunCallback({
      event_id: 'evt-research',
      aries_run_id: researchRun.aries_run_id,
      hermes_run_id: 'hermes-research-1',
      status: 'requires_approval',
      stage: 'planning',
      output: [{ run_id: 'research-run-1', summary: 'Research complete' }],
      approval: {
        stage: 'plan',
        approval_step: 'approve_weekly_plan',
        workflow_step_id: 'approve_stage_2',
        prompt: 'Approve strategy?',
        resume_token: 'hermes-resume-strategy',
      },
    });
    const duplicateResearchResult = await handleHermesRunCallback({
      event_id: 'evt-research',
      aries_run_id: researchRun.aries_run_id,
      hermes_run_id: 'hermes-research-1',
      status: 'requires_approval',
      stage: 'planning',
      output: [{ run_id: 'research-run-1', summary: 'Research complete' }],
      approval: {
        stage: 'plan',
        approval_step: 'approve_weekly_plan',
        workflow_step_id: 'approve_stage_2',
        prompt: 'Approve strategy?',
        resume_token: 'hermes-resume-strategy',
      },
    });

    assert.deepEqual(researchResult, {
      status: 'accepted',
      ariesRunId: researchRun.aries_run_id,
      duplicate: false,
    });
    assert.deepEqual(duplicateResearchResult, {
      status: 'accepted',
      ariesRunId: researchRun.aries_run_id,
      duplicate: true,
    });

    const afterResearch = await loadMarketingJobRuntime(doc.job_id);
    assert.equal(afterResearch?.stages.research.status, 'completed');
    assert.equal(afterResearch?.approvals.current?.stage, 'strategy');
    assert.equal(afterResearch?.approvals.current?.workflow_step_id, 'approve_stage_2');
    assert.equal(afterResearch?.approvals.current?.resume_token, 'hermes-resume-strategy');
    assert.equal(afterResearch?.social_content_runtime?.currentStage, 'plan_review');
    assert.equal(
      (afterResearch?.social_content_runtime as { stages?: Record<string, { status?: string }> } | undefined)
        ?.stages?.planning?.status,
      'completed',
    );
    assert.equal(
      (afterResearch?.social_content_runtime as { stages?: Record<string, { status?: string }> } | undefined)
        ?.stages?.plan_review?.status,
      'awaiting_approval',
    );

    const strategyApproval = loadMarketingApprovalRecord(afterResearch?.approvals.current?.approval_id ?? '');
    assert.equal(strategyApproval?.execution_provider, 'hermes');
    assert.equal(strategyApproval?.execution_resume_token, 'hermes-resume-strategy');
    assert.equal(strategyApproval?.lobster_resume_token, undefined);
    assert.equal(strategyApproval?.social_content_approval_step, 'approve_weekly_plan');
    assert.equal(listMarketingApprovalRecordsForJob(doc.job_id).length, 1);

    await handleHermesRunCallback({
      event_id: 'evt-research-running-late',
      aries_run_id: researchRun.aries_run_id,
      hermes_run_id: 'hermes-research-1',
      status: 'running',
      stage: 'research',
      output: [{ run_id: 'research-run-1', summary: 'Late running callback should be ignored' }],
    });

    const afterLateRunning = await loadMarketingJobRuntime(doc.job_id);
    assert.equal(afterLateRunning?.stages.research.status, 'completed');
    assert.equal(afterLateRunning?.social_content_runtime?.currentStage, 'plan_review');

    const publishRun = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'marketing',
      workflowKey: 'social_content_weekly',
      action: 'resume',
      tenantId: doc.tenant_id,
      marketingJobId: doc.job_id,
      stage: 'publish',
      workflowStepId: 'approve_stage_4_publish',
      approvalId: afterResearch?.approvals.current?.approval_id,
    });

    await handleHermesRunCallback({
      event_id: 'evt-publish',
      aries_run_id: publishRun.aries_run_id,
      hermes_run_id: 'hermes-publish-1',
      status: 'completed',
      stage: 'publish_review',
      output: [{ run_id: 'publish-run-1', summary: 'Published' }],
    });

    const afterPublish = await loadMarketingJobRuntime(doc.job_id);
    assert.equal(afterPublish?.stages.publish.status, 'completed');
    assert.equal(afterPublish?.state, 'completed');
    assert.equal(afterPublish?.status, 'completed');
    assert.equal(afterPublish?.approvals.current, null);
    assert.equal(afterPublish?.social_content_runtime?.currentStage, 'completed');
    assert.equal(
      (afterPublish?.social_content_runtime as { stages?: Record<string, { status?: string }> } | undefined)
        ?.stages?.completed?.status,
      'completed',
    );

    await handleHermesRunCallback({
      event_id: 'evt-publish-failed-late',
      aries_run_id: publishRun.aries_run_id,
      hermes_run_id: 'hermes-publish-1',
      status: 'failed',
      stage: 'publish_review',
      error: {
        code: 'late_failure',
        message: 'Late failure should not regress completed runtime state.',
      },
    });
    const afterLateFailure = await loadMarketingJobRuntime(doc.job_id);
    assert.equal(afterLateFailure?.state, 'completed');
    assert.equal(afterLateFailure?.status, 'completed');
    assert.equal(afterLateFailure?.stages.publish.status, 'completed');
    assert.equal(afterLateFailure?.last_error, null);
    assert.equal(afterLateFailure?.social_content_runtime?.currentStage, 'completed');

    await handleHermesRunCallback({
      event_id: 'evt-publish-cancelled-late',
      aries_run_id: publishRun.aries_run_id,
      hermes_run_id: 'hermes-publish-1',
      status: 'cancelled',
      stage: 'publish_review',
      error: {
        code: 'late_cancelled',
        message: 'Late cancellation should not regress completed runtime state.',
      },
    });
    const afterLateCancellation = await loadMarketingJobRuntime(doc.job_id);
    assert.equal(afterLateCancellation?.state, 'completed');
    assert.equal(afterLateCancellation?.status, 'completed');
    assert.equal(afterLateCancellation?.stages.publish.status, 'completed');
    assert.equal(afterLateCancellation?.last_error, null);
    assert.equal(afterLateCancellation?.social_content_runtime?.currentStage, 'completed');
  });
});

test('execution run records ignore late terminal callbacks after completion', async () => {
  await withRuntimeEnv(async () => {
    const { createExecutionRunRecord, loadExecutionRunRecord } = await import('../backend/execution/run-store');
    const { handleHermesRunCallback } = await import('../backend/execution/hermes-callbacks');

    const run = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'route',
      workflowKey: 'demo_start',
      action: 'run',
      tenantId: 'tenant-terminal',
    });

    await handleHermesRunCallback({
      event_id: 'evt-run-completed',
      aries_run_id: run.aries_run_id,
      hermes_run_id: 'hermes-terminal-1',
      status: 'completed',
      output: [{ ok: true }],
    });

    const completed = loadExecutionRunRecord(run.aries_run_id);
    assert.equal(completed?.status, 'completed');
    assert.deepEqual(completed?.result, [{ ok: true }]);
    assert.equal(completed?.last_error, null);

    await handleHermesRunCallback({
      event_id: 'evt-run-failed-late',
      aries_run_id: run.aries_run_id,
      hermes_run_id: 'hermes-terminal-1',
      status: 'failed',
      output: [{ ok: false }],
      error: {
        code: 'late_failed',
        message: 'Late failure should not mutate completed run.',
      },
    });

    const afterLateFailed = loadExecutionRunRecord(run.aries_run_id);
    assert.equal(afterLateFailed?.status, 'completed');
    assert.deepEqual(afterLateFailed?.result, [{ ok: true }]);
    assert.equal(afterLateFailed?.last_error, null);

    await handleHermesRunCallback({
      event_id: 'evt-run-cancelled-late',
      aries_run_id: run.aries_run_id,
      hermes_run_id: 'hermes-terminal-1',
      status: 'cancelled',
      output: [{ ok: 'cancelled' }],
      error: {
        code: 'late_cancelled',
        message: 'Late cancellation should not mutate completed run.',
      },
    });

    const afterLateCancelled = loadExecutionRunRecord(run.aries_run_id);
    assert.equal(afterLateCancelled?.status, 'completed');
    assert.deepEqual(afterLateCancelled?.result, [{ ok: true }]);
    assert.equal(afterLateCancelled?.last_error, null);
    assert.deepEqual(afterLateCancelled?.event_ids, [
      'evt-run-completed',
      'evt-run-failed-late',
      'evt-run-cancelled-late',
    ]);
  });
});
