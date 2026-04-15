import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { installBrandExampleFetchMock } from './helpers/brand-example-fetch';
import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

type LobsterInvoker = (payload: Record<string, unknown>) => unknown | Promise<unknown>;

async function withRuntimeEnv<T>(run: (dataRoot: string) => Promise<T>): Promise<T> {
  const previousCodeRoot = process.env.CODE_ROOT;
  const previousDataRoot = process.env.DATA_ROOT;
  const previousOpenClawLobsterCwd = process.env.OPENCLAW_LOBSTER_CWD;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-review-idempotency-'));

  process.env.CODE_ROOT = PROJECT_ROOT;
  process.env.DATA_ROOT = dataRoot;
  process.env.OPENCLAW_LOBSTER_CWD = path.join(PROJECT_ROOT, 'lobster');
  const restoreFetch = installBrandExampleFetchMock();

  try {
    return await run(dataRoot);
  } finally {
    restoreFetch();
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

function setInvoker(impl: LobsterInvoker): void {
  (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__ = impl;
}

function clearInvoker(): void {
  delete (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__;
}

function cannedGatewayResponse(action: string, token: string): Record<string, unknown> | null {
  if (action === 'run') {
    return {
      ok: true,
      status: 'needs_approval',
      output: [{ run_id: 'run-research' }],
      requiresApproval: { resumeToken: 'resume_strategy', prompt: 'Approve strategy.' },
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
      requiresApproval: { resumeToken: 'resume_production', prompt: 'Approve production.' },
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
          production_brief: { core_message: 'Launch campaigns with operator control.' },
          contract_handoffs: {
            static: { platform_contract_paths: ['output/static/meta-ads.json'] },
            video: { platform_contract_paths: ['output/video/tiktok.json'] },
          },
        },
      }],
      requiresApproval: { resumeToken: 'resume_publish_review', prompt: 'Approve launch review.' },
    };
  }
  if (action === 'resume' && token === 'resume_publish_review') {
    return {
      ok: true,
      status: 'needs_approval',
      output: [{ run_id: 'run-publish-review', review_bundle: { campaign_name: 'Stage 4 launch review' } }],
      requiresApproval: {
        resumeToken: 'resume_publish_paused',
        prompt: 'Approve Meta campaign creation as paused.',
      },
    };
  }
  if (action === 'resume' && token === 'resume_publish_paused') {
    return {
      ok: true,
      status: 'ok',
      output: [{
        run_id: 'run-publish-paused',
        summary: { message: 'Paused ads created.' },
      }],
      requiresApproval: null,
    };
  }
  return null;
}

test('approve_stage_4_publish: duplicate recordMarketingReviewDecision does not re-invoke gateway resume', async () => {
  await withRuntimeEnv(async () => {
    const calls: Array<{ action: string; token: string }> = [];
    setInvoker((payload) => {
      const args = (payload.args as Record<string, unknown> | undefined) ?? {};
      const action = String(args.action || '');
      const token = String(args.token || '');
      calls.push({ action, token });
      const response = cannedGatewayResponse(action, token);
      if (!response) {
        throw new Error(`Unexpected OpenClaw invocation: action=${action} token=${token}`);
      }
      return response;
    });

    try {
      const { startMarketingJob } = await import('../backend/marketing/jobs-start');
      const { approveMarketingJob } = await import('../backend/marketing/jobs-approve');
      const { listMarketingApprovalRecordsForJob } = await import('../backend/marketing/approval-store');
      const { recordMarketingReviewDecision } = await import('../backend/marketing/runtime-views');

      const tenantId = 'tenant-bug-a-publish';
      const started = await startMarketingJob({
        tenantId,
        jobType: 'brand_campaign',
        payload: { brandUrl: 'https://brand.example', competitorUrl: 'https://betterup.com' },
      });

      const advance = async (stepId: string, stage: 'strategy' | 'production' | 'publish') => {
        const records = listMarketingApprovalRecordsForJob(started.jobId);
        const approvalId = records.find((record) => record.workflow_step_id === stepId)?.approval_id;
        assert.equal(typeof approvalId, 'string', `missing approval record for ${stepId}`);
        const result = await approveMarketingJob({
          jobId: started.jobId,
          tenantId,
          approvedBy: 'operator',
          approvedStages: [stage],
          approvalId,
        });
        assert.equal(result.status, 'resumed', `${stepId} did not resume: ${result.reason}`);
      };

      await advance('approve_stage_2', 'strategy');
      await advance('approve_stage_3', 'production');
      await advance('approve_stage_4', 'publish');

      const records = listMarketingApprovalRecordsForJob(started.jobId);
      const pausedPublishId = records.find((record) => record.workflow_step_id === 'approve_stage_4_publish')?.approval_id;
      assert.equal(typeof pausedPublishId, 'string', 'expected approve_stage_4_publish checkpoint to exist');

      const countResumeToken = (token: string) =>
        calls.filter((entry) => entry.action === 'resume' && entry.token === token).length;
      assert.equal(countResumeToken('resume_publish_paused'), 0, 'resume_publish_paused should not have run yet');

      const reviewId = `${started.jobId}::approval`;
      const firstDecision = await recordMarketingReviewDecision({
        tenantId,
        reviewId,
        action: 'approve',
        actedBy: 'Client reviewer',
        note: '',
        approvalId: pausedPublishId,
      });
      assert.ok(firstDecision, 'first decision should return a review item');

      const secondDecision = await recordMarketingReviewDecision({
        tenantId,
        reviewId,
        action: 'approve',
        actedBy: 'Client reviewer',
        note: '',
        approvalId: pausedPublishId,
      });
      assert.ok(secondDecision, 'duplicate decision should still return a review item, not null');

      assert.equal(
        countResumeToken('resume_publish_paused'),
        1,
        'duplicate recordMarketingReviewDecision must not re-invoke the paused-publish resume',
      );

      const finalRecords = listMarketingApprovalRecordsForJob(started.jobId);
      const finalPausedPublish = finalRecords.find((record) => record.approval_id === pausedPublishId);
      assert.ok(finalPausedPublish, 'paused-publish record should still exist');
      assert.ok(
        finalPausedPublish.status === 'approved' || finalPausedPublish.status === 'consumed',
        `expected terminal status, got ${finalPausedPublish.status}`,
      );
    } finally {
      clearInvoker();
    }
  });
});
