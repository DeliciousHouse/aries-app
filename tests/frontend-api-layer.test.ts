import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { POST as postOnboardingStart } from '../app/api/onboarding/start/route';
import { GET as getOnboardingStatus } from '../app/api/onboarding/status/[tenantId]/route';
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

async function withRuntimeEnv<T>(run: (dataRoot: string) => Promise<T>): Promise<T> {
  const previousCodeRoot = process.env.CODE_ROOT;
  const previousDataRoot = process.env.DATA_ROOT;
  const previousOpenClawLobsterCwd = process.env.OPENCLAW_LOBSTER_CWD;
  const previousStage1CacheDir = process.env.LOBSTER_STAGE1_CACHE_DIR;
  const previousStage2CacheDir = process.env.LOBSTER_STAGE2_CACHE_DIR;
  const previousStage3CacheDir = process.env.LOBSTER_STAGE3_CACHE_DIR;
  const previousStage4CacheDir = process.env.LOBSTER_STAGE4_CACHE_DIR;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-frontend-api-'));

  process.env.CODE_ROOT = PROJECT_ROOT;
  process.env.DATA_ROOT = dataRoot;
  process.env.OPENCLAW_LOBSTER_CWD = path.join(PROJECT_ROOT, 'lobster');
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

    if (previousOpenClawLobsterCwd === undefined) {
      delete process.env.OPENCLAW_LOBSTER_CWD;
    } else {
      process.env.OPENCLAW_LOBSTER_CWD = previousOpenClawLobsterCwd;
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

function installMarketingPipelineInvoker(capture: { value: Record<string, unknown> | null }): void {
  setOpenClawTestInvoker((payload) => {
    capture.value = payload;
    const pipeline = String((payload as any)?.args?.pipeline || '');
    switch (pipeline) {
      case 'stage-1-research/workflow.lobster':
        return { ok: true, status: 'ok', output: [{ run_id: 'run-research' }], requiresApproval: null };
      case 'stage-2-strategy/review-workflow.lobster':
        return { ok: true, status: 'ok', output: [{ run_id: 'run-strategy', approval_preview: { status: 'pending_human_review', message: 'Strategy review is ready for approval.' } }], requiresApproval: null };
      case 'stage-2-strategy/finalize-workflow.lobster':
        return { ok: true, status: 'ok', output: [{ run_id: 'run-strategy', strategy_handoff: { run_id: 'run-strategy', core_message: 'Launch campaigns with operator control.', primary_cta: 'Book a walkthrough' } }], requiresApproval: null };
      case 'stage-3-production/review-workflow.lobster':
        return { ok: true, status: 'ok', output: [{ run_id: 'run-production', approval_preview: { status: 'pending_human_review', message: 'Production review is ready for approval.' } }], requiresApproval: null };
      case 'stage-3-production/finalize-workflow.lobster':
        return { ok: true, status: 'ok', output: [{ run_id: 'run-production', production_handoff: { run_id: 'run-production', production_brief: { core_message: 'Launch campaigns with operator control.' }, contract_handoffs: { static: { platform_contract_paths: ['output/static/meta-ads.json'] }, video: { platform_contract_paths: ['output/video/tiktok.json'] } } } }], requiresApproval: null };
      case 'stage-4-publish-optimize/review-workflow.lobster':
        return { ok: true, status: 'ok', output: [{ run_id: 'run-publish', approval_preview: { status: 'pending_human_review', message: 'Launch approval is required before publishing.' } }], requiresApproval: null };
      case 'stage-4-publish-optimize/publish-workflow.lobster':
        return { ok: true, status: 'ok', output: [{ run_id: 'run-publish', summary: { message: 'Selected platform packages are ready.' } }], requiresApproval: null };
      default:
        throw new Error(`Unexpected marketing pipeline ${pipeline}`);
    }
  });
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
    const capture = { value: null as Record<string, unknown> | null };
    installMarketingPipelineInvoker(capture);

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
    const workflowArgs = JSON.parse(String((capture.value as any)?.args?.argsJson)) as Record<string, unknown>;

    assert.equal(response.status, 202);
    assert.equal(body.marketing_job_status, 'accepted');
    assert.equal(body.jobType, 'brand_campaign');
    assert.equal(body.marketing_stage, 'strategy');
    assert.equal(body.approvalRequired, true);
    assert.equal((body.approval as any).stage, 'strategy');
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
    assert.equal((captured as any)?.args?.cwd, path.join(PROJECT_ROOT, 'lobster'));
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
    const runtimeFile = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs', `${jobId}.json`);
    await mkdir(path.dirname(runtimeFile), { recursive: true });
    const launchPreviewPath = path.join(dataRoot, 'launch-review-preview.txt');
    await writeFile(launchPreviewPath, 'Campaign: Demo launch\nApproval state: pending_human_review\n', 'utf8');

    await writeFile(
      runtimeFile,
      JSON.stringify({
        schema_name: 'marketing_job_state_schema',
        schema_version: '1.0.0',
        job_id: jobId,
        job_type: 'brand_campaign',
        tenant_id: 'tenant_real',
        state: 'approval_required',
        status: 'awaiting_approval',
        current_stage: 'publish',
        stage_order: ['research', 'strategy', 'production', 'publish'],
        stages: {
          research: { stage: 'research', status: 'completed', started_at: '2026-03-19T00:00:01.000Z', completed_at: '2026-03-19T00:00:01.000Z', failed_at: null, run_id: 'run-research', summary: { summary: 'Competitor leans on practical outcomes.', highlight: 'Proof-led hooks are winning.' }, primary_output: null, outputs: {}, artifacts: [{ id: 'research-summary', stage: 'research', title: 'Competitor research summary', category: 'analysis', status: 'completed', summary: 'Competitor leans on practical outcomes.', details: ['Competitor: CompetitorCo', 'Ads reviewed: 6'] }], errors: [] },
          strategy: { stage: 'strategy', status: 'completed', started_at: '2026-03-19T00:00:02.000Z', completed_at: '2026-03-19T00:00:02.000Z', failed_at: null, run_id: 'run-strategy', summary: { summary: 'Launch campaigns with operator control.', highlight: 'Book a walkthrough' }, primary_output: null, outputs: {}, artifacts: [{ id: 'strategy-plan', stage: 'strategy', title: 'Campaign strategy', category: 'brief', status: 'completed', summary: 'Launch campaigns with operator control.', details: ['In-house marketing teams', 'Primary CTA: Book a walkthrough'] }], errors: [] },
          production: { stage: 'production', status: 'completed', started_at: '2026-03-19T00:00:03.000Z', completed_at: '2026-03-19T00:00:03.000Z', failed_at: null, run_id: 'run-production', summary: { summary: 'Proof-led launch package', highlight: 'Ship the campaign with confidence' }, primary_output: null, outputs: {}, artifacts: [{ id: 'production-review', stage: 'production', title: 'Production review packet', category: 'review', status: 'completed', summary: 'Proof-led launch package', details: ['Landing page headline: Ship the campaign with confidence'], preview_path: launchPreviewPath }, { id: 'video-contracts', stage: 'production', title: 'Video contract handoff', category: 'contracts', status: 'completed', summary: '2 video platform contract(s) prepared.', details: ['YouTube Shorts', 'TikTok'] }], errors: [] },
          publish: { stage: 'publish', status: 'awaiting_approval', started_at: '2026-03-19T00:00:05.000Z', completed_at: null, failed_at: null, run_id: 'run-publish', summary: { summary: 'Approval needed before publish-ready assets are generated.', highlight: 'Static contracts: 7, Video contracts: 2' }, primary_output: null, outputs: {}, artifacts: [{ id: 'launch-review', stage: 'publish', title: 'Launch review package', category: 'approval', status: 'awaiting_approval', summary: 'Approval needed before publish-ready assets are generated.', details: ['Static contracts: 7', 'Video contracts: 2'], preview_path: launchPreviewPath }], errors: [] }
        },
        approvals: {
          current: {
            stage: 'publish',
            status: 'awaiting_approval',
            title: 'Launch approval required',
            message: 'Approval needed before publish-ready assets are generated.',
            requested_at: '2026-03-19T00:00:05.000Z',
            action_label: 'Approve launch',
            publish_config: {
              platforms: ['meta-ads', 'tiktok'],
              live_publish_platforms: [],
              video_render_platforms: [],
            },
          },
          history: [],
        },
        publish_config: {
          platforms: ['meta-ads', 'tiktok'],
          live_publish_platforms: [],
          video_render_platforms: [],
        },
        inputs: {
          request: {},
        },
        errors: [],
        last_error: null,
        history: [],
        created_at: '2026-03-19T00:00:00.000Z',
        updated_at: '2026-03-19T00:00:05.000Z',
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
    assert.equal((body.summary as any).headline, 'Publish stage is ready for approval');
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
        schema_name: 'marketing_job_state_schema',
        schema_version: '1.0.0',
        job_id: jobId,
        job_type: 'brand_campaign',
        tenant_id: 'tenant_other',
        state: 'running',
        status: 'running',
        current_stage: 'research',
        stage_order: ['research', 'strategy', 'production', 'publish'],
        stages: {
          research: { stage: 'research', status: 'in_progress', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          strategy: { stage: 'strategy', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          production: { stage: 'production', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          publish: { stage: 'publish', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
        },
        approvals: { current: null, history: [] },
        publish_config: { platforms: ['meta-ads'], live_publish_platforms: [], video_render_platforms: [] },
        inputs: { request: {} },
        errors: [],
        last_error: null,
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
    const { handlePostMarketingJobs } = await import('../app/api/marketing/jobs/handler');
    const { handleApproveMarketingJob } = await import('../app/api/marketing/jobs/[jobId]/approve/handler');
    const capture = { value: null as Record<string, unknown> | null };
    installMarketingPipelineInvoker(capture);

    const created = await handlePostMarketingJobs(
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
      async () => ({
        userId: 'user_123',
        tenantId: 'tenant_real',
        tenantSlug: 'acme',
        role: 'tenant_admin',
      })
    );
    const createdBody = (await created.json()) as Record<string, unknown>;
    const jobId = String(createdBody.jobId);

    await handleApproveMarketingJob(
      jobId,
      new Request(`http://localhost/api/marketing/jobs/${jobId}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          approvedBy: 'operator',
          approvedStages: ['strategy'],
        }),
      }),
      async () => ({
        userId: 'user_123',
        tenantId: 'tenant_real',
        tenantSlug: 'acme',
        role: 'tenant_admin',
      })
    );

    await handleApproveMarketingJob(
      jobId,
      new Request(`http://localhost/api/marketing/jobs/${jobId}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          approvedBy: 'operator',
          approvedStages: ['production'],
        }),
      }),
      async () => ({
        userId: 'user_123',
        tenantId: 'tenant_real',
        tenantSlug: 'acme',
        role: 'tenant_admin',
      })
    );

    const response = await handleApproveMarketingJob(
      jobId,
      new Request(`http://localhost/api/marketing/jobs/${jobId}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tenantId: 'forged_tenant',
          approvedBy: 'operator',
          approvedStages: ['publish'],
          publishConfig: {
            platforms: ['meta-ads', 'tiktok'],
            livePublishPlatforms: ['meta-ads'],
            videoRenderPlatforms: ['tiktok'],
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

    assert.equal(response.status, 200);
    assert.equal(body.approval_status, 'resumed');
    assert.equal(body.jobId, jobId);
    assert.equal(typeof body.jobStatusUrl, 'string');
    assert.equal('tenantId' in body, false);
    assert.equal((capture.value as any)?.args?.pipeline, 'stage-4-publish-optimize/publish-workflow.lobster');
    const workflowArgs = JSON.parse(String((capture.value as any)?.args?.argsJson)) as Record<string, unknown>;
    assert.equal(workflowArgs.meta_ads_live_publish_requested, true);
    assert.equal(workflowArgs.tiktok_render_requested, true);
    clearOpenClawTestInvoker();
  });
});
