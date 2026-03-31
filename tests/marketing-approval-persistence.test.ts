import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

async function withRuntimeEnv<T>(run: (dataRoot: string) => Promise<T>): Promise<T> {
  const previousCodeRoot = process.env.CODE_ROOT;
  const previousDataRoot = process.env.DATA_ROOT;
  const previousOpenClawLobsterCwd = process.env.OPENCLAW_LOBSTER_CWD;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-approval-persistence-'));

  process.env.CODE_ROOT = PROJECT_ROOT;
  process.env.DATA_ROOT = dataRoot;
  process.env.OPENCLAW_LOBSTER_CWD = path.join(PROJECT_ROOT, 'lobster');

  try {
    return await run(dataRoot);
  } finally {
    if (previousCodeRoot === undefined) {
      delete process.env.CODE_ROOT;
    } else {
      process.env.CODE_ROOT = previousCodeRoot;
    }

    if (previousDataRoot === undefined) {
      delete process.env.DATA_ROOT;
    } else {
      process.env.DATA_ROOT = previousDataRoot;
    }

    if (previousOpenClawLobsterCwd === undefined) {
      delete process.env.OPENCLAW_LOBSTER_CWD;
    } else {
      process.env.OPENCLAW_LOBSTER_CWD = previousOpenClawLobsterCwd;
    }

    await rm(dataRoot, { recursive: true, force: true });
  }
}

function setOpenClawTestInvoker(
  impl: (payload: Record<string, unknown>) => unknown | Promise<unknown>
): void {
  (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__ = impl;
}

function clearOpenClawTestInvoker(): void {
  delete (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__;
}

function fourCheckpointResponse(action: string, token: string): Record<string, unknown> | null {
  if (action === 'run') {
    return {
      ok: true,
      status: 'needs_approval',
      output: [{
        run_id: 'run-research',
        executive_summary: {
          market_positioning: 'Proof-led competitive research is complete.',
          campaign_takeaway: 'Outcome-first hooks are strongest.',
        },
      }],
      requiresApproval: {
        resumeToken: 'resume_strategy',
        prompt: 'Research complete. Approve strategy to continue.',
      },
    };
  }

  if (action === 'resume' && token === 'resume_strategy') {
    return {
      ok: true,
      status: 'needs_approval',
      output: [{
        run_id: 'run-strategy',
        strategy_handoff: {
          run_id: 'run-strategy',
          core_message: 'Launch campaigns with operator control.',
          primary_cta: 'Book a walkthrough',
        },
      }],
      requiresApproval: {
        resumeToken: 'resume_production',
        prompt: 'Strategy complete. Approve production to continue.',
      },
    };
  }

  if (action === 'resume' && token === 'resume_production') {
    return {
      ok: true,
      status: 'needs_approval',
      output: [{
        run_id: 'run-production',
        production_handoff: {
          run_id: 'run-production',
          production_brief: {
            core_message: 'Launch campaigns with operator control.',
          },
          contract_handoffs: {
            static: { platform_contract_paths: ['output/static/meta-ads.json'] },
            video: { platform_contract_paths: ['output/video/tiktok.json'] },
          },
        },
      }],
      requiresApproval: {
        resumeToken: 'resume_publish_review',
        prompt: 'Production complete. Approve launch review to continue.',
      },
    };
  }

  if (action === 'resume' && token === 'resume_publish_review') {
    return {
      ok: true,
      status: 'needs_approval',
      output: [{
        run_id: 'run-publish-review',
        review_bundle: {
          campaign_name: 'Stage 4 launch review',
        },
      }],
      requiresApproval: {
        resumeToken: 'resume_publish_paused',
        prompt: 'Stage 4 pre-flight complete. Approve creation of the Meta campaigns, ad sets, and ads as PAUSED.',
      },
    };
  }

  if (action === 'resume' && token === 'resume_publish_paused') {
    return {
      ok: true,
      status: 'ok',
      output: [{
        run_id: 'run-publish-paused',
        summary: {
          message: 'Selected platform packages were created as paused ads.',
        },
      }],
      requiresApproval: null,
    };
  }

  return null;
}

function installFourCheckpointInvoker(): void {
  setOpenClawTestInvoker((payload) => {
    const args = (payload.args as Record<string, unknown> | undefined) ?? {};
    const action = String(args.action || '');
    const token = String(args.token || '');
    const response = fourCheckpointResponse(action, token);
    if (response) {
      return response;
    }
    throw new Error(`Unexpected OpenClaw lobster invocation: action=${action} token=${token}`);
  });
}

test('marketing approval records persist to disk with workflow context and reload cleanly', async () => {
  await withRuntimeEnv(async () => {
    const { createMarketingApprovalRecord, saveMarketingApprovalRecord, loadMarketingApprovalRecord } =
      await import('../backend/marketing/approval-store');

    const record = createMarketingApprovalRecord({
      tenantId: 'tenant-persist',
      marketingJobId: 'mkt_persist_001',
      workflowName: 'marketing-pipeline',
      workflowStepId: 'approve_stage_2',
      marketingStage: 'strategy',
      lobsterResumeToken: 'resume_strategy',
      lobsterResumeStateKeys: ['workflow_resume_001'],
      approvalPrompt: 'Approve strategy to continue.',
      runtimeContext: {
        pipelinePath: path.join(PROJECT_ROOT, 'lobster', 'marketing-pipeline.lobster'),
        cwd: path.join(PROJECT_ROOT, 'lobster'),
        stateDir: '/home/node/.lobster',
        sessionKey: 'main',
        gatewayUrl: 'http://gateway.example.test',
      },
    });

    const filePath = saveMarketingApprovalRecord(record);
    const reloaded = loadMarketingApprovalRecord(record.approval_id);
    const raw = JSON.parse(await readFile(filePath, 'utf8')) as any;

    assert.equal(!!reloaded, true);
    assert.equal(reloaded?.status, 'pending');
    assert.equal(reloaded?.workflow_step_id, 'approve_stage_2');
    assert.equal(reloaded?.runtime_context.state_dir, '/home/node/.lobster');
    assert.equal(raw.workflow_name, 'marketing-pipeline');
    assert.equal(raw.lobster_resume_token, 'resume_strategy');
    assert.equal(raw.attempt_count, 0);
  });
});

test('duplicate approval clicks return already_resolved after the checkpoint is consumed once', async () => {
  await withRuntimeEnv(async () => {
    installFourCheckpointInvoker();
    const { startMarketingJob } = await import('../backend/marketing/jobs-start');
    const { approveMarketingJob } = await import('../backend/marketing/jobs-approve');
    const { listMarketingApprovalRecordsForJob } = await import('../backend/marketing/approval-store');

    const started = await startMarketingJob({
      tenantId: 'tenant-idempotent',
      jobType: 'brand_campaign',
      payload: {
        brandUrl: 'https://brand.example',
        competitorUrl: 'https://facebook.com/competitor',
      },
    });

    const approvalsBefore = listMarketingApprovalRecordsForJob(started.jobId);
    const strategyApprovalId = approvalsBefore[0]?.approval_id;
    assert.equal(!!strategyApprovalId, true);

    const first = await approveMarketingJob({
      jobId: started.jobId,
      tenantId: 'tenant-idempotent',
      approvedBy: 'operator',
      approvedStages: ['strategy'],
      approvalId: strategyApprovalId,
    });

    const second = await approveMarketingJob({
      jobId: started.jobId,
      tenantId: 'tenant-idempotent',
      approvedBy: 'operator',
      approvedStages: ['strategy'],
      approvalId: strategyApprovalId,
    });

    assert.equal(first.status, 'resumed');
    assert.equal(second.status, 'already_resolved');
    assert.equal(second.reason, 'already_resolved');
    clearOpenClawTestInvoker();
  });
});

test('approving the paused-publish checkpoint clears the active approval while the long-running publish is still in progress', async () => {
  await withRuntimeEnv(async (dataRoot) => {
    let resolvePausedPublish: ((value: Record<string, unknown>) => void) | null = null;
    setOpenClawTestInvoker((payload) => {
      const args = (payload.args as Record<string, unknown> | undefined) ?? {};
      const action = String(args.action || '');
      const token = String(args.token || '');

      if (action === 'resume' && token === 'resume_publish_paused') {
        return new Promise((resolve) => {
          resolvePausedPublish = resolve as (value: Record<string, unknown>) => void;
        });
      }

      const response = fourCheckpointResponse(action, token);
      if (response) {
        return response;
      }
      throw new Error(`Unexpected OpenClaw lobster invocation: action=${action} token=${token}`);
    });

    const { startMarketingJob } = await import('../backend/marketing/jobs-start');
    const { approveMarketingJob } = await import('../backend/marketing/jobs-approve');
    const { listMarketingApprovalRecordsForJob } = await import('../backend/marketing/approval-store');

    const started = await startMarketingJob({
      tenantId: 'tenant-publish-processing',
      jobType: 'brand_campaign',
      payload: {
        brandUrl: 'https://brand.example',
        competitorUrl: 'https://facebook.com/competitor',
      },
    });

    const runtimeFile = path.join(dataRoot, 'generated', 'draft', 'marketing-jobs', `${started.jobId}.json`);

    let approvals = listMarketingApprovalRecordsForJob(started.jobId);
    await approveMarketingJob({
      jobId: started.jobId,
      tenantId: 'tenant-publish-processing',
      approvedBy: 'operator',
      approvedStages: ['strategy'],
      approvalId: approvals.find((record) => record.workflow_step_id === 'approve_stage_2')?.approval_id,
    });

    approvals = listMarketingApprovalRecordsForJob(started.jobId);
    await approveMarketingJob({
      jobId: started.jobId,
      tenantId: 'tenant-publish-processing',
      approvedBy: 'operator',
      approvedStages: ['production'],
      approvalId: approvals.find((record) => record.workflow_step_id === 'approve_stage_3')?.approval_id,
    });

    approvals = listMarketingApprovalRecordsForJob(started.jobId);
    await approveMarketingJob({
      jobId: started.jobId,
      tenantId: 'tenant-publish-processing',
      approvedBy: 'operator',
      approvedStages: ['publish'],
      approvalId: approvals.find((record) => record.workflow_step_id === 'approve_stage_4')?.approval_id,
    });

    approvals = listMarketingApprovalRecordsForJob(started.jobId);
    const pausedPublishApprovalId = approvals.find((record) => record.workflow_step_id === 'approve_stage_4_publish')?.approval_id;
    assert.equal(!!pausedPublishApprovalId, true);

    const finalApprovalPromise = approveMarketingJob({
      jobId: started.jobId,
      tenantId: 'tenant-publish-processing',
      approvedBy: 'operator',
      approvedStages: ['publish'],
      approvalId: pausedPublishApprovalId,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const inProgressDoc = JSON.parse(await readFile(runtimeFile, 'utf8')) as any;
    assert.equal(inProgressDoc.state, 'running');
    assert.equal(inProgressDoc.status, 'running');
    assert.equal(inProgressDoc.stages.publish.status, 'in_progress');
    assert.equal(inProgressDoc.approvals.current, null);

    const finishPausedPublish = resolvePausedPublish as ((value: Record<string, unknown>) => void) | null;
    if (!finishPausedPublish) {
      throw new Error('Expected paused publish resolver to be captured');
    }
    finishPausedPublish({
      ok: true,
      status: 'ok',
      output: [{
        run_id: 'run-publish-paused',
        summary: {
          message: 'Selected platform packages were created as paused ads.',
        },
      }],
      requiresApproval: null,
    });

    const finalResult = await finalApprovalPromise;
    const completedDoc = JSON.parse(await readFile(runtimeFile, 'utf8')) as any;

    assert.equal(finalResult.status, 'resumed');
    assert.equal(finalResult.completed, true);
    assert.equal(completedDoc.state, 'completed');
    assert.equal(completedDoc.status, 'completed');
    clearOpenClawTestInvoker();
  });
});

test('marketing pipeline persists every approval checkpoint through the paused-publish flow', async () => {
  await withRuntimeEnv(async () => {
    installFourCheckpointInvoker();
    const { startMarketingJob } = await import('../backend/marketing/jobs-start');
    const { approveMarketingJob } = await import('../backend/marketing/jobs-approve');
    const { listMarketingApprovalRecordsForJob } = await import('../backend/marketing/approval-store');

    const started = await startMarketingJob({
      tenantId: 'tenant-chain',
      jobType: 'brand_campaign',
      payload: {
        brandUrl: 'https://brand.example',
        competitorUrl: 'https://facebook.com/competitor',
      },
    });

    let records = listMarketingApprovalRecordsForJob(started.jobId);
    assert.deepEqual(records.map((record) => record.workflow_step_id), ['approve_stage_2']);

    await approveMarketingJob({
      jobId: started.jobId,
      tenantId: 'tenant-chain',
      approvedBy: 'operator',
      approvedStages: ['strategy'],
      approvalId: records[0].approval_id,
    });

    records = listMarketingApprovalRecordsForJob(started.jobId);
    assert.equal(records.some((record) => record.workflow_step_id === 'approve_stage_2' && record.status === 'approved'), true);
    assert.equal(records.some((record) => record.workflow_step_id === 'approve_stage_3' && record.status === 'pending'), true);

    await approveMarketingJob({
      jobId: started.jobId,
      tenantId: 'tenant-chain',
      approvedBy: 'operator',
      approvedStages: ['production'],
      approvalId: records.find((record) => record.workflow_step_id === 'approve_stage_3')?.approval_id,
    });

    records = listMarketingApprovalRecordsForJob(started.jobId);
    assert.equal(records.some((record) => record.workflow_step_id === 'approve_stage_4' && record.status === 'pending'), true);

    await approveMarketingJob({
      jobId: started.jobId,
      tenantId: 'tenant-chain',
      approvedBy: 'operator',
      approvedStages: ['publish'],
      approvalId: records.find((record) => record.workflow_step_id === 'approve_stage_4')?.approval_id,
      resumePublishIfNeeded: true,
    });

    records = listMarketingApprovalRecordsForJob(started.jobId);
    assert.equal(records.some((record) => record.workflow_step_id === 'approve_stage_4' && record.status === 'approved'), true);
    assert.equal(records.some((record) => record.workflow_step_id === 'approve_stage_4_publish' && record.status === 'pending'), true);

    await approveMarketingJob({
      jobId: started.jobId,
      tenantId: 'tenant-chain',
      approvedBy: 'operator',
      approvedStages: ['publish'],
      approvalId: records.find((record) => record.workflow_step_id === 'approve_stage_4_publish')?.approval_id,
      resumePublishIfNeeded: true,
    });

    records = listMarketingApprovalRecordsForJob(started.jobId);
    assert.equal(records.length, 4);
    assert.equal(records.every((record) => record.status === 'approved'), true);
    clearOpenClawTestInvoker();
  });
});

test('marketing workflow uses an extended gateway budget for long-running paused-publish resumes', async () => {
  await withRuntimeEnv(async () => {
    const capturedCalls: Array<{
      action: string;
      token: string;
      timeoutMs: number | null;
      maxStdoutBytes: number | null;
    }> = [];

    setOpenClawTestInvoker((payload) => {
      const args = (payload.args as Record<string, unknown> | undefined) ?? {};
      const action = String(args.action || '');
      const token = String(args.token || '');
      capturedCalls.push({
        action,
        token,
        timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : null,
        maxStdoutBytes: typeof args.maxStdoutBytes === 'number' ? args.maxStdoutBytes : null,
      });

      const response = fourCheckpointResponse(action, token);
      if (response) {
        return response;
      }

      throw new Error(`Unexpected OpenClaw lobster invocation: action=${action} token=${token}`);
    });

    const { startMarketingJob } = await import('../backend/marketing/jobs-start');
    const { approveMarketingJob } = await import('../backend/marketing/jobs-approve');
    const { listMarketingApprovalRecordsForJob } = await import('../backend/marketing/approval-store');

    const started = await startMarketingJob({
      tenantId: 'tenant-timeout-budget',
      jobType: 'brand_campaign',
      payload: {
        brandUrl: 'https://brand.example',
        competitorUrl: 'https://facebook.com/competitor',
      },
    });

    let records = listMarketingApprovalRecordsForJob(started.jobId);
    await approveMarketingJob({
      jobId: started.jobId,
      tenantId: 'tenant-timeout-budget',
      approvedBy: 'operator',
      approvedStages: ['strategy'],
      approvalId: records.find((record) => record.workflow_step_id === 'approve_stage_2')?.approval_id,
    });

    records = listMarketingApprovalRecordsForJob(started.jobId);
    await approveMarketingJob({
      jobId: started.jobId,
      tenantId: 'tenant-timeout-budget',
      approvedBy: 'operator',
      approvedStages: ['production'],
      approvalId: records.find((record) => record.workflow_step_id === 'approve_stage_3')?.approval_id,
    });

    records = listMarketingApprovalRecordsForJob(started.jobId);
    await approveMarketingJob({
      jobId: started.jobId,
      tenantId: 'tenant-timeout-budget',
      approvedBy: 'operator',
      approvedStages: ['publish'],
      approvalId: records.find((record) => record.workflow_step_id === 'approve_stage_4')?.approval_id,
      resumePublishIfNeeded: true,
    });

    records = listMarketingApprovalRecordsForJob(started.jobId);
    await approveMarketingJob({
      jobId: started.jobId,
      tenantId: 'tenant-timeout-budget',
      approvedBy: 'operator',
      approvedStages: ['publish'],
      approvalId: records.find((record) => record.workflow_step_id === 'approve_stage_4_publish')?.approval_id,
      resumePublishIfNeeded: true,
    });

    const initialRun = capturedCalls.find((call) => call.action === 'run');
    const pausedPublishResume = capturedCalls.find((call) => call.token === 'resume_publish_paused');

    assert.equal(initialRun?.timeoutMs, 15 * 60 * 1000);
    assert.equal(initialRun?.maxStdoutBytes, 8 * 1024 * 1024);
    assert.equal(pausedPublishResume?.timeoutMs, 15 * 60 * 1000);
    assert.equal(pausedPublishResume?.maxStdoutBytes, 8 * 1024 * 1024);
    clearOpenClawTestInvoker();
  });
});

test('denying a workflow checkpoint persists a denied approval record and clears the pending approval', async () => {
  await withRuntimeEnv(async () => {
    setOpenClawTestInvoker((payload) => {
      const args = (payload.args as Record<string, unknown> | undefined) ?? {};
      const action = String(args.action || '');

      if (action === 'run') {
        return {
          ok: true,
          status: 'needs_approval',
          output: [{
            run_id: 'run-research',
            executive_summary: {
              market_positioning: 'Proof-led competitive research is complete.',
              campaign_takeaway: 'Outcome-first hooks are strongest.',
            },
          }],
          requiresApproval: {
            resumeToken: 'resume_strategy',
            prompt: 'Research complete. Approve strategy to continue.',
          },
        };
      }

      if (action === 'resume') {
        assert.equal(args.approve, false);
        return {
          ok: true,
          status: 'cancelled',
          output: [],
          requiresApproval: null,
        };
      }

      throw new Error(`Unexpected OpenClaw lobster invocation: action=${action}`);
    });

    const { startMarketingJob, denyMarketingJob } = await import('../backend/marketing/orchestrator');
    const { loadMarketingJobRuntime } = await import('../backend/marketing/runtime-state');
    const { listMarketingApprovalRecordsForJob } = await import('../backend/marketing/approval-store');

    const started = await startMarketingJob({
      tenantId: 'tenant-deny',
      jobType: 'brand_campaign',
      payload: {
        brandUrl: 'https://brand.example',
        competitorUrl: 'https://facebook.com/competitor',
      },
    });

    const approvalId = listMarketingApprovalRecordsForJob(started.jobId)[0]?.approval_id;
    assert.equal(!!approvalId, true);

    const denied = await denyMarketingJob({
      jobId: started.jobId,
      tenantId: 'tenant-deny',
      deniedBy: 'operator',
      approvalId,
      note: 'Not ready yet.',
    }, loadMarketingJobRuntime(started.jobId)!);

    const runtimeDoc = loadMarketingJobRuntime(started.jobId);
    const records = listMarketingApprovalRecordsForJob(started.jobId);

    assert.equal(denied.status, 'denied');
    assert.equal(runtimeDoc?.approvals.current, null);
    assert.equal(runtimeDoc?.status, 'failed');
    assert.equal(records[0].status, 'denied');
    clearOpenClawTestInvoker();
  });
});
