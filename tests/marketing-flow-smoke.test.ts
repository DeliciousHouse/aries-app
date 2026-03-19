import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { startMarketingJob } from '../backend/marketing/jobs-start';
import { getMarketingJobStatus } from '../backend/marketing/jobs-status';
import { approveMarketingJob } from '../backend/marketing/jobs-approve';

function setOpenClawTestInvoker(
  impl: (payload: Record<string, unknown>) => unknown | Promise<unknown>
): void {
  (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__ = impl;
}

function clearOpenClawTestInvoker(): void {
  delete (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__;
}

async function withMarketingRuntimeEnv<T>(run: (dataRoot: string) => Promise<T>): Promise<T> {
  const previousCodeRoot = process.env.CODE_ROOT;
  const previousDataRoot = process.env.DATA_ROOT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-verify-marketing-'));

  process.env.CODE_ROOT = process.cwd();
  process.env.DATA_ROOT = dataRoot;

  try {
    return await run(dataRoot);
  } finally {
    clearOpenClawTestInvoker();

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

    await rm(dataRoot, { recursive: true, force: true });
  }
}

test('targeted marketing verification covers create, inspect, approve, and publish-ready completion', async () => {
  await withMarketingRuntimeEnv(async (dataRoot) => {
    let invocationCount = 0;
    let capturedResumePayload: Record<string, unknown> | null = null;

    setOpenClawTestInvoker((payload) => {
      invocationCount += 1;
      const action = (payload.args as Record<string, unknown> | undefined)?.action;

      if (action === 'run') {
        return {
          ok: true,
          status: 'ok',
          output: [{
            run_id: 'verify-flow-run',
            approval_preview: {
              status: 'pending_human_review',
              message: 'Approval needed before publish-ready assets are generated.',
            },
          }],
          requiresApproval: { resumeToken: 'resume_verify_flow' },
        };
      }

      if (action === 'resume') {
        capturedResumePayload = payload;
        return {
          ok: true,
          status: 'ok',
          output: [{
            run_id: 'verify-flow-run',
            summary: {
              message: 'Publish packages ready.',
            },
          }],
          requiresApproval: null,
        };
      }

      throw new Error(`Unexpected OpenClaw action: ${String(action)}`);
    });

    const startResult = await startMarketingJob({
      tenantId: 'tenant_verify',
      jobType: 'brand_campaign',
      payload: {
        brandUrl: 'https://brand.example',
        competitorUrl: 'https://facebook.com/competitor',
      },
    });

    assert.equal(startResult.status, 'accepted');
    assert.equal(startResult.approvalRequired, true);

    const statusBeforeApproval = getMarketingJobStatus(startResult.jobId);
    assert.equal(statusBeforeApproval.state, 'approval_required');
    assert.equal(statusBeforeApproval.status, 'awaiting_approval');
    assert.equal(statusBeforeApproval.currentStage, 'publish');
    assert.equal(statusBeforeApproval.stageStatus.publish, 'awaiting_approval');
    assert.equal(statusBeforeApproval.approvalRequired, true);

    const approvalResult = await approveMarketingJob({
      jobId: startResult.jobId,
      tenantId: 'tenant_verify',
      approvedBy: 'verify-runner',
      approvedStages: ['publish'],
      resumePublishIfNeeded: true,
    });

    assert.equal(approvalResult.status, 'resumed');
    assert.equal(approvalResult.resumedStage, 'publish');
    assert.equal(approvalResult.completed, true);
    assert.equal((capturedResumePayload as any)?.args?.action, 'resume');
    assert.equal((capturedResumePayload as any)?.args?.token, 'resume_verify_flow');

    const statusAfterApproval = getMarketingJobStatus(startResult.jobId);
    assert.equal(statusAfterApproval.state, 'completed');
    assert.equal(statusAfterApproval.status, 'completed');
    assert.equal(statusAfterApproval.stageStatus.publish, 'completed');
    assert.equal(statusAfterApproval.approvalRequired, false);

    const runtimeFile = path.join(dataRoot, startResult.runtimeArtifactPath);
    const runtimeDoc = JSON.parse(await readFile(runtimeFile, 'utf8')) as Record<string, any>;

    assert.equal(runtimeDoc.state, 'completed');
    assert.equal(runtimeDoc.status, 'completed');
    assert.equal(runtimeDoc.outputs?.stage_status?.publish, 'completed');
    assert.equal(runtimeDoc.outputs?.openclaw?.resume_token, null);
    assert.equal(invocationCount, 2);
  });
});
