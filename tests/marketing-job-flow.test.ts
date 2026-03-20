import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isValidElement } from 'react';

import MarketingNewJobPage from '../app/marketing/new-job/page';
import MarketingNewJobScreen from '../frontend/marketing/new-job';

async function loadStartMarketingJob() {
  const module = await import('../backend/marketing/jobs-start');
  return module.startMarketingJob;
}

async function withMarketingRuntimeEnv<T>(run: (dataRoot: string) => Promise<T>): Promise<T> {
  const previousCodeRoot = process.env.CODE_ROOT;
  const previousDataRoot = process.env.DATA_ROOT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-marketing-'));

  process.env.CODE_ROOT = process.cwd();
  process.env.DATA_ROOT = dataRoot;

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

function installMarketingPipelineInvoker(): void {
  setOpenClawTestInvoker((payload) => {
    const pipeline = String((payload as any)?.args?.pipeline || '');
    switch (pipeline) {
      case 'stage-1-research/workflow.lobster':
        return {
          ok: true,
          status: 'ok',
          output: [{
            run_id: 'run-research',
            executive_summary: {
              market_positioning: 'Proof-led competitive research is complete.',
              campaign_takeaway: 'Outcome-first hooks are strongest.',
            },
          }],
          requiresApproval: null,
        };
      case 'stage-2-strategy/review-workflow.lobster':
        return {
          ok: true,
          status: 'ok',
          output: [{
            run_id: 'run-strategy',
            approval_preview: {
              status: 'pending_human_review',
              message: 'Strategy review is ready for approval.',
            },
          }],
          requiresApproval: null,
        };
      case 'stage-2-strategy/finalize-workflow.lobster':
        return {
          ok: true,
          status: 'ok',
          output: [{
            run_id: 'run-strategy',
            strategy_handoff: {
              run_id: 'run-strategy',
              core_message: 'Launch campaigns with operator control.',
              primary_cta: 'Book a walkthrough',
            },
          }],
          requiresApproval: null,
        };
      case 'stage-3-production/review-workflow.lobster':
        return {
          ok: true,
          status: 'ok',
          output: [{
            run_id: 'run-production',
            approval_preview: {
              status: 'pending_human_review',
              message: 'Production review is ready for approval.',
            },
          }],
          requiresApproval: null,
        };
      case 'stage-3-production/finalize-workflow.lobster':
        return {
          ok: true,
          status: 'ok',
          output: [{
            run_id: 'run-production',
            production_handoff: {
              run_id: 'run-production',
              production_brief: {
                core_message: 'Launch campaigns with operator control.',
              },
              contract_handoffs: {
                static: {
                  platform_contract_paths: ['output/static/meta-ads.json'],
                },
                video: {
                  platform_contract_paths: ['output/video/tiktok.json'],
                },
              },
            },
          }],
          requiresApproval: null,
        };
      case 'stage-4-publish-optimize/review-workflow.lobster':
        return {
          ok: true,
          status: 'ok',
          output: [{
            run_id: 'run-publish',
            approval_preview: {
              status: 'pending_human_review',
              message: 'Launch approval is required before publishing.',
            },
          }],
          requiresApproval: null,
        };
      case 'stage-4-publish-optimize/publish-workflow.lobster':
        return {
          ok: true,
          status: 'ok',
          output: [{
            run_id: 'run-publish',
            summary: {
              message: 'Selected platform packages are ready.',
            },
          }],
          requiresApproval: null,
        };
      default:
        throw new Error(`Unexpected marketing pipeline ${pipeline}`);
    }
  });
}

test('/marketing/new-job uses the canonical MarketingNewJobScreen', () => {
  const element = MarketingNewJobPage();

  assert.equal(isValidElement(element), true);
  assert.equal(element.type, MarketingNewJobScreen);
});

test('startMarketingJob rejects brand_campaign requests without both required URLs', async () => {
  await withMarketingRuntimeEnv(async () => {
    const startMarketingJob = await loadStartMarketingJob();

    await assert.rejects(
      () =>
        startMarketingJob({
          tenantId: 'tenant_123',
          jobType: 'brand_campaign',
          payload: {
            brandUrl: 'https://brand.example',
          },
        }),
      /missing_required_fields:.*competitorUrl/i,
    );

    await assert.rejects(
      () =>
        startMarketingJob({
          tenantId: 'tenant_123',
          jobType: 'brand_campaign',
          payload: {
            competitorUrl: 'https://facebook.com/competitor',
          },
        }),
      /missing_required_fields:.*brandUrl/i,
    );
  });
});

test('startMarketingJob creates a real job and pauses at the strategy approval checkpoint', async () => {
  await withMarketingRuntimeEnv(async (dataRoot) => {
    installMarketingPipelineInvoker();
    const startMarketingJob = await loadStartMarketingJob();
    const result = await startMarketingJob({
      tenantId: 'tenant_123',
      jobType: 'brand_campaign',
      payload: {
        brandUrl: 'https://brand.example',
        competitorUrl: 'https://facebook.com/competitor',
      },
    });

    assert.equal(result.jobType, 'brand_campaign');
    assert.equal(result.jobId.includes('tenant_123'), false);
    assert.equal(result.approvalRequired, true);
    assert.equal(result.currentStage, 'strategy');
    assert.equal(result.approval?.stage, 'strategy');

    const runtimeFile = path.join(dataRoot, 'generated', 'draft', 'marketing-jobs', `${result.jobId}.json`);
    const runtimeDoc = JSON.parse(await readFile(runtimeFile, 'utf8')) as any;

    assert.equal(runtimeDoc.schema_name, 'marketing_job_state_schema');
    assert.equal(runtimeDoc.job_type, 'brand_campaign');
    assert.equal(runtimeDoc.inputs?.brand_url, 'https://brand.example');
    assert.equal(runtimeDoc.inputs?.competitor_url, 'https://facebook.com/competitor');
    assert.equal(runtimeDoc.state, 'approval_required');
    assert.equal(runtimeDoc.status, 'awaiting_approval');
    assert.equal(runtimeDoc.current_stage, 'strategy');
    assert.equal(runtimeDoc.stages.research.status, 'completed');
    assert.equal(runtimeDoc.stages.strategy.status, 'awaiting_approval');
    assert.equal(runtimeDoc.stages.production.status, 'not_started');
    assert.equal(runtimeDoc.approvals.current.stage, 'strategy');
    clearOpenClawTestInvoker();
  });
});

test('approveMarketingJob rejects tenant mismatches for local runtime jobs', async () => {
  await withMarketingRuntimeEnv(async (dataRoot) => {
    const { approveMarketingJob } = await import('../backend/marketing/jobs-approve');
    const runtimeFile = path.join(dataRoot, 'generated', 'draft', 'marketing-jobs', 'mkt_tenant-a_1.json');
    await mkdir(path.dirname(runtimeFile), { recursive: true });

    await writeFile(
      runtimeFile,
      JSON.stringify({
        schema_name: 'marketing_job_state_schema',
        schema_version: '1.0.0',
        job_id: 'mkt_tenant-a_1',
        job_type: 'brand_campaign',
        tenant_id: 'tenant-a',
        state: 'approval_required',
        status: 'awaiting_approval',
        current_stage: 'strategy',
        stage_order: ['research', 'strategy', 'production', 'publish'],
        stages: {
          research: { stage: 'research', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-r', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          strategy: { stage: 'strategy', status: 'awaiting_approval', started_at: null, completed_at: null, failed_at: null, run_id: 'run-s', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          production: { stage: 'production', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          publish: { stage: 'publish', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
        },
        approvals: {
          current: {
            stage: 'strategy',
            status: 'awaiting_approval',
            title: 'Strategy approval required',
            message: 'Strategy review is ready.',
            requested_at: new Date().toISOString(),
          },
          history: [],
        },
        publish_config: {
          platforms: ['meta-ads'],
          live_publish_platforms: [],
          video_render_platforms: [],
        },
        inputs: { request: {} },
        errors: [],
        last_error: null,
        history: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, null, 2)
    );

    const result = await approveMarketingJob({
      jobId: 'mkt_tenant-a_1',
      tenantId: 'tenant-b',
      approvedBy: 'operator',
      approvedStages: ['research'],
    });

    assert.equal(result.status, 'error');
    assert.equal(result.resumedStage, null);
    assert.equal(result.completed, false);
  });
});

test('approveMarketingJob advances strategy, production, and publish approvals through the real orchestration model', async () => {
  await withMarketingRuntimeEnv(async (dataRoot) => {
    const { approveMarketingJob } = await import('../backend/marketing/jobs-approve');
    const { startMarketingJob } = await import('../backend/marketing/jobs-start');
    installMarketingPipelineInvoker();
    const started = await startMarketingJob({
      tenantId: 'tenant-a',
      jobType: 'brand_campaign',
      payload: {
        brandUrl: 'https://brand.example',
        competitorUrl: 'https://facebook.com/competitor',
      },
    });
    const jobId = started.jobId;
    const runtimeFile = path.join(dataRoot, 'generated', 'draft', 'marketing-jobs', `${jobId}.json`);
    const strategyApproved = await approveMarketingJob({
      jobId,
      tenantId: 'tenant-a',
      approvedBy: 'operator',
      approvedStages: ['strategy'],
    });

    let runtimeDoc = JSON.parse(await readFile(runtimeFile, 'utf8')) as any;
    assert.equal(strategyApproved.status, 'resumed');
    assert.equal(strategyApproved.resumedStage, 'production');
    assert.equal(strategyApproved.completed, false);
    assert.equal(runtimeDoc.current_stage, 'production');
    assert.equal(runtimeDoc.stages.strategy.status, 'completed');
    assert.equal(runtimeDoc.stages.production.status, 'awaiting_approval');
    assert.equal(runtimeDoc.approvals.current.stage, 'production');

    const productionApproved = await approveMarketingJob({
      jobId,
      tenantId: 'tenant-a',
      approvedBy: 'operator',
      approvedStages: ['production'],
    });

    runtimeDoc = JSON.parse(await readFile(runtimeFile, 'utf8')) as any;
    assert.equal(productionApproved.status, 'resumed');
    assert.equal(productionApproved.resumedStage, 'publish');
    assert.equal(productionApproved.completed, false);
    assert.equal(runtimeDoc.current_stage, 'publish');
    assert.equal(runtimeDoc.stages.production.status, 'completed');
    assert.equal(runtimeDoc.stages.publish.status, 'awaiting_approval');
    assert.equal(runtimeDoc.approvals.current.stage, 'publish');

    const publishApproved = await approveMarketingJob({
      jobId,
      tenantId: 'tenant-a',
      approvedBy: 'operator',
      approvedStages: ['publish'],
      publishConfig: {
        platforms: ['meta-ads', 'tiktok'],
        live_publish_platforms: ['meta-ads'],
        video_render_platforms: ['tiktok'],
      },
    });

    runtimeDoc = JSON.parse(await readFile(runtimeFile, 'utf8')) as any;
    assert.equal(publishApproved.status, 'resumed');
    assert.equal(publishApproved.resumedStage, 'publish');
    assert.equal(publishApproved.completed, true);
    assert.equal(runtimeDoc.state, 'completed');
    assert.equal(runtimeDoc.status, 'completed');
    assert.equal(runtimeDoc.stages.publish.status, 'completed');
    assert.deepEqual(runtimeDoc.publish_config, {
      platforms: ['meta-ads', 'tiktok'],
      live_publish_platforms: ['meta-ads'],
      video_render_platforms: ['tiktok'],
    });
    clearOpenClawTestInvoker();
  });
});
