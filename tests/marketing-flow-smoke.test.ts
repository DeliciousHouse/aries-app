import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

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
  const previousOpenClawLobsterCwd = process.env.OPENCLAW_LOBSTER_CWD;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-verify-marketing-'));

  process.env.CODE_ROOT = PROJECT_ROOT;
  process.env.DATA_ROOT = dataRoot;
  process.env.OPENCLAW_LOBSTER_CWD = path.join(PROJECT_ROOT, 'lobster');

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

    if (previousOpenClawLobsterCwd === undefined) {
      delete process.env.OPENCLAW_LOBSTER_CWD;
    } else {
      process.env.OPENCLAW_LOBSTER_CWD = previousOpenClawLobsterCwd;
    }

    await rm(dataRoot, { recursive: true, force: true });
  }
}

test('targeted marketing verification covers create, inspect, approve, and publish-ready completion', async () => {
  await withMarketingRuntimeEnv(async (dataRoot) => {
    const { startMarketingJob } = await import('../backend/marketing/orchestrator');
    const { getMarketingJobStatus } = await import('../backend/marketing/jobs-status');
    const { approveMarketingJob } = await import('../backend/marketing/orchestrator');
    const { loadMarketingJobRuntime } = await import('../backend/marketing/runtime-state');

    const actions: string[] = [];
    const resumeTokens: string[] = [];
    let startPayload: Record<string, unknown> | null = null;

    setOpenClawTestInvoker((payload) => {
      const args = (payload.args as Record<string, unknown> | undefined) ?? {};
      const action = String(args.action || '');
      actions.push(action);

      if (action === 'run') {
        startPayload = payload;
        return {
          ok: true,
          status: 'needs_approval',
          output: [{
            run_id: 'verify-flow-run',
            executive_summary: {
              market_positioning: 'Proof-led competitive research is complete.',
              campaign_takeaway: 'Outcome-first hooks are strongest.',
            },
          }],
          requiresApproval: {
            resumeToken: 'resume_strategy',
            prompt: 'Stage 1 complete. Continue to strategy?',
          },
        };
      }

      if (action === 'resume') {
        const token = String(args.token || '');
        resumeTokens.push(token);

        if (token === 'resume_strategy') {
          return {
            ok: true,
            status: 'needs_approval',
            output: [{
              run_id: 'verify-flow-run',
              strategy_handoff: {
                run_id: 'verify-flow-run',
                core_message: 'Launch campaigns with operator control.',
                primary_cta: 'Book a walkthrough',
              },
            }],
            requiresApproval: {
              resumeToken: 'resume_production',
              prompt: 'Stage 2 complete. Continue to production?',
            },
          };
        }

        if (token === 'resume_production') {
          return {
            ok: true,
            status: 'needs_approval',
            output: [{
              run_id: 'verify-flow-run',
              production_handoff: {
                run_id: 'verify-flow-run',
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
              resumeToken: 'resume_publish',
              prompt: 'Stage 3 complete. Continue to publish?',
            },
          };
        }

        if (token === 'resume_publish') {
          return {
            ok: true,
            status: 'ok',
            output: [{
              run_id: 'verify-flow-run',
              summary: { message: 'Selected platform packages are ready.' },
            }],
            requiresApproval: null,
          };
        }
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
    assert.equal((startPayload as any)?.args?.action, 'run');
    assert.equal((startPayload as any)?.args?.pipeline, 'marketing-pipeline.lobster');
    assert.equal((startPayload as any)?.args?.cwd, 'lobster');

    const statusBeforeApproval = getMarketingJobStatus(startResult.jobId);
    assert.equal(statusBeforeApproval.state, 'approval_required');
    assert.equal(statusBeforeApproval.status, 'awaiting_approval');
    assert.equal(statusBeforeApproval.currentStage, 'strategy');
    assert.equal(statusBeforeApproval.stageStatus.strategy, 'awaiting_approval');
    assert.equal(statusBeforeApproval.approvalRequired, true);
    assert.equal(statusBeforeApproval.approval?.required, true);

    const doc1 = loadMarketingJobRuntime(startResult.jobId)!;
    const strategyApproval = await approveMarketingJob({
      jobId: startResult.jobId,
      tenantId: 'tenant_verify',
      approvedBy: 'verify-runner',
      approvedStages: ['strategy'],
    }, doc1);
    assert.equal(strategyApproval.status, 'resumed');
    assert.equal(strategyApproval.resumedStage, 'production');
    assert.equal(strategyApproval.completed, false);

    const doc2 = loadMarketingJobRuntime(startResult.jobId)!;
    const productionApproval = await approveMarketingJob({
      jobId: startResult.jobId,
      tenantId: 'tenant_verify',
      approvedBy: 'verify-runner',
      approvedStages: ['production'],
    }, doc2);
    assert.equal(productionApproval.status, 'resumed');
    assert.equal(productionApproval.resumedStage, 'publish');
    assert.equal(productionApproval.completed, false);

    const doc3 = loadMarketingJobRuntime(startResult.jobId)!;
    const approvalResult = await approveMarketingJob({
      jobId: startResult.jobId,
      tenantId: 'tenant_verify',
      approvedBy: 'verify-runner',
      approvedStages: ['publish'],
      resumePublishIfNeeded: true,
    }, doc3);


    assert.equal(approvalResult.status, 'resumed');
    assert.equal(approvalResult.resumedStage, 'publish');
    assert.equal(approvalResult.completed, true);
    assert.deepEqual(actions, ['run', 'resume', 'resume', 'resume']);
    assert.deepEqual(resumeTokens, ['resume_strategy', 'resume_production', 'resume_publish']);

    const statusAfterApproval = getMarketingJobStatus(startResult.jobId);
    assert.equal(statusAfterApproval.state, 'completed');
    assert.equal(statusAfterApproval.status, 'completed');
    assert.equal(statusAfterApproval.stageStatus.publish, 'completed');
    assert.equal(statusAfterApproval.approvalRequired, false);

    const runtimeFile = path.join(dataRoot, startResult.runtimeArtifactPath);
    const runtimeDoc = JSON.parse(await readFile(runtimeFile, 'utf8')) as Record<string, any>;

    assert.equal(runtimeDoc.state, 'completed');
    assert.equal(runtimeDoc.status, 'completed');
    assert.equal(runtimeDoc.stages.publish.status, 'completed');
    assert.equal(runtimeDoc.approvals.current, null);
  });
});
