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
      workflowKey: 'marketing_pipeline',
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
      output: [{ run_id: 'research-run-1', summary: 'Research complete' }],
      approval: {
        stage: 'strategy',
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
      output: [{ run_id: 'research-run-1', summary: 'Research complete' }],
      approval: {
        stage: 'strategy',
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

    const strategyApproval = loadMarketingApprovalRecord(afterResearch?.approvals.current?.approval_id ?? '');
    assert.equal(strategyApproval?.execution_provider, 'hermes');
    assert.equal(strategyApproval?.execution_resume_token, 'hermes-resume-strategy');
    assert.equal(strategyApproval?.lobster_resume_token, undefined);
    assert.equal(listMarketingApprovalRecordsForJob(doc.job_id).length, 1);

    const publishRun = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'marketing',
      workflowKey: 'marketing_pipeline',
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
      output: [{ run_id: 'publish-run-1', summary: 'Published' }],
    });

    const afterPublish = await loadMarketingJobRuntime(doc.job_id);
    assert.equal(afterPublish?.stages.publish.status, 'completed');
    assert.equal(afterPublish?.state, 'completed');
    assert.equal(afterPublish?.status, 'completed');
    assert.equal(afterPublish?.approvals.current, null);
  });
});
