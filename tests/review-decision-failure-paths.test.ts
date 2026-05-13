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
  const previousMarketingProvider = process.env.ARIES_MARKETING_EXECUTION_PROVIDER;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-review-failure-'));

  process.env.CODE_ROOT = PROJECT_ROOT;
  process.env.DATA_ROOT = dataRoot;
  process.env.OPENCLAW_LOBSTER_CWD = path.join(PROJECT_ROOT, 'lobster');
  process.env.ARIES_MARKETING_EXECUTION_PROVIDER = 'legacy-openclaw';
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
    if (previousMarketingProvider === undefined) {
      delete process.env.ARIES_MARKETING_EXECUTION_PROVIDER;
    } else {
      process.env.ARIES_MARKETING_EXECUTION_PROVIDER = previousMarketingProvider;
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

function cannedRunResponse(): Record<string, unknown> {
  return {
    ok: true,
    status: 'needs_approval',
    output: [{ run_id: 'run-research' }],
    requiresApproval: { resumeToken: 'resume_strategy', prompt: 'Approve strategy.' },
  };
}

function cannedResumeResponse(token: string): Record<string, unknown> | null {
  if (token === 'resume_strategy') {
    return {
      ok: true,
      status: 'needs_approval',
      output: [{
        run_id: 'run-strategy',
        strategy_handoff: {
          run_id: 'run-strategy',
          core_message: 'Launch campaigns.',
          primary_cta: 'Book a walkthrough',
        },
      }],
      requiresApproval: { resumeToken: 'resume_production', prompt: 'Approve production.' },
    };
  }
  if (token === 'resume_production') {
    return {
      ok: true,
      status: 'needs_approval',
      output: [{
        run_id: 'run-production',
        production_handoff: {
          run_id: 'run-production',
          production_brief: { core_message: 'Launch campaigns.' },
          contract_handoffs: {
            static: { platform_contract_paths: ['output/static/meta-ads.json'] },
            video: { platform_contract_paths: ['output/video/tiktok.json'] },
          },
        },
      }],
      requiresApproval: { resumeToken: 'resume_publish_review', prompt: 'Approve launch review.' },
    };
  }
  if (token === 'resume_publish_review') {
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
  return null;
}

test('recordMarketingReviewDecision: gateway throws on resume => structured error, no uncaught exception', async () => {
  await withRuntimeEnv(async () => {
    setInvoker((payload) => {
      const args = (payload.args as Record<string, unknown> | undefined) ?? {};
      const action = String(args.action || '');
      const token = String(args.token || '');

      if (action === 'run') return cannedRunResponse();

      const response = cannedResumeResponse(token);
      if (response) return response;

      // Simulate hermes_unreachable on the final paused-publish resume
      throw new Error('hermes_unreachable');
    });

    try {
      const { startMarketingJob } = await import('../backend/marketing/jobs-start');
      const { approveMarketingJob } = await import('../backend/marketing/jobs-approve');
      const { listMarketingApprovalRecordsForJob, loadMarketingApprovalRecord } = await import('../backend/marketing/approval-store');
      const { RuntimeReviewDecisionError, recordMarketingReviewDecision } = await import('../backend/marketing/runtime-views');

      const tenantId = 'tenant-failure-path';
      const started = await startMarketingJob({
        tenantId,
        jobType: 'brand_campaign',
        payload: { brandUrl: 'https://brand.example', businessType: 'Test vertical', competitorUrl: 'https://betterup.com' },
      });

      const advance = async (stepId: string, stage: 'strategy' | 'production' | 'publish') => {
        const records = listMarketingApprovalRecordsForJob(started.jobId);
        const approvalId = records.find((r) => r.workflow_step_id === stepId)?.approval_id;
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
      const pausedPublishId = records.find((r) => r.workflow_step_id === 'approve_stage_4_publish')?.approval_id;
      assert.equal(typeof pausedPublishId, 'string', 'expected approve_stage_4_publish checkpoint to exist');

      const reviewId = `${started.jobId}::approval`;

      // This must NOT throw — the gateway error should be caught and mapped to
      // a RuntimeReviewDecisionError rather than propagating as an unhandled exception.
      let caughtError: unknown = null;
      try {
        await recordMarketingReviewDecision({
          tenantId,
          reviewId,
          action: 'approve',
          actedBy: 'Client reviewer',
          note: '',
          approvalId: pausedPublishId,
        });
      } catch (err) {
        caughtError = err;
      }

      assert.ok(
        caughtError instanceof RuntimeReviewDecisionError,
        `expected RuntimeReviewDecisionError, got: ${caughtError instanceof Error ? caughtError.message : String(caughtError)}`,
      );
      const decisionError = caughtError as InstanceType<typeof RuntimeReviewDecisionError>;
      assert.equal(
        decisionError.status < 500,
        true,
        `expected 4xx status code, got ${decisionError.status}`,
      );

      // The approval record should be marked failed (not left in pending/in-progress)
      assert.ok(typeof pausedPublishId === 'string');
      const failedRecord = loadMarketingApprovalRecord(pausedPublishId);
      assert.ok(failedRecord, 'approval record should still exist after failure');
      assert.equal(
        failedRecord.status,
        'failed',
        `expected approval record status=failed, got ${failedRecord.status}`,
      );
    } finally {
      clearInvoker();
    }
  });
});
