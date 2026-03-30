import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isValidElement } from 'react';

import MarketingNewJobPage from '../app/marketing/new-job/page';
import MarketingNewJobScreen from '../frontend/marketing/new-job';
import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

async function loadStartMarketingJob() {
  const module = await import('../backend/marketing/orchestrator');
  return module.startMarketingJob;
}

async function withMarketingRuntimeEnv<T>(run: (dataRoot: string) => Promise<T>): Promise<T> {
  const previousCodeRoot = process.env.CODE_ROOT;
  const previousDataRoot = process.env.DATA_ROOT;
  const previousOpenClawLobsterCwd = process.env.OPENCLAW_LOBSTER_CWD;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-marketing-'));

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

/**
 * Production contract: one `marketing-pipeline.lobster` run, then `resume` with approval tokens
 * between human gates (see orchestrator.ts + gateway-client run/resume payloads).
 */
function installMarketingPipelineInvoker(
  tracking: { actions: string[]; resumeTokens: string[]; firstRunPayload: Record<string, unknown> | null },
): void {
  setOpenClawTestInvoker((payload) => {
    const args = (payload.args as Record<string, unknown> | undefined) ?? {};
    const action = String(args.action || '');
    tracking.actions.push(action);

    if (action === 'run') {
      tracking.firstRunPayload = payload;
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
      const token = String(args.token || '');
      tracking.resumeTokens.push(token);

      if (token === 'resume_strategy') {
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

      if (token === 'resume_production') {
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
                static: {
                  platform_contract_paths: ['output/static/meta-ads.json'],
                },
                video: {
                  platform_contract_paths: ['output/video/tiktok.json'],
                },
              },
            },
          }],
          requiresApproval: {
            resumeToken: 'resume_publish',
            prompt: 'Production complete. Approve launch to continue.',
          },
        };
      }

      if (token === 'resume_publish') {
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
      }
    }

    throw new Error(`Unexpected OpenClaw lobster invocation: action=${action}`);
  });
}

test('/marketing/new-job uses the canonical MarketingNewJobScreen', () => {
  const element = MarketingNewJobPage();

  assert.equal(isValidElement(element), true);
  assert.equal(element.type, MarketingNewJobScreen);
});

test('startMarketingJob rejects brand_campaign requests without a brand URL', async () => {
  await withMarketingRuntimeEnv(async () => {
    const startMarketingJob = await loadStartMarketingJob();

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

test('startMarketingJob uses repo-managed runtime without legacy workflow env', async () => {
  await withMarketingRuntimeEnv(async (dataRoot) => {
    const tracking = {
      actions: [] as string[],
      resumeTokens: [] as string[],
      firstRunPayload: null as Record<string, unknown> | null,
    };
    installMarketingPipelineInvoker(tracking);
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

    assert.deepEqual(tracking.actions, ['run']);
    assert.deepEqual(tracking.resumeTokens, []);
    const firstArgs = (tracking.firstRunPayload?.args as Record<string, unknown> | undefined) ?? {};
    assert.equal(firstArgs.action, 'run');
    assert.equal(firstArgs.pipeline, 'marketing-pipeline.lobster');
    assert.equal(firstArgs.cwd, 'lobster');

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
    assert.equal(runtimeDoc.approvals.current.resume_token, 'resume_strategy');
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
    const tracking = {
      actions: [] as string[],
      resumeTokens: [] as string[],
      firstRunPayload: null as Record<string, unknown> | null,
    };
    installMarketingPipelineInvoker(tracking);
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
      resumePublishIfNeeded: true,
    });

    runtimeDoc = JSON.parse(await readFile(runtimeFile, 'utf8')) as any;
    assert.equal(publishApproved.status, 'resumed');
    assert.equal(publishApproved.resumedStage, 'publish');
    assert.equal(publishApproved.completed, true);
    assert.equal(runtimeDoc.state, 'completed');
    assert.equal(runtimeDoc.status, 'completed');
    assert.equal(runtimeDoc.stages.publish.status, 'completed');
    assert.deepEqual(tracking.actions, ['run', 'resume', 'resume', 'resume']);
    assert.deepEqual(tracking.resumeTokens, ['resume_strategy', 'resume_production', 'resume_publish']);
    assert.deepEqual(runtimeDoc.publish_config, {
      platforms: ['meta-ads', 'tiktok'],
      live_publish_platforms: ['meta-ads'],
      video_render_platforms: ['tiktok'],
    });
    clearOpenClawTestInvoker();
  });
});

test('approveMarketingJob preserves the second publish-as-paused approval checkpoint before final completion', async () => {
  await withMarketingRuntimeEnv(async (dataRoot) => {
    const { approveMarketingJob } = await import('../backend/marketing/jobs-approve');
    const { startMarketingJob } = await import('../backend/marketing/jobs-start');

    setOpenClawTestInvoker((payload) => {
      const args = (payload.args as Record<string, unknown> | undefined) ?? {};
      const action = String(args.action || '');
      const token = String(args.token || '');

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
                static: {
                  platform_contract_paths: ['output/static/meta-ads.json'],
                },
                video: {
                  platform_contract_paths: ['output/video/tiktok.json'],
                },
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

      throw new Error(`Unexpected OpenClaw lobster invocation: action=${action} token=${token}`);
    });

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

    await approveMarketingJob({
      jobId,
      tenantId: 'tenant-a',
      approvedBy: 'operator',
      approvedStages: ['strategy'],
    });

    await approveMarketingJob({
      jobId,
      tenantId: 'tenant-a',
      approvedBy: 'operator',
      approvedStages: ['production'],
    });

    const publishReviewApproved = await approveMarketingJob({
      jobId,
      tenantId: 'tenant-a',
      approvedBy: 'operator',
      approvedStages: ['publish'],
      resumePublishIfNeeded: true,
    });

    let runtimeDoc = JSON.parse(await readFile(runtimeFile, 'utf8')) as any;
    assert.equal(publishReviewApproved.status, 'resumed');
    assert.equal(publishReviewApproved.completed, false);
    assert.equal(runtimeDoc.state, 'approval_required');
    assert.equal(runtimeDoc.status, 'awaiting_approval');
    assert.equal(runtimeDoc.current_stage, 'publish');
    assert.equal(runtimeDoc.approvals.current.stage, 'publish');
    assert.equal(runtimeDoc.approvals.current.resume_token, 'resume_publish_paused');
    assert.deepEqual(
      runtimeDoc.stages.publish.artifacts.map((artifact: any) => artifact.id),
      ['publish-paused-review'],
    );

    const pausedPublishApproved = await approveMarketingJob({
      jobId,
      tenantId: 'tenant-a',
      approvedBy: 'operator',
      approvedStages: ['publish'],
      resumePublishIfNeeded: true,
    });

    runtimeDoc = JSON.parse(await readFile(runtimeFile, 'utf8')) as any;
    assert.equal(pausedPublishApproved.status, 'resumed');
    assert.equal(pausedPublishApproved.completed, true);
    assert.equal(runtimeDoc.state, 'completed');
    assert.equal(runtimeDoc.status, 'completed');
    assert.equal(runtimeDoc.approvals.current, null);
    assert.equal(runtimeDoc.stages.publish.artifacts.length, 0);
    clearOpenClawTestInvoker();
  });
});

test('approveMarketingJob preserves the active approval checkpoint when resume fails', async () => {
  await withMarketingRuntimeEnv(async (dataRoot) => {
    const { approveMarketingJob } = await import('../backend/marketing/jobs-approve');
    const { startMarketingJob } = await import('../backend/marketing/jobs-start');

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
        throw new Error('resume_pipeline_failed:gateway_timeout');
      }

      throw new Error(`Unexpected OpenClaw lobster invocation: action=${action}`);
    });

    const started = await startMarketingJob({
      tenantId: 'tenant-a',
      jobType: 'brand_campaign',
      payload: {
        brandUrl: 'https://brand.example',
        competitorUrl: 'https://facebook.com/competitor',
      },
    });

    await assert.rejects(
      () =>
        approveMarketingJob({
          jobId: started.jobId,
          tenantId: 'tenant-a',
          approvedBy: 'operator',
          approvedStages: ['strategy'],
        }),
      /resume_pipeline_failed:gateway_timeout/i
    );

    const runtimeFile = path.join(dataRoot, 'generated', 'draft', 'marketing-jobs', `${started.jobId}.json`);
    const runtimeDoc = JSON.parse(await readFile(runtimeFile, 'utf8')) as any;

    assert.equal(runtimeDoc.state, 'failed');
    assert.equal(runtimeDoc.status, 'failed');
    assert.equal(runtimeDoc.approvals.current.stage, 'strategy');
    assert.equal(runtimeDoc.approvals.current.resume_token, 'resume_strategy');
    clearOpenClawTestInvoker();
  });
});

test('approveMarketingJob reseeds a missing Lobster resume state and retries the approval once', async () => {
  await withMarketingRuntimeEnv(async (dataRoot) => {
    const { OpenClawGatewayError } = await import('../backend/openclaw/gateway-client');
    const { approveMarketingJob } = await import('../backend/marketing/jobs-approve');
    const { startMarketingJob } = await import('../backend/marketing/jobs-start');
    const invocations: string[] = [];
    let runCount = 0;

    setOpenClawTestInvoker((payload) => {
      const args = (payload.args as Record<string, unknown> | undefined) ?? {};
      const action = String(args.action || '');
      const token = String(args.token || '');
      invocations.push(`${action}:${token || 'initial'}`);

      if (action === 'run' && runCount === 0) {
        runCount += 1;
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
            resumeToken: 'resume_strategy_missing',
            prompt: 'Research complete. Approve strategy to continue.',
          },
        };
      }

      if (action === 'resume' && token === 'resume_strategy_missing') {
        throw new OpenClawGatewayError(
          'openclaw_gateway_server_error',
          'lobster failed (1): {"message":"Workflow resume state not found"}',
          500,
        );
      }

      if (action === 'run') {
        runCount += 1;
        return {
          ok: true,
          status: 'needs_approval',
          output: [{
            run_id: 'run-research-reseed',
            executive_summary: {
              market_positioning: 'Competitive research was replayed after resume-state loss.',
              campaign_takeaway: 'Outcome-first hooks are strongest.',
            },
          }],
          requiresApproval: {
            resumeToken: 'resume_strategy_reseeded',
            prompt: 'Research complete. Approve strategy to continue.',
          },
        };
      }

      if (action === 'resume' && token === 'resume_strategy_reseeded') {
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

      throw new Error(`Unexpected OpenClaw lobster invocation: action=${action} token=${token}`);
    });

    const started = await startMarketingJob({
      tenantId: 'tenant-a',
      jobType: 'brand_campaign',
      payload: {
        brandUrl: 'https://brand.example',
        competitorUrl: 'https://facebook.com/competitor',
      },
    });

    const result = await approveMarketingJob({
      jobId: started.jobId,
      tenantId: 'tenant-a',
      approvedBy: 'operator',
      approvedStages: ['strategy'],
      approvalId: started.approval?.approval_id ?? undefined,
    });

    const runtimeFile = path.join(dataRoot, 'generated', 'draft', 'marketing-jobs', `${started.jobId}.json`);
    const runtimeDoc = JSON.parse(await readFile(runtimeFile, 'utf8')) as any;
    const approvalFile = path.join(
      dataRoot,
      'generated',
      'draft',
      'marketing-approvals',
      `${started.approval?.approval_id}.json`,
    );
    const approvalRecord = JSON.parse(await readFile(approvalFile, 'utf8')) as any;

    assert.equal(result.status, 'resumed');
    assert.equal(result.resumedStage, 'production');
    assert.equal(runtimeDoc.current_stage, 'production');
    assert.equal(runtimeDoc.approvals.current.stage, 'production');
    assert.equal(approvalRecord.status, 'approved');
    assert.equal(approvalRecord.lobster_resume_token, 'resume_strategy_reseeded');
    assert.deepEqual(invocations, [
      'run:initial',
      'resume:resume_strategy_missing',
      'run:initial',
      'resume:resume_strategy_reseeded',
    ]);
    clearOpenClawTestInvoker();
  });
});

test('approveMarketingJob backfills a missing brand kit for legacy runtime documents before saving approval state', async () => {
  await withMarketingRuntimeEnv(async (dataRoot) => {
    const { approveMarketingJob } = await import('../backend/marketing/jobs-approve');
    const { saveTenantBrandKit } = await import('../backend/marketing/brand-kit');
    const runtimeFile = path.join(dataRoot, 'generated', 'draft', 'marketing-jobs', 'mkt_legacy_brandless.json');
    await mkdir(path.dirname(runtimeFile), { recursive: true });

    saveTenantBrandKit('tenant-a', {
      tenant_id: 'tenant-a',
      source_url: 'https://brand.example',
      canonical_url: 'https://brand.example',
      brand_name: 'Brand Example',
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
      brand_voice_summary: null,
      offer_summary: null,
    });

    await writeFile(
      runtimeFile,
      JSON.stringify({
        schema_name: 'marketing_job_state_schema',
        schema_version: '1.0.0',
        job_id: 'mkt_legacy_brandless',
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
            resume_token: 'resume_strategy',
          },
          history: [],
        },
        publish_config: {
          platforms: ['meta-ads'],
          live_publish_platforms: [],
          video_render_platforms: [],
        },
        inputs: {
          request: {
            brandUrl: 'https://brand.example',
            competitorUrl: 'https://facebook.com/competitor',
          },
          brand_url: 'https://brand.example',
          competitor_url: 'https://facebook.com/competitor',
        },
        errors: [],
        last_error: null,
        history: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, null, 2)
    );

    setOpenClawTestInvoker((payload) => {
      const args = (payload.args as Record<string, unknown> | undefined) ?? {};
      if (String(args.action || '') === 'resume') {
        return {
          ok: true,
          status: 'needs_approval',
          output: [{
            run_id: 'run-production',
            strategy_handoff: {
              core_message: 'Strategy approved and handed off.',
              primary_cta: 'Shop now',
            },
          }],
          requiresApproval: {
            resumeToken: 'resume_production',
            prompt: 'Approve production to continue.',
          },
        };
      }
      throw new Error(`Unexpected OpenClaw lobster invocation: action=${String(args.action || '')}`);
    });

    const result = await approveMarketingJob({
      jobId: 'mkt_legacy_brandless',
      tenantId: 'tenant-a',
      approvedBy: 'operator',
      approvedStages: ['strategy'],
    });

    const runtimeDoc = JSON.parse(await readFile(runtimeFile, 'utf8')) as any;
    assert.equal(result.status, 'resumed');
    assert.equal(result.resumedStage, 'production');
    assert.equal(runtimeDoc.brand_kit.source_url, 'https://brand.example');
    assert.equal(runtimeDoc.approvals.current.stage, 'production');
    clearOpenClawTestInvoker();
  });
});
