import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { POST as postOnboardingStart } from '../app/api/onboarding/start/route';
import { GET as getOnboardingStatus } from '../app/api/onboarding/status/[tenantId]/route';

function setOpenClawTestInvoker(
  impl: (payload: Record<string, unknown>) => unknown | Promise<unknown>
): void {
  (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__ = impl;
}

function clearOpenClawTestInvoker(): void {
  delete (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__;
}

async function withRuntimeEnv<T>(run: (dataRoot: string) => Promise<T>): Promise<T> {
  const previousCodeRoot = process.env.CODE_ROOT;
  const previousDataRoot = process.env.DATA_ROOT;
  const previousStage1CacheDir = process.env.LOBSTER_STAGE1_CACHE_DIR;
  const previousStage2CacheDir = process.env.LOBSTER_STAGE2_CACHE_DIR;
  const previousStage3CacheDir = process.env.LOBSTER_STAGE3_CACHE_DIR;
  const previousStage4CacheDir = process.env.LOBSTER_STAGE4_CACHE_DIR;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-frontend-api-'));

  process.env.CODE_ROOT = process.cwd();
  process.env.DATA_ROOT = dataRoot;
  process.env.LOBSTER_STAGE1_CACHE_DIR = path.join(dataRoot, 'lobster-stage1-cache');
  process.env.LOBSTER_STAGE2_CACHE_DIR = path.join(dataRoot, 'lobster-stage2-cache');
  process.env.LOBSTER_STAGE3_CACHE_DIR = path.join(dataRoot, 'lobster-stage3-cache');
  process.env.LOBSTER_STAGE4_CACHE_DIR = path.join(dataRoot, 'lobster-stage4-cache');

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

    if (previousStage1CacheDir === undefined) {
      delete process.env.LOBSTER_STAGE1_CACHE_DIR;
    } else {
      process.env.LOBSTER_STAGE1_CACHE_DIR = previousStage1CacheDir;
    }

    if (previousStage2CacheDir === undefined) {
      delete process.env.LOBSTER_STAGE2_CACHE_DIR;
    } else {
      process.env.LOBSTER_STAGE2_CACHE_DIR = previousStage2CacheDir;
    }

    if (previousStage3CacheDir === undefined) {
      delete process.env.LOBSTER_STAGE3_CACHE_DIR;
    } else {
      process.env.LOBSTER_STAGE3_CACHE_DIR = previousStage3CacheDir;
    }

    if (previousStage4CacheDir === undefined) {
      delete process.env.LOBSTER_STAGE4_CACHE_DIR;
    } else {
      process.env.LOBSTER_STAGE4_CACHE_DIR = previousStage4CacheDir;
    }

    await rm(dataRoot, { recursive: true, force: true });
  }
}

function stageStepPath(dataRoot: string, stage: 1 | 2 | 3 | 4, runId: string, stepName: string): string {
  return path.join(dataRoot, `lobster-stage${stage}-cache`, runId, `${stepName}.json`);
}

test('/api/onboarding/start returns a frontend-safe payload without workflow internals', async () => {
  setOpenClawTestInvoker(() => ({
    ok: true,
    status: 'ok',
    output: [{ accepted: true }],
    requiresApproval: null,
  }));

  const response = await postOnboardingStart(
    new Request('http://localhost/api/onboarding/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tenant_id: 'tenant_123',
        tenant_type: 'single_user',
        signup_event_id: 'signup_evt_456',
      }),
    }),
  );
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.tenant_id, 'tenant_123');
  assert.equal(body.tenant_type, 'single_user');
  assert.equal(body.signup_event_id, 'signup_evt_456');
  assert.equal(body.onboarding_status, 'accepted');
  assert.equal('workflow_status' in body, false);
  assert.equal('raw' in body, false);
  clearOpenClawTestInvoker();
});

test('/api/onboarding/status exposes artifact booleans instead of runtime paths', async () => {
  const response = await getOnboardingStatus(
    new Request('http://localhost/api/onboarding/status/tenant_123?signup_event_id=signup_evt_456'),
    { params: Promise.resolve({ tenantId: 'tenant_123' }) },
  );
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.equal(body.onboarding_status, 'ok');
  assert.equal(body.tenant_id, 'tenant_123');
  assert.equal('artifacts' in body, true);
  assert.equal('progress_hint' in body, true);
  assert.equal('paths' in body, false);
  assert.equal('pathsAreRelative' in body, false);
});

test('/api/marketing/jobs resolves tenant context server-side and returns a frontend-safe payload', async () => {
  await withRuntimeEnv(async () => {
    const { handlePostMarketingJobs } = await import('../app/api/marketing/jobs/handler');
    let captured: Record<string, unknown> | null = null;
    setOpenClawTestInvoker((payload) => {
      captured = payload;
      return {
        ok: true,
        status: 'ok',
        output: [{ accepted: true, approval_preview: { status: 'pending_human_review' } }],
        requiresApproval: { resumeToken: 'resume_123' },
      };
    });

    const response = await handlePostMarketingJobs(
      new Request('http://localhost/api/marketing/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tenantId: 'forged_tenant',
          jobType: 'brand_campaign',
          payload: {
            brandUrl: 'https://brand.example',
            competitorUrl: 'https://facebook.com/competitor',
          },
        }),
      }),
      async () => ({
        userId: 'user_123',
        tenantId: 'tenant_real',
        tenantSlug: 'acme',
        role: 'tenant_admin',
      })
    );
    const body = (await response.json()) as Record<string, unknown>;
    const workflowArgs = JSON.parse(String((captured as any)?.args?.argsJson)) as Record<string, unknown>;

    assert.equal(response.status, 202);
    assert.equal(body.marketing_job_status, 'accepted');
    assert.equal(body.jobType, 'brand_campaign');
    assert.equal(body.approvalRequired, true);
    assert.equal(typeof body.jobStatusUrl, 'string');
    assert.equal('tenantId' in body, false);
    assert.equal('wiring' in body, false);
    assert.equal('runtimeArtifactPath' in body, false);
    assert.equal('runtimePath' in body, false);
    assert.equal('runtimePathDeprecated' in body, false);
    assert.equal(String(body.jobId).includes('tenant_real'), false);
    assert.equal(workflowArgs.brand_slug, 'tenant_real');
    assert.equal(workflowArgs.website_url, 'https://brand.example');
    assert.equal(workflowArgs.competitor_facebook_url, 'https://facebook.com/competitor');
    clearOpenClawTestInvoker();
  });
});

test('/api/marketing/jobs returns onboarding_required when tenant context has not been established', async () => {
  const { handlePostMarketingJobs } = await import('../app/api/marketing/jobs/handler');
  const response = await handlePostMarketingJobs(
    new Request('http://localhost/api/marketing/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jobType: 'brand_campaign',
        payload: {
          brandUrl: 'https://brand.example',
          competitorUrl: 'https://facebook.com/competitor',
        },
      }),
    }),
    async () => {
      throw new Error('No tenant membership found for authenticated user.');
    }
  );
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 409);
  assert.equal(body.status, 'error');
  assert.equal(body.reason, 'onboarding_required');
  assert.equal(body.message, 'Complete tenant onboarding before starting a brand campaign.');
});

test('/api/marketing/jobs/:jobId returns stage progress and safe artifact summaries for the current tenant', async () => {
  await withRuntimeEnv(async (dataRoot) => {
    const { handleGetMarketingJobStatus } = await import('../app/api/marketing/jobs/[jobId]/handler');
    const jobId = 'mkt_safe_job';
    const runId = 'demo-run-123';
    const runtimeFile = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs', `${jobId}.json`);
    await mkdir(path.dirname(runtimeFile), { recursive: true });
    const launchPreviewPath = path.join(dataRoot, 'launch-review-preview.txt');
    await writeFile(launchPreviewPath, 'Campaign: Demo launch\nApproval state: pending_human_review\n', 'utf8');

    await writeFile(
      runtimeFile,
      JSON.stringify({
        schema_name: 'job_runtime_state_schema',
        schema_version: '1.0.0',
        job_id: jobId,
        job_type: 'brand_campaign',
        tenant_id: 'tenant_real',
        state: 'running',
        status: 'pending',
        attempt: 1,
        max_attempts: 3,
        outputs: {
          current_stage: 'publish',
          stage_status: {
            research: 'completed',
            strategy: 'completed',
            production: 'completed',
            publish: 'awaiting_approval',
          },
          openclaw: {
            run_id: runId,
            resume_token: 'resume_123',
            primary_output: {
              run_id: runId,
            },
          },
          structured_status_updates: [],
        },
        history: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, null, 2)
    );
    await mkdir(path.dirname(stageStepPath(dataRoot, 1, runId, 'ads_analyst_compile')), { recursive: true });
    await writeFile(
      stageStepPath(dataRoot, 1, runId, 'ads_analyst_compile'),
      JSON.stringify({
        generated_at: '2026-03-19T00:00:01.000Z',
        executive_summary: {
          market_positioning: 'Competitor leans on practical outcomes.',
          campaign_takeaway: 'Proof-led hooks are winning.',
          creative_takeaway: 'Proof-heavy creative is performing best.',
        },
        competitor: 'CompetitorCo',
        inputs: { ads_seen: 6 },
      }, null, 2)
    );
    await writeFile(
      stageStepPath(dataRoot, 1, runId, 'meta_ads_extractor'),
      JSON.stringify({
        competitor: 'CompetitorCo',
        competitor_research_summary: ['Outcome-first claims', 'Low-friction CTA'],
      }, null, 2)
    );
    await mkdir(path.dirname(stageStepPath(dataRoot, 2, runId, 'head_of_marketing')), { recursive: true });
    await writeFile(
      stageStepPath(dataRoot, 2, runId, 'website_brand_analysis'),
      JSON.stringify({
        brand_analysis: {
          brand_promise: 'Aries helps operators launch faster.',
          audience_summary: 'In-house marketing teams',
          offer_summary: 'Operational visibility',
          proof_points: ['Workflow transparency', 'Human approval controls'],
        },
      }, null, 2)
    );
    await writeFile(
      stageStepPath(dataRoot, 2, runId, 'campaign_planner'),
      JSON.stringify({
        campaign_plan: {
          core_message: 'Launch campaigns with operator control.',
          primary_cta: 'Book a walkthrough',
          offer: 'Operational visibility',
        },
      }, null, 2)
    );
    await writeFile(
      stageStepPath(dataRoot, 2, runId, 'head_of_marketing'),
      JSON.stringify({
        generated_at: '2026-03-19T00:00:02.000Z',
      }, null, 2)
    );
    await mkdir(path.dirname(stageStepPath(dataRoot, 3, runId, 'production_review_preview')), { recursive: true });
    await writeFile(
      stageStepPath(dataRoot, 3, runId, 'production_review_preview'),
      JSON.stringify({
        generated_at: '2026-03-19T00:00:03.000Z',
        review_packet: {
          summary: { core_message: 'Proof-led launch package' },
          asset_previews: {
            landing_page_headline: 'Ship the campaign with confidence',
            meta_ad_hook: 'The cleanest path from idea to launch',
            video_opening_line: 'See every stage before you publish',
          },
        },
        artifacts: {
          preview_path: launchPreviewPath,
        },
      }, null, 2)
    );
    await writeFile(
      stageStepPath(dataRoot, 3, runId, 'creative_director_finalize'),
      JSON.stringify({
        generated_at: '2026-03-19T00:00:04.000Z',
      }, null, 2)
    );
    await writeFile(
      stageStepPath(dataRoot, 3, runId, 'veo_video_generator'),
      JSON.stringify({
        video_assets: {
          platform_contracts: [
            { platform: 'YouTube Shorts', platform_slug: 'youtube-shorts' },
            { platform: 'TikTok', platform_slug: 'tiktok' },
          ],
        },
      }, null, 2)
    );
    await mkdir(path.dirname(stageStepPath(dataRoot, 4, runId, 'launch_review_preview')), { recursive: true });
    await writeFile(
      stageStepPath(dataRoot, 4, runId, 'performance_marketer_preflight'),
      JSON.stringify({
        publish_plan: {
          static_contract_count: 7,
          video_contract_count: 2,
        },
      }, null, 2)
    );
    await writeFile(
      stageStepPath(dataRoot, 4, runId, 'launch_review_preview'),
      JSON.stringify({
        generated_at: '2026-03-19T00:00:05.000Z',
        approval_preview: {
          status: 'pending_human_review',
          message: 'Approval needed before publish-ready assets are generated.',
        },
        artifacts: {
          preview_path: launchPreviewPath,
        },
      }, null, 2)
    );

    const response = await handleGetMarketingJobStatus(
      jobId,
      async () => ({
        userId: 'user_123',
        tenantId: 'tenant_real',
        tenantSlug: 'acme',
        role: 'tenant_admin',
      })
    );
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 200);
    assert.equal(body.jobId, jobId);
    assert.equal(body.marketing_job_state, 'approval_required');
    assert.equal(body.marketing_job_status, 'awaiting_approval');
    assert.equal(body.needs_attention, true);
    assert.equal(body.approvalRequired, true);
    assert.equal((body.summary as any).headline, 'Campaign is ready for launch approval');
    assert.equal(Array.isArray(body.stageCards), true);
    assert.equal((body.stageCards as any[]).length, 4);
    assert.equal(Array.isArray(body.artifacts), true);
    assert.equal((body.artifacts as any[]).length > 0, true);
    assert.equal(Array.isArray(body.timeline), true);
    assert.equal((body.approval as any).required, true);
    assert.equal(body.nextStep, 'submit_approval');
    assert.equal(body.repairStatus, 'not_required');
    assert.equal('tenantId' in body, false);
    assert.equal('runtimeArtifactPath' in body, false);
    assert.equal('runtimePath' in body, false);
    assert.equal('runtimePathDeprecated' in body, false);
  });
});

test('/api/marketing/jobs/:jobId hides jobs owned by a different tenant', async () => {
  await withRuntimeEnv(async () => {
    const { handleGetMarketingJobStatus } = await import('../app/api/marketing/jobs/[jobId]/handler');
    const jobId = 'mkt_hidden_job';
    const runtimeFile = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs', `${jobId}.json`);
    await mkdir(path.dirname(runtimeFile), { recursive: true });
    await writeFile(
      runtimeFile,
      JSON.stringify({
        schema_name: 'job_runtime_state_schema',
        schema_version: '1.0.0',
        job_id: jobId,
        job_type: 'brand_campaign',
        tenant_id: 'tenant_other',
        state: 'running',
        status: 'pending',
        outputs: {
          current_stage: 'publish',
          stage_status: {},
          structured_status_updates: [],
        },
        history: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, null, 2)
    );

    const response = await handleGetMarketingJobStatus(
      jobId,
      async () => ({
        userId: 'user_123',
        tenantId: 'tenant_real',
        tenantSlug: 'acme',
        role: 'tenant_admin',
      })
    );
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 404);
    assert.equal(body.error, 'Marketing job not found.');
    assert.equal(body.reason, 'marketing_job_not_found');
  });
});

test('/api/marketing/jobs/:jobId/approve resolves tenant context server-side and returns a product-safe payload', async () => {
  await withRuntimeEnv(async () => {
    const { handleApproveMarketingJob } = await import('../app/api/marketing/jobs/[jobId]/approve/handler');
    const jobId = 'mkt_approve_job';
    const runtimeFile = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs', `${jobId}.json`);
    await mkdir(path.dirname(runtimeFile), { recursive: true });
    await writeFile(
      runtimeFile,
      JSON.stringify({
        schema_name: 'job_runtime_state_schema',
        schema_version: '1.0.0',
        job_id: jobId,
        job_type: 'brand_campaign',
        tenant_id: 'tenant_real',
        state: 'waiting_repair',
        status: 'pending',
        attempt: 1,
        max_attempts: 3,
        outputs: {
          current_stage: 'publish',
          stage_status: {
            research: 'completed',
            strategy: 'completed',
            production: 'completed',
            publish: 'awaiting_approval',
          },
          openclaw: {
            run_id: 'demo-run-approve',
            resume_token: 'resume_123',
            primary_output: {
              run_id: 'demo-run-approve',
              approval_preview: {
                status: 'pending_human_review',
              },
            },
          },
          structured_status_updates: [],
        },
        history: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, null, 2)
    );

    let captured: Record<string, unknown> | null = null;
    setOpenClawTestInvoker((payload) => {
      captured = payload;
      return {
        ok: true,
        status: 'ok',
        output: [{
          run_id: 'demo-run-approve',
          summary: {
            message: 'Publish packages ready.',
          },
        }],
        requiresApproval: null,
      };
    });

    const response = await handleApproveMarketingJob(
      jobId,
      new Request(`http://localhost/api/marketing/jobs/${jobId}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tenantId: 'forged_tenant',
          approvedBy: 'operator',
          approvedStages: ['publish'],
          resumePublishIfNeeded: true,
        }),
      }),
      async () => ({
        userId: 'user_123',
        tenantId: 'tenant_real',
        tenantSlug: 'acme',
        role: 'tenant_admin',
      })
    );
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 200);
    assert.equal(body.approval_status, 'resumed');
    assert.equal(body.jobId, jobId);
    assert.equal(typeof body.jobStatusUrl, 'string');
    assert.equal('tenantId' in body, false);
    assert.equal('wiring' in body, false);
    assert.equal((captured as any)?.args?.action, 'resume');
    assert.equal((captured as any)?.args?.token, 'resume_123');
    assert.equal((captured as any)?.args?.approve, true);
    clearOpenClawTestInvoker();
  });
});
