import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

function createFetchResponse(body: string, contentType: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': contentType,
    },
  });
}

function installBrandExampleFetchMock(): () => void {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

    if (url === 'https://brand.example/' || url === 'https://brand.example') {
      return createFetchResponse(
        `<!doctype html>
        <html>
          <head>
            <title>Brand Example</title>
            <meta property="og:site_name" content="Brand Example" />
            <meta name="description" content="Brand Example helps teams launch proof-led campaigns." />
            <meta name="theme-color" content="#111111" />
            <link rel="canonical" href="https://brand.example/" />
            <link rel="icon" href="/assets/logo.svg" />
            <link rel="stylesheet" href="/assets/site.css" />
          </head>
          <body>
            <h1>Brand Example</h1>
            <img src="/assets/wordmark.png" alt="Brand Example wordmark" />
          </body>
        </html>`,
        'text/html; charset=utf-8',
      );
    }

    if (url === 'https://brand.example/assets/site.css') {
      return createFetchResponse(
        `:root { --brand-primary: #111111; --brand-secondary: #f4f4f4; --brand-accent: #c24d2c; }
         body { font-family: "Manrope", sans-serif; color: #111111; background: #f4f4f4; }`,
        'text/css; charset=utf-8',
      );
    }

    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
}

async function withRuntimeEnv<T>(run: (dataRoot: string) => Promise<T>): Promise<T> {
  const previousCodeRoot = process.env.CODE_ROOT;
  const previousDataRoot = process.env.DATA_ROOT;
  const previousOpenClawLobsterCwd = process.env.OPENCLAW_LOBSTER_CWD;
  const previousStage1CacheDir = process.env.LOBSTER_STAGE1_CACHE_DIR;
  const previousStage2CacheDir = process.env.LOBSTER_STAGE2_CACHE_DIR;
  const previousStage3CacheDir = process.env.LOBSTER_STAGE3_CACHE_DIR;
  const previousStage4CacheDir = process.env.LOBSTER_STAGE4_CACHE_DIR;
  const previousMarketingProvider = process.env.ARIES_MARKETING_EXECUTION_PROVIDER;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-verify-banned-'));

  process.env.CODE_ROOT = PROJECT_ROOT;
  process.env.DATA_ROOT = dataRoot;
  process.env.OPENCLAW_LOBSTER_CWD = path.join(PROJECT_ROOT, 'lobster');
  process.env.LOBSTER_STAGE1_CACHE_DIR = path.join(dataRoot, 'lobster-stage1-cache');
  process.env.LOBSTER_STAGE2_CACHE_DIR = path.join(dataRoot, 'lobster-stage2-cache');
  process.env.LOBSTER_STAGE3_CACHE_DIR = path.join(dataRoot, 'lobster-stage3-cache');
  process.env.LOBSTER_STAGE4_CACHE_DIR = path.join(dataRoot, 'lobster-stage4-cache');
  process.env.ARIES_MARKETING_EXECUTION_PROVIDER = 'hermes';

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

    if (previousMarketingProvider === undefined) {
      delete process.env.ARIES_MARKETING_EXECUTION_PROVIDER;
    } else {
      process.env.ARIES_MARKETING_EXECUTION_PROVIDER = previousMarketingProvider;
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
    const { __setMarketingExecutionPortForTests } = await import('../backend/marketing/orchestrator');
    let capturedArgsJson = '';
    const restoreFetch = installBrandExampleFetchMock();

    __setMarketingExecutionPortForTests(() => ({
      name: 'hermes' as const,
      async runPipeline(input) {
        capturedArgsJson = input.argsJson;
        return {
          kind: 'completed' as const,
          provider: 'hermes' as const,
          output: {
            ok: true,
            status: 'requires_approval' as const,
            workflowKey: 'marketing_pipeline',
            runId: 'verify-run',
            output: [{ accepted: true, run_id: 'verify-run' }],
            approval: {
              stage: 'strategy' as const,
              workflowStepId: 'approve_stage_2',
              prompt: 'Research is complete. Continue to brand analysis.',
              resumeToken: 'resume_verify_123',
            },
          },
        };
      },
      async resumePipeline() {
        throw new Error('not used in this test');
      },
      async submitNextStage() {
        throw new Error('not used in this test');
      },
      getCallbackUrl: () => 'https://aries.test/api/internal/hermes/runs',
      getSessionKey: () => 'main',
      async submitRawRun() {
        throw new Error('not used in this test');
      },
    }));

    try {
      const response = await handlePostMarketingJobs(
        new Request('http://localhost/api/marketing/jobs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            tenantId: 'forged_tenant',
            jobType: 'brand_campaign',
            payload: {
              brandUrl: 'https://brand.example',
              businessType: 'Test vertical',
              competitorUrl: 'https://betterup.com',
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
      const workflowArgs = JSON.parse(capturedArgsJson || '{}') as Record<string, unknown>;

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
      assert.equal(workflowArgs.brand_url, 'https://brand.example/');
      assert.equal(workflowArgs.competitor_url, 'https://betterup.com/');
      assert.equal(workflowArgs.competitor, 'https://betterup.com/');
      assert.equal('tenant_id' in workflowArgs, false);
    } finally {
      restoreFetch();
      __setMarketingExecutionPortForTests(null);
    }
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
