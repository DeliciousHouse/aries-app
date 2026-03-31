import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installMarketingBrandExampleFetchMock } from './helpers/install-marketing-brand-fetch-mock';
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
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-verify-banned-'));

  process.env.CODE_ROOT = PROJECT_ROOT;
  process.env.DATA_ROOT = dataRoot;
  process.env.OPENCLAW_LOBSTER_CWD = path.join(PROJECT_ROOT, 'lobster');
  process.env.LOBSTER_STAGE1_CACHE_DIR = path.join(dataRoot, 'lobster-stage1-cache');
  process.env.LOBSTER_STAGE2_CACHE_DIR = path.join(dataRoot, 'lobster-stage2-cache');
  process.env.LOBSTER_STAGE3_CACHE_DIR = path.join(dataRoot, 'lobster-stage3-cache');
  process.env.LOBSTER_STAGE4_CACHE_DIR = path.join(dataRoot, 'lobster-stage4-cache');

  const restoreBrandFetch = installMarketingBrandExampleFetchMock();
  try {
    return await run(dataRoot);
  } finally {
    restoreBrandFetch();
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

test('marketing job creation response omits banned runtime and tenant fields', async () => {
  await withRuntimeEnv(async () => {
    const { handlePostMarketingJobs } = await import('../app/api/marketing/jobs/handler');
    let captured: Record<string, unknown> | null = null;

    setOpenClawTestInvoker((payload) => {
      captured = payload;
      return {
        ok: true,
        status: 'ok',
        output: [{ accepted: true, approval_preview: { status: 'pending_human_review' }, run_id: 'verify-run' }],
        requiresApproval: { resumeToken: 'resume_verify_123' },
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
    const invokerPayload = captured as { args?: { pipeline?: string; argsJson?: string; action?: string } } | null;
    assert.equal(invokerPayload?.args?.pipeline, 'marketing-pipeline.lobster');
    const workflowArgs = JSON.parse(String(invokerPayload?.args?.argsJson ?? '{}')) as Record<string, unknown>;

    assert.equal(response.status, 202);
    assert.equal(body.marketing_job_status, 'accepted');
    assert.equal(body.approvalRequired, true);
    assert.equal('tenantId' in body, false);
    assert.equal('wiring' in body, false);
    assert.equal('runtimeArtifactPath' in body, false);
    assert.equal('runtimePath' in body, false);
    assert.equal('runtimePathDeprecated' in body, false);
    // Tenant id must come from session context, not a forged top-level JSON field.
    assert.equal(workflowArgs.brand_slug, 'tenant_real');
    assert.notEqual(workflowArgs.brand_slug, 'forged_tenant');
    assert.equal(String(workflowArgs.brand_url).replace(/\/$/, ''), 'https://brand.example');
    assert.equal(workflowArgs.competitor, 'https://facebook.com/competitor');
    assert.equal('tenant_id' in workflowArgs, false);
  });
});

test('marketing job status response omits banned path leakage fields', async () => {
  await withRuntimeEnv(async (dataRoot) => {
    const { handleGetMarketingJobStatus } = await import('../app/api/marketing/jobs/[jobId]/handler');
    const jobId = 'mkt_verify_safe_job';
    const runId = 'verify-run-123';
    const runtimeFile = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs', `${jobId}.json`);
    const launchPreviewPath = path.join(dataRoot, 'launch-review-preview.txt');

    await mkdir(path.dirname(runtimeFile), { recursive: true });
    await writeFile(launchPreviewPath, 'Campaign: Demo launch\nApproval state: pending_human_review\n', 'utf8');
    await writeFile(
      runtimeFile,
      JSON.stringify({
        schema_name: 'job_runtime_state_schema',
        schema_version: '1.0.0',
        job_id: jobId,
        job_type: 'brand_campaign',
        tenant_id: 'tenant_real',
        state: 'approval_required',
        status: 'awaiting_approval',
        attempt: 1,
        max_attempts: 3,
        current_stage: 'publish',
        stage_order: ['research', 'strategy', 'production', 'publish'],
        stages: {
          research: { stage: 'research', status: 'completed', artifacts: [], outputs: {}, errors: [] },
          strategy: { stage: 'strategy', status: 'completed', artifacts: [], outputs: {}, errors: [] },
          production: { stage: 'production', status: 'completed', artifacts: [], outputs: {}, errors: [] },
          publish: { 
            stage: 'publish', 
            status: 'awaiting_approval', 
            outputs: {},
            errors: [],
            artifacts: [
              {
                id: 'launch-review',
                stage: 'publish',
                title: 'Launch Review',
                category: 'review',
                status: 'ready',
                summary: 'Review the launch preview.',
                details: [],
                preview_path: launchPreviewPath
              }
            ] 
          },
        },
        approvals: {
          current: {
            stage: 'publish',
            status: 'awaiting_approval',
            title: 'Launch approval required',
            message: 'Approval needed before publish-ready assets are generated.',
            requested_at: new Date().toISOString()
          },
          history: []
        },
        publish_config: {
          platforms: ['meta-ads'],
          live_publish_platforms: [],
          video_render_platforms: []
        },
        inputs: { request: {} },
        errors: [],
        last_error: null,
        history: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, null, 2)
    );

    await mkdir(path.dirname(stageStepPath(dataRoot, 4, runId, 'launch_review_preview')), { recursive: true });
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
    assert.equal(body.approvalRequired, true);
    assert.equal('tenantId' in body, false);
    assert.equal('runtimeArtifactPath' in body, false);
    assert.equal('runtimePath' in body, false);
    assert.equal('runtimePathDeprecated' in body, false);
  });
});
