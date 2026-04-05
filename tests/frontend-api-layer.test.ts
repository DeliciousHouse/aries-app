import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
            <a href="https://instagram.com/brandexample">Book a walkthrough</a>
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
  const previousLocalLobsterCwd = process.env.OPENCLAW_LOCAL_LOBSTER_CWD;
  const previousOpenClawLobsterCwd = process.env.OPENCLAW_LOBSTER_CWD;
  const previousStage1CacheDir = process.env.LOBSTER_STAGE1_CACHE_DIR;
  const previousStage2CacheDir = process.env.LOBSTER_STAGE2_CACHE_DIR;
  const previousStage3CacheDir = process.env.LOBSTER_STAGE3_CACHE_DIR;
  const previousStage4CacheDir = process.env.LOBSTER_STAGE4_CACHE_DIR;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-frontend-api-'));
  const lobsterRoot = path.join(dataRoot, 'lobster');

  process.env.CODE_ROOT = PROJECT_ROOT;
  process.env.DATA_ROOT = dataRoot;
  process.env.OPENCLAW_LOCAL_LOBSTER_CWD = lobsterRoot;
  process.env.OPENCLAW_LOBSTER_CWD = lobsterRoot;
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

    if (previousLocalLobsterCwd === undefined) {
      delete process.env.OPENCLAW_LOCAL_LOBSTER_CWD;
    } else {
      process.env.OPENCLAW_LOCAL_LOBSTER_CWD = previousLocalLobsterCwd;
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

/**
 * Mirrors backend/marketing/orchestrator: one `marketing-pipeline.lobster` run to reach the first
 * human gate, then `resume` + resume-token approvals for strategy → production → publish.
 */
function installMarketingPipelineInvoker(
  capture: { value: Record<string, unknown> | null },
  actionLog?: string[]
): void {
  setOpenClawTestInvoker((payload) => {
    capture.value = payload;
    const args = (payload as { args?: Record<string, unknown> }).args ?? {};
    const action = String(args.action || '');
    actionLog?.push(action);

    if (action === 'run') {
      return {
        ok: true,
        status: 'needs_approval',
        output: [
          {
            run_id: 'run-research',
            executive_summary: {
              market_positioning: 'Competitor leans on practical outcomes.',
              campaign_takeaway: 'Proof-led hooks are winning.',
            },
          },
        ],
        requiresApproval: {
          resumeToken: 'resume_strategy',
          prompt: 'Research complete. Approve strategy to continue.',
        },
      };
    }

    if (action === 'resume') {
      const token = String(args.token || '');
      if (token === 'resume_strategy') {
        return {
          ok: true,
          status: 'needs_approval',
          output: [
            {
              run_id: 'run-strategy',
              strategy_handoff: {
                run_id: 'run-strategy',
                core_message: 'Launch campaigns with operator control.',
                primary_cta: 'Book a walkthrough',
              },
            },
          ],
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
          output: [
            {
              run_id: 'run-production',
              production_handoff: {
                run_id: 'run-production',
                production_brief: { core_message: 'Launch campaigns with operator control.' },
                contract_handoffs: {
                  static: { platform_contract_paths: ['output/static/meta-ads.json'] },
                  video: { platform_contract_paths: ['output/video/tiktok.json'] },
                },
              },
            },
          ],
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
          output: [{ run_id: 'run-publish', summary: { message: 'Selected platform packages are ready.' } }],
          requiresApproval: null,
        };
      }
    }

    throw new Error(`Unexpected OpenClaw lobster invocation: ${action} ${JSON.stringify(args)}`);
  });
}

function makeApprovalReviewRuntimeDoc(input: {
  dataRoot: string;
  jobId: string;
  tenantId: string;
  resumeToken?: string;
}) {
  return {
    schema_name: 'marketing_job_state_schema',
    schema_version: '1.0.0',
    job_id: input.jobId,
    job_type: 'brand_campaign',
    tenant_id: input.tenantId,
    state: 'approval_required',
    status: 'awaiting_approval',
    current_stage: 'strategy',
    stage_order: ['research', 'strategy', 'production', 'publish'],
    stages: {
      research: { stage: 'research', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-r', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
      strategy: { stage: 'strategy', status: 'awaiting_approval', started_at: null, completed_at: null, failed_at: null, run_id: 'run-s', summary: { summary: 'Strategy is ready for approval.', highlight: null }, primary_output: null, outputs: {}, artifacts: [], errors: [] },
      production: { stage: 'production', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
      publish: { stage: 'publish', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
    },
    approvals: {
      current: {
        stage: 'strategy',
        status: 'awaiting_approval',
        title: 'Strategy approval required',
        message: 'Approve the strategy handoff before production can begin.',
        requested_at: '2026-03-20T00:00:00.000Z',
        resume_token: input.resumeToken ?? null,
        action_label: 'Approve strategy',
        publish_config: { platforms: ['meta-ads'], live_publish_platforms: [], video_render_platforms: [] },
      },
      history: [],
    },
    publish_config: { platforms: ['meta-ads'], live_publish_platforms: [], video_render_platforms: [] },
    brand_kit: {
      path: path.join(input.dataRoot, 'generated', 'validated', input.tenantId, 'brand-kit.json'),
      source_url: `https://${input.tenantId}.example.com`,
      canonical_url: `https://${input.tenantId}.example.com`,
      brand_name: 'Brand Example',
      logo_urls: [],
      colors: { primary: '#9c6b3e', secondary: '#f3e9dd', accent: '#3d2410', palette: ['#9c6b3e', '#f3e9dd', '#3d2410'] },
      font_families: ['Manrope'],
      external_links: [],
      extracted_at: '2026-03-18T00:00:00.000Z',
    },
    inputs: { request: {}, brand_url: `https://${input.tenantId}.example.com` },
    errors: [],
    last_error: null,
    history: [],
    created_at: '2026-03-20T00:00:00.000Z',
    updated_at: '2026-03-20T00:00:00.000Z',
  };
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
    const restoreFetch = installBrandExampleFetchMock();

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
              competitorUrl: 'https://betterup.com',
              competitorBrand: 'BetterUp',
              competitorFacebookUrl: 'https://facebook.com/betterupco',
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
      const invokeArgs = (capture.value as { args?: Record<string, unknown> })?.args;
      const workflowArgs = JSON.parse(String(invokeArgs?.argsJson ?? '{}')) as Record<string, unknown>;

      assert.equal(response.status, 202);
      assert.equal(body.marketing_job_status, 'accepted');
      assert.equal(body.jobType, 'brand_campaign');
      assert.equal(body.marketing_stage, 'strategy');
      assert.equal(body.approvalRequired, true);
      assert.equal((body.approval as { stage?: string }).stage, 'strategy');
      assert.equal(typeof body.jobStatusUrl, 'string');
      assert.equal('tenantId' in body, false);
      assert.equal('wiring' in body, false);
      assert.equal('runtimeArtifactPath' in body, false);
      assert.equal('runtimePath' in body, false);
      assert.equal('runtimePathDeprecated' in body, false);
      assert.equal(String(body.jobId).includes('tenant_real'), false);
      assert.equal(invokeArgs?.action, 'run');
      assert.equal(invokeArgs?.pipeline, 'marketing-pipeline.lobster');
      assert.equal(workflowArgs.brand_url, 'https://brand.example/');
      assert.equal(workflowArgs.competitor_url, 'https://betterup.com/');
      assert.equal(workflowArgs.competitor_brand, 'BetterUp');
      assert.equal(workflowArgs.facebook_page_url, 'https://facebook.com/betterupco');
      assert.equal(workflowArgs.competitor, 'https://betterup.com/');
      assert.equal(workflowArgs.competitor_facebook_url, 'https://facebook.com/betterupco');
      assert.equal(workflowArgs.brand_slug, 'tenant_real');
      assert.equal(invokeArgs?.cwd, process.env.OPENCLAW_LOBSTER_CWD);
    } finally {
      restoreFetch();
      clearOpenClawTestInvoker();
    }
  });
});

test('/api/marketing/jobs rejects Facebook URLs in competitorUrl with a precise validation error', async () => {
  await withRuntimeEnv(async () => {
    const { handlePostMarketingJobs } = await import('../app/api/marketing/jobs/handler');

    const response = await handlePostMarketingJobs(
      new Request('http://localhost/api/marketing/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jobType: 'brand_campaign',
          payload: {
            brandUrl: 'https://brand.example',
            competitorUrl: 'https://www.facebook.com/betterupco',
          },
        }),
      }),
      async () => ({
        userId: 'user_123',
        tenantId: 'tenant_real',
        tenantSlug: 'acme',
        role: 'tenant_admin',
      }),
    );
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 400);
    assert.equal(body.error, "competitor_url must be the competitor's website, not a Facebook or Ad Library URL");
  });
});

test('/api/marketing/jobs persists present onboarding setup fields into the authenticated business-profile record', async () => {
  await withRuntimeEnv(async () => {
    const { handlePostMarketingJobs } = await import('../app/api/marketing/jobs/handler');
    const { loadMarketingJobRuntime } = await import('../backend/marketing/runtime-state');
    const capture = { value: null as Record<string, unknown> | null };
    installMarketingPipelineInvoker(capture);
    const restoreFetch = installBrandExampleFetchMock();
    const businessProfilePath = path.join(
      process.env.DATA_ROOT!,
      'generated',
      'validated',
      'tenant_real',
      'business-profile.json',
    );

    try {
      await mkdir(path.dirname(businessProfilePath), { recursive: true });
      await writeFile(
        businessProfilePath,
        JSON.stringify({
          tenant_id: 'tenant_real',
          business_name: null,
          tenant_slug: 'acme',
          website_url: 'https://brand.example/',
          business_type: 'legacy-type',
          primary_goal: 'legacy-goal',
          launch_approver_user_id: null,
          launch_approver_name: 'Legacy Approver',
          offer: 'Legacy offer',
          notes: null,
          competitor_url: 'https://legacy.example/',
          channels: ['legacy-channel'],
          updated_at: '2026-03-30T10:00:00.000Z',
        }, null, 2),
      );

      const response = await handlePostMarketingJobs(
        new Request('http://localhost/api/marketing/jobs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jobType: 'brand_campaign',
            payload: {
              brandUrl: 'https://brand.example',
              businessType: 'coaching',
              primaryGoal: 'book more calls',
              launchApproverName: 'Avery Example',
              offer: 'Operator-led launch intensives',
              competitorUrl: 'https://competitor.example',
              channels: ['meta-ads', 'instagram'],
            },
          }),
        }),
        async () => ({
          userId: 'user_123',
          tenantId: 'tenant_real',
          tenantSlug: 'acme',
          role: 'tenant_admin',
        }),
      );
      const body = (await response.json()) as Record<string, unknown>;
      const runtimeDoc = loadMarketingJobRuntime(String(body.jobId));
      const persistedRecord = JSON.parse(await readFile(businessProfilePath, 'utf8')) as Record<string, unknown>;

      assert.equal(response.status, 202);
      assert.equal(persistedRecord.business_type, 'coaching');
      assert.equal(persistedRecord.primary_goal, 'book more calls');
      assert.equal(persistedRecord.launch_approver_name, 'Avery Example');
      assert.equal(persistedRecord.offer, 'Operator-led launch intensives');
      assert.equal(persistedRecord.competitor_url, 'https://competitor.example/');
      assert.deepEqual(persistedRecord.channels, ['meta-ads', 'instagram']);
      assert.equal(runtimeDoc?.inputs.request.primaryGoal, 'book more calls');
      assert.equal(runtimeDoc?.inputs.request.goal, 'book more calls');
      assert.equal(runtimeDoc?.inputs.request.launchApproverName, 'Avery Example');
      assert.equal(runtimeDoc?.inputs.request.approverName, 'Avery Example');
      assert.equal(runtimeDoc?.inputs.request.businessType, 'coaching');
      assert.equal(runtimeDoc?.inputs.request.offer, 'Operator-led launch intensives');
      assert.equal(runtimeDoc?.inputs.request.competitorUrl, 'https://competitor.example/');
      assert.deepEqual(runtimeDoc?.inputs.request.channels, ['meta-ads', 'instagram']);
    } finally {
      restoreFetch();
      clearOpenClawTestInvoker();
    }
  });
});

test('/api/marketing/jobs returns onboarding_required when tenant context has not been established', async () => {
  const { handlePostMarketingJobs } = await import('../app/api/marketing/jobs/handler');
  const { TenantContextError } = await import('../lib/tenant-context');
  const response = await handlePostMarketingJobs(
    new Request('http://localhost/api/marketing/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jobType: 'brand_campaign',
        payload: {
          brandUrl: 'https://brand.example',
          competitorUrl: 'https://betterup.com',
        },
      }),
    }),
    async () => {
      throw new TenantContextError(
        'tenant_membership_missing',
        'No tenant membership found for authenticated user.',
      );
    }
  );
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 409);
  assert.equal(body.status, 'error');
  assert.equal(body.reason, 'onboarding_required');
  assert.equal(body.message, 'Complete tenant onboarding before starting a brand campaign.');
});

test('/api/marketing/jobs/latest returns the most recent campaign for the authenticated tenant', async () => {
  await withRuntimeEnv(async () => {
    const { handleGetLatestMarketingJobStatus } = await import('../app/api/marketing/jobs/latest/handler');
    const jobsRoot = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs');
    await mkdir(jobsRoot, { recursive: true });

    const makeRuntimeDoc = (jobId: string, tenantId: string, updatedAt: string) => ({
      schema_name: 'marketing_job_state_schema',
      schema_version: '1.0.0',
      job_id: jobId,
      job_type: 'brand_campaign',
      tenant_id: tenantId,
      state: 'approval_required',
      status: 'awaiting_approval',
      current_stage: 'publish',
      stage_order: ['research', 'strategy', 'production', 'publish'],
      stages: {
        research: { stage: 'research', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-r', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
        strategy: { stage: 'strategy', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-s', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
        production: { stage: 'production', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-p', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
        publish: { stage: 'publish', status: 'awaiting_approval', started_at: null, completed_at: null, failed_at: null, run_id: 'run-publish', summary: { summary: 'Approval needed', highlight: null }, primary_output: null, outputs: {}, artifacts: [], errors: [] },
      },
      approvals: {
        current: {
          stage: 'publish',
          status: 'awaiting_approval',
          title: 'Launch approval required',
          message: 'Approval needed before publish-ready assets are generated.',
          requested_at: updatedAt,
          resume_token: 'resume_publish',
          action_label: 'Approve launch',
          publish_config: { platforms: ['meta-ads'], live_publish_platforms: [], video_render_platforms: [] },
        },
        history: [],
      },
      publish_config: { platforms: ['meta-ads'], live_publish_platforms: [], video_render_platforms: [] },
      brand_kit: {
        path: path.join(process.env.DATA_ROOT!, 'generated', 'validated', tenantId, 'brand-kit.json'),
        source_url: `https://${tenantId}.example.com`,
        canonical_url: `https://${tenantId}.example.com`,
        brand_name: tenantId === 'tenant_real' ? 'Sugar & Leather' : 'Other Tenant',
        logo_urls: [],
        colors: { primary: '#9c6b3e', secondary: '#f3e9dd', accent: '#3d2410', palette: ['#9c6b3e', '#f3e9dd', '#3d2410'] },
        font_families: ['Manrope'],
        external_links: [],
        extracted_at: '2026-03-18T00:00:00.000Z',
      },
      inputs: { request: {}, brand_url: `https://${tenantId}.example.com` },
      errors: [],
      last_error: null,
      history: [],
      created_at: updatedAt,
      updated_at: updatedAt,
    });

    await writeFile(path.join(jobsRoot, 'mkt_old.json'), JSON.stringify(makeRuntimeDoc('mkt_old', 'tenant_real', '2026-04-01T00:00:00.000Z'), null, 2));
    await writeFile(path.join(jobsRoot, 'mkt_latest.json'), JSON.stringify(makeRuntimeDoc('mkt_latest', 'tenant_real', '2026-04-05T00:00:00.000Z'), null, 2));
    await writeFile(path.join(jobsRoot, 'mkt_other.json'), JSON.stringify(makeRuntimeDoc('mkt_other', 'tenant_other', '2026-04-10T00:00:00.000Z'), null, 2));

    const response = await handleGetLatestMarketingJobStatus(async () => ({
      userId: 'user_123',
      tenantId: 'tenant_real',
      tenantSlug: 'sugarandleather',
      role: 'tenant_admin',
    }));
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 200);
    assert.equal(body.jobId, 'mkt_latest');
    assert.equal(body.tenantName, 'Sugar & Leather');
    assert.equal(body.brandWebsiteUrl, 'https://tenant_real.example.com');
  });
});

test('/api/marketing/jobs/:jobId and /latest block downstream approval metadata when strategy changes are requested', async () => {
  await withRuntimeEnv(async (dataRoot) => {
    const { handleGetMarketingJobStatus } = await import('../app/api/marketing/jobs/[jobId]/handler');
    const { handleGetLatestMarketingJobStatus } = await import('../app/api/marketing/jobs/latest/handler');
    const {
      ensureCampaignWorkspaceRecord,
      saveCampaignWorkspaceRecord,
      setStageReviewDecision,
    } = await import('../backend/marketing/workspace-store');
    const jobId = 'mkt_strategy_revisions_requested_api';
    const tenantId = 'tenant_real';
    const stage2RunId = 'run-strategy-revisions-api';
    const runtimeFile = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs', `${jobId}.json`);
    const plannerPath = path.join(process.env.LOBSTER_STAGE2_CACHE_DIR!, stage2RunId, 'campaign_planner.json');
    const strategyReviewPath = path.join(process.env.LOBSTER_STAGE2_CACHE_DIR!, stage2RunId, 'strategy_review_preview.json');

    await mkdir(path.dirname(runtimeFile), { recursive: true });
    await mkdir(path.dirname(plannerPath), { recursive: true });
    await writeFile(
      plannerPath,
      JSON.stringify({
        campaign_plan: {
          campaign_name: 'Blocked Strategy Launch',
          objective: 'Drive qualified consultations',
          core_message: 'Real strategy is ready for review.',
          offer: 'Proof-led strategy sprint',
          primary_cta: 'Book now',
          channel_plans: [{ channel: 'meta-ads', goal: 'Leads', message: 'Operator proof' }],
        },
      }, null, 2),
    );
    await writeFile(
      strategyReviewPath,
      JSON.stringify({
        review_packet: {
          campaign_name: 'Blocked Strategy Launch',
          objective: 'Drive qualified consultations',
          channels_in_scope: ['meta-ads'],
        },
      }, null, 2),
    );
    await writeFile(
      runtimeFile,
      JSON.stringify({
        schema_name: 'marketing_job_state_schema',
        schema_version: '1.0.0',
        job_id: jobId,
        job_type: 'brand_campaign',
        tenant_id: tenantId,
        state: 'approval_required',
        status: 'awaiting_approval',
        current_stage: 'production',
        stage_order: ['research', 'strategy', 'production', 'publish'],
        stages: {
          research: { stage: 'research', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-r', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          strategy: { stage: 'strategy', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: stage2RunId, summary: null, primary_output: { run_id: stage2RunId }, outputs: {}, artifacts: [], errors: [] },
          production: { stage: 'production', status: 'awaiting_approval', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: { approval_id: 'mkta_strategy_api', workflow_step_id: 'approve_stage_3' }, artifacts: [], errors: [] },
          publish: { stage: 'publish', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
        },
        approvals: {
          current: {
            stage: 'production',
            status: 'awaiting_approval',
            approval_id: 'mkta_strategy_api',
            workflow_name: 'marketing-pipeline',
            workflow_step_id: 'approve_stage_3',
            title: 'Strategy review required',
            message: 'Review the campaign proposal before production begins.',
            requested_at: '2026-03-30T10:00:00.000Z',
            resume_token: 'resume-strategy-api',
            action_label: 'Review strategy',
            publish_config: null,
          },
          history: [],
        },
        publish_config: { platforms: ['meta-ads'], live_publish_platforms: ['meta-ads'], video_render_platforms: [] },
        brand_kit: {
          path: path.join(dataRoot, 'generated', 'validated', tenantId, 'brand-kit.json'),
          source_url: 'https://brand.example',
          canonical_url: 'https://brand.example',
          brand_name: 'Brand Example',
          logo_urls: [],
          colors: { primary: '#111111', secondary: '#f4f4f4', accent: '#c24d2c', palette: ['#111111', '#f4f4f4', '#c24d2c'] },
          font_families: ['Manrope'],
          external_links: [],
          extracted_at: '2026-03-30T10:55:00.000Z',
        },
        inputs: {
          request: {
            brandUrl: 'https://brand.example',
            brandSlug: 'brand-runtime-first',
            competitorUrl: 'https://betterup.com',
          },
          brand_url: 'https://brand.example',
          competitor_url: 'https://betterup.com',
          competitor_facebook_url: null,
        },
        errors: [],
        last_error: null,
        history: [],
        created_at: '2026-03-30T09:50:00.000Z',
        updated_at: '2026-03-30T10:00:00.000Z',
      }, null, 2),
    );

    const workspace = ensureCampaignWorkspaceRecord({
      jobId,
      tenantId,
      payload: {
        brandUrl: 'https://brand.example',
      },
    });
    setStageReviewDecision(workspace, 'strategy', 'changes_requested', 'Avery Example', 'Needs revisions.');
    saveCampaignWorkspaceRecord(workspace);

    const byIdResponse = await handleGetMarketingJobStatus(
      jobId,
      async () => ({
        userId: 'user_123',
        tenantId,
        tenantSlug: 'acme',
        role: 'tenant_admin',
      }),
    );
    const byIdBody = (await byIdResponse.json()) as Record<string, any>;

    const latestResponse = await handleGetLatestMarketingJobStatus(
      async () => ({
        userId: 'user_123',
        tenantId,
        tenantSlug: 'acme',
        role: 'tenant_admin',
      }),
    );
    const latestBody = (await latestResponse.json()) as Record<string, any>;

    assert.equal(byIdResponse.status, 200);
    assert.equal(byIdBody.workflowState, 'revisions_requested');
    assert.equal(byIdBody.approvalRequired, false);
    assert.equal(byIdBody.nextStep, 'wait_for_completion');
    assert.equal(byIdBody.approval.status, 'changes_requested');
    assert.equal(byIdBody.approval.actionHref, undefined);
    assert.equal(byIdBody.dashboard.campaign.approvalRequired, false);
    assert.equal(byIdBody.dashboard.campaign.approvalActionHref, undefined);
    assert.equal(latestResponse.status, 200);
    assert.equal(latestBody.workflowState, 'revisions_requested');
    assert.equal(latestBody.approvalRequired, false);
    assert.equal(latestBody.nextStep, 'wait_for_completion');
    assert.equal(latestBody.approval.status, 'changes_requested');
    assert.equal(latestBody.approval.actionHref, undefined);
  });
});

test('/api/marketing/jobs/:jobId returns stage progress and safe artifact summaries for the current tenant', async () => {
  await withRuntimeEnv(async (dataRoot) => {
    const { handleGetMarketingJobStatus } = await import('../app/api/marketing/jobs/[jobId]/handler');
    const jobId = 'mkt_safe_job';
    const runtimeFile = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs', `${jobId}.json`);
    await mkdir(path.dirname(runtimeFile), { recursive: true });
    const launchPreviewPath = path.join(dataRoot, 'launch-review-preview.txt');
    const mediaAssetPath = path.join(dataRoot, 'meta-preview.png');
    const contractAssetPath = path.join(dataRoot, 'meta-contract.json');
    const briefAssetPath = path.join(dataRoot, 'meta-brief.md');
    const landingAssetPath = path.join(dataRoot, 'april-launch.html');
    await writeFile(launchPreviewPath, 'Campaign: Demo launch\nApproval state: pending_human_review\n', 'utf8');
    await writeFile(mediaAssetPath, 'png-preview', 'utf8');
    await writeFile(contractAssetPath, '{"contract":true}', 'utf8');
    await writeFile(briefAssetPath, '# brief', 'utf8');
    await writeFile(landingAssetPath, '<html>launch</html>', 'utf8');

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
          publish: { stage: 'publish', status: 'awaiting_approval', started_at: '2026-03-19T00:00:05.000Z', completed_at: null, failed_at: null, run_id: 'run-publish', summary: { summary: 'Approval needed before publish-ready assets are generated.', highlight: 'Static contracts: 7, Video contracts: 2' }, primary_output: null, outputs: { review: { review_bundle: { campaign_name: 'Sugar & Leather April Launch', generated_at: '2026-03-19T00:00:05.000Z', approval_message: 'Approval needed before publish-ready assets are generated.', summary: { core_message: 'Launch the April collection with luxury-first creative.', planned_posts: 12, created_posts: 8, campaign_window: { start: '2026-04-01T00:00:00.000Z', end: '2026-04-30T23:59:59.000Z' } }, content_calendar: { events: [ { id: 'evt_meta_1', starts_at: '2026-04-03T15:00:00.000Z', ends_at: '2026-04-03T15:30:00.000Z', platform: 'meta-ads', title: 'Launch collection carousel', status: 'planned', asset_preview_id: 'platform-preview-meta-ads-media-1' }, { id: 'evt_tt_1', starts_at: '2026-04-07T18:00:00.000Z', ends_at: null, platform: 'tiktok', title: 'Behind the scenes video', status: 'created', asset_preview_id: null } ] }, platform_previews: [ { platform_slug: 'meta-ads', platform_name: 'Meta Ads', channel_type: 'paid-social', summary: 'Carousel preview ready for launch.', headline: 'April collection launch', caption_text: 'Meet the April collection.', cta: 'Shop the drop', media_paths: [mediaAssetPath], asset_paths: { contract_path: contractAssetPath, brief_path: briefAssetPath, landing_page_path: landingAssetPath } } ] } } }, artifacts: [{ id: 'launch-review', stage: 'publish', title: 'Launch review package', category: 'approval', status: 'awaiting_approval', summary: 'Approval needed before publish-ready assets are generated.', details: ['Static contracts: 7', 'Video contracts: 2'], preview_path: launchPreviewPath }], errors: [] }
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
        brand_kit: {
          path: path.join(dataRoot, 'generated', 'validated', 'tenant_real', 'brand-kit.json'),
          source_url: 'https://sugarandleather.com',
          canonical_url: 'https://sugarandleather.com',
          brand_name: 'Sugar & Leather',
          logo_urls: ['https://sugarandleather.com/assets/logo-mark.svg'],
          colors: {
            primary: '#9c6b3e',
            secondary: '#f3e9dd',
            accent: '#3d2410',
            palette: ['#9c6b3e', '#f3e9dd', '#3d2410'],
          },
          font_families: ['Manrope', 'Cormorant Garamond'],
          external_links: [
            { platform: 'instagram', url: 'https://instagram.com/sugarandleather' },
          ],
          extracted_at: '2026-03-18T00:00:00.000Z',
        },
        inputs: {
          request: {},
          brand_url: 'https://sugarandleather.com',
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
    assert.equal(body.tenantName, 'Sugar & Leather');
    assert.equal(body.brandWebsiteUrl, 'https://sugarandleather.com');
    assert.deepEqual(body.campaignWindow, {
      start: '2026-04-01T00:00:00.000Z',
      end: '2026-04-30T23:59:59.000Z',
    });
    assert.equal(body.durationDays, 30);
    assert.equal(body.plannedPostCount, 12);
    assert.equal(body.createdPostCount, 8);
    assert.equal(Array.isArray(body.stageCards), true);
    assert.equal((body.stageCards as any[]).length, 4);
    assert.equal(Array.isArray(body.artifacts), true);
    assert.equal((body.artifacts as any[]).length > 0, true);
    assert.equal(Array.isArray(body.assetPreviewCards), true);
    assert.equal((body.assetPreviewCards as any[]).length, 1);
    assert.equal((body.assetPreviewCards as any[])[0].platformSlug, 'meta-ads');
    assert.equal((body.assetPreviewCards as any[])[0].mediaCount, 1);
    assert.equal((body.assetPreviewCards as any[])[0].previewHref, `/marketing/job-approve?jobId=${jobId}&preview=platform-preview-meta-ads`);
    assert.equal(Array.isArray(body.calendarEvents), true);
    assert.equal((body.calendarEvents as any[]).length, 2);
    assert.equal((body.calendarEvents as any[])[0].platform, 'meta-ads');
    assert.equal((body.reviewBundle as any).platformPreviews[0].mediaAssets[0].url, `/api/marketing/jobs/${jobId}/assets/platform-preview-meta-ads-media-1`);
    assert.equal((body.reviewBundle as any).platformPreviews[0].assetLinks[0].url, `/api/marketing/jobs/${jobId}/assets/platform-preview-meta-ads-asset-contract`);
    assert.equal('mediaPaths' in (body.reviewBundle as any).platformPreviews[0], false);
    assert.equal('assetPaths' in (body.reviewBundle as any).platformPreviews[0], false);
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

test('/api/marketing/jobs/:jobId surfaces launch review previews when completed publish output nests them under primary_output.launch_review', async () => {
  await withRuntimeEnv(async (dataRoot) => {
    const { handleGetMarketingJobStatus } = await import('../app/api/marketing/jobs/[jobId]/handler');
    const { handleGetMarketingJobAsset } = await import('../app/api/marketing/jobs/[jobId]/assets/[assetId]/handler');
    const jobId = 'mkt_completed_launch_review';
    const runtimeFile = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs', `${jobId}.json`);
    const publishImagePath = path.join(process.env.CODE_ROOT!, 'lobster', 'output', 'publish-ready', 'brand-example-stage2-plan', 'meta-ads', 'meta-ads.png');
    const legacyPreviewPath = path.join(process.env.CODE_ROOT!, 'aries-app', 'lobster', 'output', 'static-contracts', 'brand-example-stage2-plan', 'rendered', 'meta-ads', 'meta-ads.svg');
    await mkdir(path.dirname(runtimeFile), { recursive: true });
    await mkdir(path.dirname(publishImagePath), { recursive: true });
    await mkdir(path.join(process.env.LOBSTER_STAGE4_CACHE_DIR!, 'run-publish'), { recursive: true });
    await writeFile(publishImagePath, 'png-preview', 'utf8');
    await writeFile(
      path.join(process.env.LOBSTER_STAGE4_CACHE_DIR!, 'run-publish', 'meta_ads_publisher.json'),
      JSON.stringify({
        platform: 'meta-ads',
        generated_at: '2026-03-19T00:10:05.000Z',
        publish_package: {
          image_path: publishImagePath,
        },
      }, null, 2),
      'utf8',
    );
    await writeFile(
      runtimeFile,
      JSON.stringify({
        schema_name: 'marketing_job_state_schema',
        schema_version: '1.0.0',
        job_id: jobId,
        job_type: 'brand_campaign',
        tenant_id: 'tenant_real',
        state: 'completed',
        status: 'completed',
        current_stage: 'publish',
        stage_order: ['research', 'strategy', 'production', 'publish'],
        stages: {
          research: { stage: 'research', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-r', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          strategy: { stage: 'strategy', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-s', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          production: { stage: 'production', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-p', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          publish: {
            stage: 'publish',
            status: 'completed',
            started_at: '2026-03-19T00:00:05.000Z',
            completed_at: '2026-03-19T00:10:05.000Z',
            failed_at: null,
            run_id: 'run-publish',
            summary: { summary: 'Publish-ready assets created.' },
            primary_output: {
              launch_review: {
                generated_at: '2026-03-19T00:10:05.000Z',
                approval_preview: {
                  message: 'Launch review was approved.',
                },
                review_bundle: {
                  campaign_name: 'Sugar & Leather April Launch',
                  approval_message: 'Launch review was approved.',
                  summary: {
                    core_message: 'Launch the April collection with luxury-first creative.',
                  },
                  platform_previews: [
                    {
                      platform_slug: 'meta-ads',
                      platform_name: 'Meta Ads',
                      channel_type: 'paid-social',
                      summary: 'Carousel preview ready for launch.',
                      headline: 'April collection launch',
                      caption_text: 'Meet the April collection.',
                      cta: 'Shop the drop',
                      media_paths: [legacyPreviewPath],
                      asset_paths: {},
                    },
                  ],
                },
              },
            },
            outputs: {},
            artifacts: [],
            errors: [],
          },
        },
        approvals: { current: null, history: [] },
        publish_config: { platforms: ['meta-ads'], live_publish_platforms: ['meta-ads'], video_render_platforms: [] },
        brand_kit: {
          path: path.join(dataRoot, 'generated', 'validated', 'tenant_real', 'brand-kit.json'),
          source_url: 'https://sugarandleather.com',
          canonical_url: 'https://sugarandleather.com',
          brand_name: 'Sugar & Leather',
          logo_urls: [],
          colors: { primary: '#9c6b3e', secondary: '#f3e9dd', accent: '#3d2410', palette: ['#9c6b3e', '#f3e9dd', '#3d2410'] },
          font_families: ['Manrope'],
          external_links: [],
          extracted_at: '2026-03-18T00:00:00.000Z',
        },
        inputs: { request: {}, brand_url: 'https://sugarandleather.com' },
        errors: [],
        last_error: null,
        history: [],
        created_at: '2026-03-19T00:00:00.000Z',
        updated_at: '2026-03-19T00:10:05.000Z',
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
    const body = (await response.json()) as Record<string, any>;

    assert.equal(response.status, 200);
    assert.equal(body.marketing_job_status, 'completed');
    assert.equal(body.assetPreviewCards.length, 1);
    assert.equal(body.assetPreviewCards[0].platformSlug, 'meta-ads');
    assert.equal(body.reviewBundle.platformPreviews.length, 1);
    assert.equal(body.reviewBundle.platformPreviews[0].mediaAssets[0].url, `/api/marketing/jobs/${jobId}/assets/platform-preview-meta-ads-media-1`);
    assert.equal(body.reviewBundle.platformPreviews[0].mediaAssets[0].contentType, 'image/png');

    const assetResponse = await handleGetMarketingJobAsset(
      jobId,
      'platform-preview-meta-ads-media-1',
      async () => ({
        userId: 'user_123',
        tenantId: 'tenant_real',
        tenantSlug: 'acme',
        role: 'tenant_admin',
      })
    );
    assert.equal(assetResponse.status, 200);
    assert.equal(assetResponse.headers.get('content-type'), 'image/png');
    assert.equal(await assetResponse.text(), 'png-preview');
  });
});

test('/api/marketing/jobs/:jobId recovers paused-publish review previews from Stage 4 log artifacts when the runtime checkpoint stores only the approval envelope', async () => {
  await withRuntimeEnv(async (dataRoot) => {
    const { handleGetMarketingJobStatus } = await import('../app/api/marketing/jobs/[jobId]/handler');
    const jobId = 'mkt_publish_review_from_logs';
    const runtimeFile = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs', `${jobId}.json`);
    const runId = 'betterup-com-live';
    const logsRoot = path.join(process.env.OPENCLAW_LOBSTER_CWD!, 'output', 'logs', runId, 'stage-4-publish-optimize');
    const publishImagePath = path.join(process.env.CODE_ROOT!, 'lobster', 'output', 'publish-ready', 'brand-example-stage2-plan', 'meta-ads', 'meta-ads.png');
    await mkdir(path.dirname(runtimeFile), { recursive: true });
    await mkdir(logsRoot, { recursive: true });
    await mkdir(path.dirname(publishImagePath), { recursive: true });
    await writeFile(publishImagePath, 'png-preview', 'utf8');
    await writeFile(
      path.join(logsRoot, 'launch_review_preview.json'),
      JSON.stringify({
        generated_at: '2026-03-19T00:10:05.000Z',
        approval_preview: {
          message: 'Approve creation of the Meta campaigns, ad sets, and ads as PAUSED.',
        },
        review_bundle: {
          campaign_name: 'Sugar & Leather April Launch',
          approval_message: 'Approve creation of the Meta campaigns, ad sets, and ads as PAUSED.',
          summary: {
            core_message: 'Launch the April collection with luxury-first creative.',
          },
          platform_previews: [
            {
              platform_slug: 'meta-ads',
              platform_name: 'Meta Ads',
              channel_type: 'paid-social',
              summary: 'Carousel preview ready for paused publish.',
              headline: 'April collection launch',
              caption_text: 'Meet the April collection.',
              cta: 'Shop the drop',
              media_paths: [publishImagePath],
              asset_paths: {},
            },
          ],
        },
      }, null, 2)
    );
    await writeFile(
      path.join(logsRoot, 'performance_marketer_preflight.json'),
      JSON.stringify({
        run_id: runId,
        publish_plan: {
          static_contract_count: 6,
          video_contract_count: 2,
        },
      }, null, 2)
    );
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
          research: { stage: 'research', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-r', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          strategy: { stage: 'strategy', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-s', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          production: { stage: 'production', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-p', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          publish: {
            stage: 'publish',
            status: 'awaiting_approval',
            started_at: '2026-03-19T00:10:05.000Z',
            completed_at: null,
            failed_at: null,
            run_id: null,
            summary: { summary: 'Stage 4 pre-flight complete.' },
            primary_output: {},
            outputs: {
              envelope: {
                protocolVersion: 1,
                ok: true,
                status: 'needs_approval',
                output: [],
                requiresApproval: {
                  prompt: 'Approve creation of the Meta campaigns, ad sets, and ads as PAUSED.',
                  resumeToken: 'resume-publish-paused',
                },
              },
              approval_id: 'mkta_publish_paused',
              workflow_step_id: 'approve_stage_4_publish',
              resume_token: 'resume-publish-paused',
            },
            artifacts: [],
            errors: [],
          },
        },
        approvals: {
          current: {
            stage: 'publish',
            status: 'awaiting_approval',
            approval_id: 'mkta_publish_paused',
            workflow_step_id: 'approve_stage_4_publish',
            title: 'Publish to Meta (paused) approval required',
            message: 'Stage 4 pre-flight complete. Approve creation of the Meta campaigns, ad sets, and ads as PAUSED?',
            requested_at: '2026-03-19T00:10:05.000Z',
            resume_token: 'resume-publish-paused',
          },
          history: [],
        },
        publish_config: { platforms: ['meta-ads'], live_publish_platforms: ['meta-ads'], video_render_platforms: [] },
        brand_kit: {
          path: path.join(dataRoot, 'generated', 'validated', 'tenant_real', 'brand-kit.json'),
          source_url: 'https://sugarandleather.com',
          canonical_url: 'https://sugarandleather.com',
          brand_name: 'Sugar & Leather',
          logo_urls: [],
          colors: { primary: '#9c6b3e', secondary: '#f3e9dd', accent: '#3d2410', palette: ['#9c6b3e', '#f3e9dd', '#3d2410'] },
          font_families: ['Manrope'],
          external_links: [],
          extracted_at: '2026-03-18T00:00:00.000Z',
        },
        inputs: { request: { competitorUrl: 'https://betterup.com' }, brand_url: 'https://sugarandleather.com' },
        errors: [],
        last_error: null,
        history: [],
        created_at: '2026-03-19T00:00:00.000Z',
        updated_at: '2026-03-19T00:10:05.000Z',
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
    const body = (await response.json()) as Record<string, any>;

    assert.equal(response.status, 200);
    assert.equal(body.marketing_job_status, 'awaiting_approval');
    assert.equal(body.approval.workflowStepId, 'approve_stage_4_publish');
    assert.equal(body.assetPreviewCards.length > 0, true);
    assert.equal(body.assetPreviewCards.some((card: { platformSlug: string }) => card.platformSlug === 'meta-ads'), true);
    assert.equal(body.reviewBundle.platformPreviews.length > 0, true);
    assert.equal(body.reviewBundle.platformPreviews.some((preview: { platformSlug: string }) => preview.platformSlug === 'meta-ads'), true);
  });
});

test('/api/marketing/jobs/:jobId prefers richer compiled Stage 4 review bundles over synthetic stale fallback logs', async () => {
  await withRuntimeEnv(async (dataRoot) => {
    const { handleGetMarketingJobStatus } = await import('../app/api/marketing/jobs/[jobId]/handler');
    const jobId = 'mkt_publish_review_prefers_compiled_bundle';
    const runtimeFile = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs', `${jobId}.json`);
    const staleRunId = 'betterup-com-oldrun';
    const realRunId = 'betterup-com-9dd2434e';
    const staleLogsRoot = path.join(process.env.OPENCLAW_LOBSTER_CWD!, 'output', 'logs', staleRunId, 'stage-4-publish-optimize');
    const realLogsRoot = path.join(process.env.OPENCLAW_LOBSTER_CWD!, 'output', 'logs', realRunId, 'stage-4-publish-optimize');
    const publishImagePath = path.join(process.env.OPENCLAW_LOBSTER_CWD!, 'output', 'publish-ready', 'tenant-real-stage2-plan', 'meta-ads', 'meta-ads.png');

    await mkdir(path.dirname(runtimeFile), { recursive: true });
    await mkdir(staleLogsRoot, { recursive: true });
    await mkdir(realLogsRoot, { recursive: true });
    await mkdir(path.dirname(publishImagePath), { recursive: true });
    await writeFile(publishImagePath, 'png-preview', 'utf8');

    await writeFile(
      path.join(staleLogsRoot, 'launch_review_preview.json'),
      JSON.stringify({
        generated_at: '2026-03-27T09:47:56.430Z',
        review_bundle: {
          campaign_name: 'tenant-real-stage2-plan',
          summary: {
            core_message: 'Synthetic stale launch review.',
          },
          platform_previews: [
            {
              platform_slug: 'meta-ads',
              platform_name: 'Meta Ads',
              channel_type: 'paid-social',
              summary: 'Stale fallback package',
              media_paths: [publishImagePath],
              asset_paths: {},
            },
          ],
        },
      }, null, 2)
    );

    await writeFile(
      path.join(realLogsRoot, 'launch_review_preview.json'),
      JSON.stringify({
        generated_at: '2026-03-27T09:11:25.000Z',
        mode: 'compiled',
        brand_slug: 'tenant_real',
        approval_preview: {
          message: 'Approve creation of the Meta campaigns, ad sets, and ads as PAUSED.',
        },
        review_bundle: {
          campaign_name: 'tenant-real-stage2-plan',
          approval_message: 'Approve creation of the Meta campaigns, ad sets, and ads as PAUSED.',
          artifact_paths: {
            static_output_root: path.join(process.env.OPENCLAW_LOBSTER_CWD!, 'output', 'static-contracts', 'tenant-real-stage2-plan'),
          },
          summary: {
            core_message: 'Real current launch package.',
          },
          platform_previews: [
            {
              platform_slug: 'meta-ads',
              platform_name: 'Meta Ads',
              channel_type: 'paid-social',
              summary: 'Compiled current package',
              headline: 'Based on the brand identity of **Sugar & Leather** and the competitive landscape provided, here is the brand strategy analysis:',
              media_paths: [publishImagePath],
              asset_paths: {},
            },
          ],
        },
      }, null, 2)
    );

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
          research: { stage: 'research', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-r', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          strategy: { stage: 'strategy', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-s', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          production: { stage: 'production', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-p', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          publish: {
            stage: 'publish',
            status: 'awaiting_approval',
            started_at: '2026-03-27T09:47:56.430Z',
            completed_at: null,
            failed_at: null,
            run_id: null,
            summary: { summary: 'Stage 4 pre-flight complete.' },
            primary_output: {},
            outputs: {
              envelope: {
                protocolVersion: 1,
                ok: true,
                status: 'needs_approval',
                output: [],
                requiresApproval: {
                  prompt: 'Approve creation of the Meta campaigns, ad sets, and ads as PAUSED.',
                  resumeToken: 'resume-publish-paused',
                },
              },
              approval_id: 'mkta_publish_paused',
              workflow_step_id: 'approve_stage_4_publish',
              resume_token: 'resume-publish-paused',
            },
            artifacts: [],
            errors: [],
          },
        },
        approvals: {
          current: {
            stage: 'publish',
            status: 'awaiting_approval',
            approval_id: 'mkta_publish_paused',
            workflow_step_id: 'approve_stage_4_publish',
            title: 'Publish to Meta (paused) approval required',
            message: 'Stage 4 pre-flight complete. Approve creation of the Meta campaigns, ad sets, and ads as PAUSED?',
            requested_at: '2026-03-27T09:47:56.430Z',
            resume_token: 'resume-publish-paused',
            action_label: 'Approve paused publish',
            publish_config: { platforms: ['meta-ads'], live_publish_platforms: ['meta-ads'], video_render_platforms: [] },
          },
          history: [],
        },
        publish_config: { platforms: ['meta-ads'], live_publish_platforms: ['meta-ads'], video_render_platforms: [] },
        brand_kit: {
          path: path.join(dataRoot, 'generated', 'validated', 'tenant_real', 'brand-kit.json'),
          source_url: 'https://sugarandleather.com',
          canonical_url: 'https://sugarandleather.com',
          brand_name: 'Sugar & Leather | Elite Coaching Network',
          logo_urls: [],
          colors: { primary: '#000000', secondary: '#ffffff', accent: '#fb2c36', palette: ['#000000', '#ffffff', '#fb2c36'] },
          font_families: ['Inter'],
          external_links: [],
          extracted_at: '2026-03-27T08:35:42.657Z',
        },
        inputs: {
          request: {
            brandUrl: 'https://sugarandleather.com',
            competitorUrl: 'https://betterup.com',
            brandSlug: 'tenant_real',
          },
          brand_url: 'https://sugarandleather.com',
          brand_slug: 'tenant_real',
          competitor_url: 'https://betterup.com',
          competitor_facebook_url: null,
        },
        errors: [],
        last_error: null,
        history: [],
        created_at: '2026-03-27T09:25:35.134Z',
        updated_at: '2026-03-27T09:47:56.430Z',
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
    const body = (await response.json()) as Record<string, any>;

    assert.equal(response.status, 200);
    assert.equal(body.reviewBundle.summary, 'Real current launch package.');
    assert.equal(body.reviewBundle.platformPreviews[0].displayTitle, 'Meta Ads');
    assert.equal(body.reviewBundle.platformPreviews[0].summary, 'Compiled current package');
    assert.equal(body.assetPreviewCards[0].title, 'Meta Ads');
  });
});

test('/api/marketing/jobs/:jobId keeps fresher runtime review fields while backfilling missing real publish artifacts', async () => {
  await withRuntimeEnv(async (dataRoot) => {
    const { handleGetMarketingJobStatus } = await import('../app/api/marketing/jobs/[jobId]/handler');
    const jobId = 'mkt_publish_review_runtime_first_backfill';
    const stage4RunId = 'run-publish-runtime-first';
    const runtimeFile = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs', `${jobId}.json`);
    const preflightPath = path.join(process.env.LOBSTER_STAGE4_CACHE_DIR!, stage4RunId, 'performance_marketer_preflight.json');
    const metaPublisherPath = path.join(process.env.LOBSTER_STAGE4_CACHE_DIR!, stage4RunId, 'meta_ads_publisher.json');
    const campaignRoot = path.join(process.env.OPENCLAW_LOBSTER_CWD!, 'output', 'brand-runtime-first-campaign');
    const landingPagePath = path.join(campaignRoot, 'landing-pages', 'runtime-first.html');
    const metaScriptPath = path.join(campaignRoot, 'scripts', 'meta-ads.md');
    const shortVideoScriptPath = path.join(campaignRoot, 'scripts', 'short-video.md');
    const publishRoot = path.join(process.env.OPENCLAW_LOBSTER_CWD!, 'output', 'publish-ready', 'brand-runtime-first-stage2-plan', 'meta-ads');
    const imagePath = path.join(publishRoot, 'meta-ads.png');
    const copyPath = path.join(publishRoot, 'copy.json');
    const contractPath = path.join(publishRoot, 'meta-ads.json');
    const reviewPackagePath = path.join(
      process.env.OPENCLAW_LOBSTER_CWD!,
      'output',
      'aries-review',
      'tenant_real',
      'brand-runtime-first-stage2-plan',
      'meta-ads',
      'review-package.json',
    );

    await mkdir(path.dirname(runtimeFile), { recursive: true });
    await mkdir(path.dirname(preflightPath), { recursive: true });
    await mkdir(path.dirname(metaPublisherPath), { recursive: true });
    await mkdir(path.dirname(landingPagePath), { recursive: true });
    await mkdir(path.dirname(metaScriptPath), { recursive: true });
    await mkdir(path.dirname(shortVideoScriptPath), { recursive: true });
    await mkdir(path.dirname(imagePath), { recursive: true });
    await mkdir(path.dirname(reviewPackagePath), { recursive: true });

    await writeFile(
      landingPagePath,
      [
        '<!doctype html>',
        '<html><body>',
        '<h1>Runtime-first landing headline</h1>',
        '<p>Backfilled landing proof.</p>',
        '<a href="/book">Book now</a>',
        '</body></html>',
      ].join(''),
      'utf8',
    );
    await writeFile(
      metaScriptPath,
      [
        '# Meta Ads Script',
        '',
        '## Hook',
        'Fallback hook from the real meta script.',
        '',
        '## Body',
        '- Real meta body line.',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      shortVideoScriptPath,
      [
        '# Short Video Script',
        '',
        '## Opening Line',
        'Fallback video opening from the real script.',
        '',
        '## Beats',
        '- Beat one.',
      ].join('\n'),
      'utf8',
    );
    await writeFile(imagePath, 'png-preview', 'utf8');
    await writeFile(
      copyPath,
      JSON.stringify({
        headline: 'Runtime-first copy headline',
        body_lines: ['Fallback platform body line.'],
        primary_cta: 'Book now',
      }, null, 2),
      'utf8',
    );
    await writeFile(
      contractPath,
      JSON.stringify({
        platform_slug: 'meta-ads',
        creative: {
          headline: 'Runtime-first copy headline',
        },
      }, null, 2),
      'utf8',
    );

    const workspacePath = (filePath: string) =>
      filePath.replace(process.env.CODE_ROOT!, '/home/node/workspace/aries-app');

    await writeFile(
      reviewPackagePath,
      JSON.stringify({
        platform: 'meta-ads',
        summary: 'Fallback review package summary',
        contract_path: workspacePath(contractPath),
        asset_paths: {
          copy_path: workspacePath(copyPath),
          image_path: workspacePath(imagePath),
        },
      }, null, 2),
      'utf8',
    );
    await writeFile(
      preflightPath,
      JSON.stringify({
        run_id: stage4RunId,
        campaign_name: 'brand-runtime-first-stage2-plan',
        production_handoff: {
          production_brief: {
            core_message: 'Fallback publish summary from artifacts.',
          },
        },
      }, null, 2),
      'utf8',
    );
    await writeFile(
      metaPublisherPath,
      JSON.stringify({
        platform: 'meta-ads',
        publish_package: {
          review_package_path: workspacePath(reviewPackagePath),
          image_path: workspacePath(imagePath),
          copy_path: workspacePath(copyPath),
        },
        contract_path: workspacePath(contractPath),
      }, null, 2),
      'utf8',
    );
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
          research: { stage: 'research', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-r', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          strategy: { stage: 'strategy', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-s', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          production: { stage: 'production', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-p', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          publish: {
            stage: 'publish',
            status: 'awaiting_approval',
            started_at: '2026-03-30T11:15:00.000Z',
            completed_at: null,
            failed_at: null,
            run_id: stage4RunId,
            summary: { summary: 'Stage 4 pre-flight complete.' },
            primary_output: {
              launch_review: {
                generated_at: '2026-03-30T11:15:00.000Z',
                approval_preview: {
                  message: 'Use the current runtime approval message.',
                },
                review_bundle: {
                  campaign_name: 'brand-runtime-first-stage2-plan',
                  approval_message: 'Use the current runtime approval message.',
                  summary: {
                    core_message: 'Use the current runtime summary.',
                  },
                  platform_previews: [
                    {
                      platform_slug: 'meta-ads',
                      platform_name: 'Meta Ads',
                      channel_type: 'paid-social',
                      summary: 'Use the current runtime preview summary.',
                      headline: 'Runtime headline wins',
                      media_paths: [],
                      asset_paths: {},
                    },
                  ],
                },
              },
            },
            outputs: {
              approval_id: 'mkta_publish_runtime_first',
              workflow_step_id: 'approve_stage_4_publish',
              resume_token: 'resume-publish-runtime-first',
            },
            artifacts: [],
            errors: [],
          },
        },
        approvals: {
          current: {
            stage: 'publish',
            status: 'awaiting_approval',
            approval_id: 'mkta_publish_runtime_first',
            workflow_step_id: 'approve_stage_4_publish',
            title: 'Publish approval required',
            message: 'Use the current runtime approval message.',
            requested_at: '2026-03-30T11:15:00.000Z',
            resume_token: 'resume-publish-runtime-first',
            action_label: 'Approve paused publish',
            publish_config: { platforms: ['meta-ads'], live_publish_platforms: ['meta-ads'], video_render_platforms: [] },
          },
          history: [],
        },
        publish_config: { platforms: ['meta-ads'], live_publish_platforms: ['meta-ads'], video_render_platforms: [] },
        brand_kit: {
          path: path.join(dataRoot, 'generated', 'validated', 'tenant_real', 'brand-kit.json'),
          source_url: 'https://brand.example',
          canonical_url: 'https://brand.example',
          brand_name: 'Brand Example',
          logo_urls: [],
          colors: { primary: '#111111', secondary: '#f4f4f4', accent: '#c24d2c', palette: ['#111111', '#f4f4f4', '#c24d2c'] },
          font_families: ['Manrope'],
          external_links: [],
          extracted_at: '2026-03-30T10:55:00.000Z',
        },
        inputs: {
          request: {
            brandUrl: 'https://brand.example',
            competitorUrl: 'https://betterup.com',
          },
          brand_url: 'https://brand.example',
          competitor_url: 'https://betterup.com',
          competitor_facebook_url: null,
        },
        errors: [],
        last_error: null,
        history: [],
        created_at: '2026-03-30T11:00:00.000Z',
        updated_at: '2026-03-30T11:15:00.000Z',
      }, null, 2),
      'utf8',
    );

    const response = await handleGetMarketingJobStatus(
      jobId,
      async () => ({
        userId: 'user_123',
        tenantId: 'tenant_real',
        tenantSlug: 'acme',
        role: 'tenant_admin',
      }),
    );
    const body = (await response.json()) as Record<string, any>;

    assert.equal(response.status, 200);
    assert.equal(body.reviewBundle.summary, 'Use the current runtime summary.');
    assert.equal(body.reviewBundle.approvalMessage, 'Use the current runtime approval message.');
    assert.equal(body.reviewBundle.platformPreviews[0].summary, 'Use the current runtime preview summary.');
    assert.equal(body.reviewBundle.platformPreviews[0].headline, 'Runtime headline wins');
    assert.equal(body.reviewBundle.platformPreviews[0].mediaAssets.length > 0, true);
    assert.equal(body.reviewBundle.landingPage.headline, 'Runtime-first landing headline');
    assert.equal(body.reviewBundle.scriptPreview.metaAdHook, 'Fallback hook from the real meta script.');
    assert.equal(body.reviewBundle.scriptPreview.shortVideoOpeningLine, 'Fallback video opening from the real script.');
  });
});

test('/api/marketing/jobs/:jobId hydrates brandReview and strategyReview from real Stage 2 artifacts on disk', async () => {
  await withRuntimeEnv(async (dataRoot) => {
    const { handleGetMarketingJobStatus } = await import('../app/api/marketing/jobs/[jobId]/handler');
    const jobId = 'mkt_strategy_review_hydrated';
    const tenantId = 'public_sugarandleather-com';
    const stage2RunId = 'https-betterup-com-feefd5df';
    const runtimeFile = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs', `${jobId}.json`);
    const plannerPath = path.join(process.env.LOBSTER_STAGE2_CACHE_DIR!, stage2RunId, 'campaign_planner.json');
    const websiteAnalysisPath = path.join(process.env.LOBSTER_STAGE2_CACHE_DIR!, stage2RunId, 'website_brand_analysis.json');
    const brandProfilePath = path.join(dataRoot, 'generated', 'validated', tenantId, 'brand-profile.json');
    const strategyReviewPath = path.join(process.env.LOBSTER_STAGE2_CACHE_DIR!, stage2RunId, 'strategy_review_preview.json');
    const proposalPath = path.join(process.env.OPENCLAW_LOBSTER_CWD!, 'output', 'public-sugarandleather-com-campaign-proposal.md');

    await mkdir(path.dirname(runtimeFile), { recursive: true });
    await mkdir(path.dirname(plannerPath), { recursive: true });
    await mkdir(path.dirname(proposalPath), { recursive: true });
    await mkdir(path.dirname(brandProfilePath), { recursive: true });
    await writeFile(
      plannerPath,
      JSON.stringify({
        brand_slug: 'public-sugarandleather-com',
        brand_profiles_record: { brand_slug: 'public-sugarandleather-com' },
        campaign_plan: {
          campaign_name: 'Spring Leather Launch',
          objective: 'Drive qualified lead volume for the spring planning intensive.',
          core_message: 'Proof-led coaching for modern founders.',
          audience: 'Founder-led teams',
          offer: 'Spring planning intensive',
          primary_cta: 'Book a strategy call',
          channel_plans: [
            {
              channel: 'meta-ads',
              goal: 'Drive consultation requests',
              message: 'Show real client outcomes with founder-facing proof.',
              creative_bias: 'High-trust proof and clear before/after framing.',
              cta: 'Book a strategy call',
            },
          ],
        },
      }, null, 2),
    );
    await writeFile(
      websiteAnalysisPath,
      JSON.stringify({
        brand_slug: 'public-sugarandleather-com',
        brand_analysis: {
          brand_name: 'Sugar & Leather',
          website_url: 'https://sugarandleather.com',
          brand_promise: 'Strategic coaching for founders who need practical momentum.',
          audience_summary: 'Small teams and founder-operators who need sharper launch execution.',
          offer_summary: 'Spring planning intensive',
          brand_voice: ['Grounded', 'Proof-led'],
          artifacts: {},
        },
      }, null, 2),
    );
    await writeFile(
      brandProfilePath,
      JSON.stringify({
        brand_name: 'Sugar & Leather',
        audience: 'Founder-led teams',
        positioning: 'Proof-led planning for founder-operators who need a sharper launch system.',
        offer: 'Spring planning intensive',
        primary_cta: 'Book a strategy call',
        proof_points: [
          'Launch plans shipped in 14 days.',
          'Operator-led coaching with concrete milestones.',
        ],
        brand_voice: ['Grounded', 'Proof-led'],
      }, null, 2),
    );
    await writeFile(
      strategyReviewPath,
      JSON.stringify({
        review_packet: {
          campaign_name: 'Spring Leather Launch',
          objective: 'Drive qualified lead volume for the spring planning intensive.',
          core_message: 'Proof-led coaching for modern founders.',
          channels_in_scope: ['meta-ads', 'instagram'],
        },
      }, null, 2),
    );
    await writeFile(
      proposalPath,
      [
        '# Spring Leather Launch',
        '',
        'Proof-led coaching for modern founders.',
        '',
        'Primary CTA: Book a strategy call',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      runtimeFile,
      JSON.stringify({
        schema_name: 'marketing_job_state_schema',
        schema_version: '1.0.0',
        job_id: jobId,
        job_type: 'brand_campaign',
        tenant_id: tenantId,
        state: 'approval_required',
        status: 'awaiting_approval',
        current_stage: 'production',
        stage_order: ['research', 'strategy', 'production', 'publish'],
        stages: {
          research: { stage: 'research', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-research', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          strategy: { stage: 'strategy', status: 'completed', started_at: '2026-03-30T09:58:00.000Z', completed_at: '2026-03-30T10:00:00.000Z', failed_at: null, run_id: null, summary: null, primary_output: {}, outputs: {}, artifacts: [], errors: [] },
          production: { stage: 'production', status: 'awaiting_approval', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: { approval_id: 'mkta_strategy_real', workflow_step_id: 'approve_stage_3' }, artifacts: [], errors: [] },
          publish: { stage: 'publish', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
        },
        approvals: {
          current: {
            stage: 'production',
            status: 'awaiting_approval',
            approval_id: 'mkta_strategy_real',
            workflow_name: 'marketing-pipeline',
            workflow_step_id: 'approve_stage_3',
            title: 'Strategy review required',
            message: 'Review the campaign proposal before production begins.',
            requested_at: '2026-03-30T10:00:00.000Z',
            resume_token: 'resume-strategy-real',
            action_label: 'Review strategy',
            publish_config: null,
          },
          history: [],
        },
        publish_config: { platforms: ['meta-ads'], live_publish_platforms: ['meta-ads'], video_render_platforms: [] },
        brand_kit: {
          path: path.join(dataRoot, 'generated', 'validated', tenantId, 'brand-kit.json'),
          source_url: 'https://sugarandleather.com',
          canonical_url: 'https://sugarandleather.com',
          brand_name: 'Sugar & Leather',
          logo_urls: ['https://sugarandleather.com/assets/wordmark.png'],
          colors: { primary: '#9c6b3e', secondary: '#f3e9dd', accent: '#3d2410', palette: ['#9c6b3e', '#f3e9dd', '#3d2410'] },
          font_families: ['Manrope'],
          external_links: [{ platform: 'instagram', url: 'https://instagram.com/sugarandleather' }],
          extracted_at: '2026-03-30T09:55:00.000Z',
          brand_voice_summary: 'Proof-led coaching with a grounded, operator-first tone.',
          offer_summary: 'Spring planning intensive',
        },
        inputs: {
          request: {
            brandUrl: 'https://sugarandleather.com',
            businessName: 'Sugar & Leather',
            businessType: 'coaching',
            approverName: 'Avery Operator',
            goal: 'Drive qualified consultations',
            offer: 'Spring planning intensive',
            competitorUrl: 'https://betterup.com',
            channels: ['meta-ads', 'instagram'],
          },
          brand_url: 'https://sugarandleather.com',
          competitor_url: 'https://betterup.com',
          competitor_facebook_url: null,
        },
        errors: [],
        last_error: null,
        history: [],
        created_at: '2026-03-30T09:50:00.000Z',
        updated_at: '2026-03-30T10:00:00.000Z',
      }, null, 2),
    );

    const response = await handleGetMarketingJobStatus(
      jobId,
      async () => ({
        userId: 'user_123',
        tenantId,
        tenantSlug: 'acme',
        role: 'tenant_admin',
      }),
    );
    const body = (await response.json()) as Record<string, any>;

    assert.equal(response.status, 200);
    assert.notEqual(body.brandReview, null);
    assert.notEqual(body.strategyReview, null);
    assert.equal(body.brandReview.sections.some((section: { title: string }) => section.title === 'Extracted brand kit'), true);
    assert.equal(
      body.brandReview.sections.some(
        (section: { title: string; body: string }) =>
          section.title === 'Brand overview' &&
          /Founder-led teams/.test(section.body) &&
          /Proof-led planning for founder-operators/.test(section.body) &&
          /Spring planning intensive/.test(section.body),
      ),
      true,
    );
    assert.equal(
      body.brandReview.sections.some(
        (section: { title: string; body: string }) =>
          section.title === 'Voice and guardrails' &&
          /Book a strategy call/.test(section.body) &&
          /Launch plans shipped in 14 days\./.test(section.body) &&
          /Operator-led coaching with concrete milestones\./.test(section.body),
      ),
      true,
    );
    assert.equal(body.strategyReview.sections.some((section: { title: string; body: string }) => section.title === 'Full proposal' && /Proof-led coaching/.test(section.body)), true);
    assert.equal(body.strategyReview.sections.some((section: { title: string; body: string }) => section.title === 'Channel plan' && /meta-ads|instagram/i.test(section.body)), true);
    assert.equal(body.strategyReview.sections.some((section: { body: string }) => /No details yet\./.test(section.body)), false);
    assert.equal(body.strategyReview.attachments.some((attachment: { id: string }) => attachment.id === 'strategy-campaign-planner'), true);
    assert.equal(body.strategyReview.attachments.some((attachment: { id: string }) => attachment.id === 'strategy-proposal-markdown'), true);
    assert.equal(body.dashboard.campaign.counts.proposalConcepts > 0, true);
  });
});

test('/api/marketing/jobs/:jobId tolerates legacy runtime docs without brand_kit when real brand artifacts exist', async () => {
  await withRuntimeEnv(async () => {
    const { handleGetMarketingJobStatus } = await import('../app/api/marketing/jobs/[jobId]/handler');
    const jobId = 'mkt_legacy_missing_brand_kit_artifacts';
    const tenantId = 'tenant_legacy_brand_artifacts';
    const stage2RunId = 'run-legacy-brand-artifacts';
    const runtimeFile = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs', `${jobId}.json`);
    const websiteAnalysisPath = path.join(process.env.LOBSTER_STAGE2_CACHE_DIR!, stage2RunId, 'website_brand_analysis.json');
    const brandBiblePath = path.join(process.env.OPENCLAW_LOBSTER_CWD!, 'output', 'tenant-legacy-brand-artifacts-brand-bible.md');
    const designSystemPath = path.join(process.env.OPENCLAW_LOBSTER_CWD!, 'output', 'tenant-legacy-brand-artifacts-design-system.css');

    await mkdir(path.dirname(runtimeFile), { recursive: true });
    await mkdir(path.dirname(websiteAnalysisPath), { recursive: true });
    await mkdir(path.dirname(brandBiblePath), { recursive: true });
    await writeFile(
      websiteAnalysisPath,
      JSON.stringify({
        brand_slug: 'tenant-legacy-brand-artifacts',
        brand_analysis: {
          brand_name: 'Legacy Brand',
          website_url: 'https://legacy-brand.example',
          brand_promise: 'Proof-led launch strategy for founder-led teams.',
          audience_summary: 'Founder-operators preparing a launch.',
          offer_summary: 'Launch strategy intensive',
          brand_voice: ['Grounded', 'Proof-led'],
        },
      }, null, 2),
    );
    await writeFile(
      brandBiblePath,
      [
        '# Legacy Brand Brand Bible',
        '',
        'Lead with concrete proof and operational clarity.',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      designSystemPath,
      ':root { --brand-primary: #1a1a1a; --brand-secondary: #f4efe8; }',
      'utf8',
    );
    await writeFile(
      runtimeFile,
      JSON.stringify({
        schema_name: 'marketing_job_state_schema',
        schema_version: '1.0.0',
        job_id: jobId,
        job_type: 'brand_campaign',
        tenant_id: tenantId,
        state: 'approval_required',
        status: 'awaiting_approval',
        current_stage: 'production',
        stage_order: ['research', 'strategy', 'production', 'publish'],
        stages: {
          research: { stage: 'research', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-research', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          strategy: { stage: 'strategy', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: stage2RunId, summary: null, primary_output: { run_id: stage2RunId }, outputs: {}, artifacts: [], errors: [] },
          production: { stage: 'production', status: 'awaiting_approval', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: { approval_id: 'mkta_legacy_brand', workflow_step_id: 'approve_stage_3' }, artifacts: [], errors: [] },
          publish: { stage: 'publish', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
        },
        approvals: {
          current: {
            stage: 'production',
            status: 'awaiting_approval',
            approval_id: 'mkta_legacy_brand',
            workflow_name: 'marketing-pipeline',
            workflow_step_id: 'approve_stage_3',
            title: 'Strategy review required',
            message: 'Review the campaign proposal before production begins.',
            requested_at: '2026-03-31T00:00:00.000Z',
            resume_token: 'resume-legacy-brand',
            action_label: 'Review strategy',
            publish_config: null,
          },
          history: [],
        },
        publish_config: { platforms: ['meta-ads'], live_publish_platforms: [], video_render_platforms: [] },
        inputs: {
          request: {
            brandUrl: 'https://legacy-brand.example',
          },
          brand_url: 'https://legacy-brand.example',
          competitor_url: 'https://competitor.example',
          competitor_facebook_url: null,
        },
        errors: [],
        last_error: null,
        history: [],
        created_at: '2026-03-31T00:00:00.000Z',
        updated_at: '2026-03-31T00:05:00.000Z',
      }, null, 2),
    );

    const response = await handleGetMarketingJobStatus(
      jobId,
      async () => ({
        userId: 'user_legacy',
        tenantId,
        tenantSlug: 'legacy-brand',
        role: 'tenant_admin',
      }),
    );
    const body = (await response.json()) as Record<string, any>;

    assert.equal(response.status, 200);
    assert.notEqual(body.brandReview, null);
    assert.equal(body.brandReview.sections.some((section: { title: string; body: string }) => section.title === 'Brand overview' && /Legacy Brand/.test(section.body)), true);
    assert.equal(body.brandReview.sections.some((section: { title: string; body: string }) => section.title === 'Brand bible' && /operational clarity/i.test(section.body)), true);
    assert.equal(body.brandReview.sections.some((section: { title: string; body: string }) => section.title === 'Design system' && /--brand-primary/.test(section.body)), true);
    assert.equal(body.brandReview.attachments.some((attachment: { id: string }) => attachment.id === 'strategy-website-analysis'), true);
  });
});

test('/api/marketing/jobs/:jobId returns brandReview null for legacy runtime docs without brand_kit or real brand artifacts', async () => {
  await withRuntimeEnv(async () => {
    const { handleGetMarketingJobStatus } = await import('../app/api/marketing/jobs/[jobId]/handler');
    const jobId = 'mkt_legacy_missing_brand_kit_empty';
    const tenantId = 'tenant_legacy_brand_empty';
    const runtimeFile = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs', `${jobId}.json`);

    await mkdir(path.dirname(runtimeFile), { recursive: true });
    await writeFile(
      runtimeFile,
      JSON.stringify({
        schema_name: 'marketing_job_state_schema',
        schema_version: '1.0.0',
        job_id: jobId,
        job_type: 'brand_campaign',
        tenant_id: tenantId,
        state: 'queued',
        status: 'pending',
        current_stage: 'research',
        stage_order: ['research', 'strategy', 'production', 'publish'],
        stages: {
          research: { stage: 'research', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          strategy: { stage: 'strategy', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          production: { stage: 'production', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          publish: { stage: 'publish', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
        },
        approvals: { current: null, history: [] },
        publish_config: { platforms: ['meta-ads'], live_publish_platforms: [], video_render_platforms: [] },
        inputs: {
          request: {
            brandUrl: 'https://legacy-empty.example',
          },
          brand_url: 'https://legacy-empty.example',
          competitor_url: 'https://competitor.example',
          competitor_facebook_url: null,
        },
        errors: [],
        last_error: null,
        history: [],
        created_at: '2026-03-31T00:00:00.000Z',
        updated_at: '2026-03-31T00:05:00.000Z',
      }, null, 2),
    );

    const response = await handleGetMarketingJobStatus(
      jobId,
      async () => ({
        userId: 'user_legacy',
        tenantId,
        tenantSlug: 'legacy-empty',
        role: 'tenant_admin',
      }),
    );
    const body = (await response.json()) as Record<string, any>;

    assert.equal(response.status, 200);
    assert.equal(body.brandReview, null);
    assert.equal(body.strategyReview, null);
    assert.equal(body.creativeReview, null);
  });
});

test('/api/marketing/jobs/:jobId renders upload-only brandReview without advancing workflow', async () => {
  await withRuntimeEnv(async () => {
    const { handleGetMarketingJobStatus } = await import('../app/api/marketing/jobs/[jobId]/handler');
    const { ensureCampaignWorkspaceRecord, saveCampaignWorkspaceAssets } = await import('../backend/marketing/workspace-store');
    const jobId = 'mkt_upload_only_brand_review';
    const tenantId = 'tenant_upload_only_brand_review';
    const runtimeFile = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs', `${jobId}.json`);

    await mkdir(path.dirname(runtimeFile), { recursive: true });
    await writeFile(
      runtimeFile,
      JSON.stringify({
        schema_name: 'marketing_job_state_schema',
        schema_version: '1.0.0',
        job_id: jobId,
        job_type: 'brand_campaign',
        tenant_id: tenantId,
        state: 'queued',
        status: 'pending',
        current_stage: 'research',
        stage_order: ['research', 'strategy', 'production', 'publish'],
        stages: {
          research: { stage: 'research', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          strategy: { stage: 'strategy', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          production: { stage: 'production', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          publish: { stage: 'publish', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
        },
        approvals: { current: null, history: [] },
        publish_config: { platforms: ['meta-ads'], live_publish_platforms: [], video_render_platforms: [] },
        inputs: {
          request: {
            brandUrl: 'https://upload-only.example',
            businessName: 'Upload Only Co',
            businessType: 'consulting',
            goal: 'Drive consultation requests',
            offer: 'Brand sprint',
            brandVoice: 'Direct and proof-led',
            styleVibe: 'Clean editorial',
            visualReferences: ['https://example.com/reference-board'],
            mustUseCopy: 'Book a brand sprint',
            mustAvoidAesthetics: 'Neon gradients',
            notes: 'Prefer simple layouts.',
          },
          brand_url: 'https://upload-only.example',
          competitor_url: 'https://competitor.example',
          competitor_facebook_url: null,
        },
        errors: [],
        last_error: null,
        history: [],
        created_at: '2026-03-31T00:00:00.000Z',
        updated_at: '2026-03-31T00:05:00.000Z',
      }, null, 2),
    );

    const record = ensureCampaignWorkspaceRecord({
      jobId,
      tenantId,
      payload: {
        websiteUrl: 'https://upload-only.example',
        businessName: 'Upload Only Co',
        businessType: 'consulting',
        goal: 'Drive consultation requests',
        offer: 'Brand sprint',
        brandVoice: 'Direct and proof-led',
        styleVibe: 'Clean editorial',
        visualReferences: ['https://example.com/reference-board'],
        mustUseCopy: 'Book a brand sprint',
        mustAvoidAesthetics: 'Neon gradients',
        notes: 'Prefer simple layouts.',
      },
    });
    saveCampaignWorkspaceAssets(record, [
      {
        name: 'brand-board.png',
        contentType: 'image/png',
        data: Buffer.from('brand-board'),
      },
    ]);

    const response = await handleGetMarketingJobStatus(
      jobId,
      async () => ({
        userId: 'user_upload_only',
        tenantId,
        tenantSlug: 'upload-only',
        role: 'tenant_admin',
      }),
    );
    const body = (await response.json()) as Record<string, any>;

    assert.equal(response.status, 200);
    assert.notEqual(body.brandReview, null);
    assert.equal(body.workflowState, 'draft');
    assert.equal(body.brandReview.status, 'pending_review');
    assert.equal(body.brandReview.sections.some((section: { title: string }) => section.title === 'Intake constraints'), true);
    assert.equal(body.brandReview.sections.some((section: { title: string }) => section.title === 'Uploaded brand assets'), true);
    assert.equal(body.brandReview.sections.some((section: { title: string }) => section.title === 'Extracted brand kit'), false);
    assert.equal(body.brandReview.attachments.some((attachment: { kind: string }) => attachment.kind === 'brand_asset'), true);
  });
});

test('/api/marketing/jobs/:jobId hydrates brandReview from brand-profile.json without website-analysis.json', async () => {
  await withRuntimeEnv(async (dataRoot) => {
    const { handleGetMarketingJobStatus } = await import('../app/api/marketing/jobs/[jobId]/handler');
    const jobId = 'mkt_brand_profile_only_review';
    const tenantId = 'tenant_brand_profile_only_review';
    const runtimeFile = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs', `${jobId}.json`);
    const brandProfilePath = path.join(dataRoot, 'generated', 'validated', tenantId, 'brand-profile.json');

    await mkdir(path.dirname(runtimeFile), { recursive: true });
    await mkdir(path.dirname(brandProfilePath), { recursive: true });
    await writeFile(
      brandProfilePath,
      JSON.stringify({
        brand_name: 'Brand Profile Only Co',
        audience: 'Founder-led service businesses',
        positioning: 'Operator-grade planning for launch teams that need a tighter offer.',
        offer: 'Launch planning sprint',
        primary_cta: 'Schedule a planning call',
        proof_points: ['Built around real operator workflows.'],
        brand_voice: ['Clear', 'Operator-first'],
      }, null, 2),
    );
    await writeFile(
      runtimeFile,
      JSON.stringify({
        schema_name: 'marketing_job_state_schema',
        schema_version: '1.0.0',
        job_id: jobId,
        job_type: 'brand_campaign',
        tenant_id: tenantId,
        state: 'queued',
        status: 'pending',
        current_stage: 'research',
        stage_order: ['research', 'strategy', 'production', 'publish'],
        stages: {
          research: { stage: 'research', status: 'completed', started_at: '2026-03-31T00:00:00.000Z', completed_at: '2026-03-31T00:05:00.000Z', failed_at: null, run_id: 'run-research', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          strategy: { stage: 'strategy', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          production: { stage: 'production', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          publish: { stage: 'publish', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
        },
        approvals: { current: null, history: [] },
        publish_config: { platforms: ['meta-ads'], live_publish_platforms: [], video_render_platforms: [] },
        inputs: {
          request: {
            brandUrl: 'https://brand-profile-only.example',
          },
          brand_url: 'https://brand-profile-only.example',
          competitor_url: 'https://competitor.example',
          competitor_facebook_url: null,
        },
        errors: [],
        last_error: null,
        history: [],
        created_at: '2026-03-31T00:00:00.000Z',
        updated_at: '2026-03-31T00:05:00.000Z',
      }, null, 2),
    );

    const response = await handleGetMarketingJobStatus(
      jobId,
      async () => ({
        userId: 'user_brand_profile_only',
        tenantId,
        tenantSlug: 'brand-profile-only',
        role: 'tenant_admin',
      }),
    );
    const body = (await response.json()) as Record<string, any>;

    assert.equal(response.status, 200);
    assert.notEqual(body.brandReview, null);
    assert.equal(
      body.brandReview.sections.some(
        (section: { title: string; body: string }) =>
          section.title === 'Brand overview' &&
          /Brand Profile Only Co/.test(section.body) &&
          /Founder-led service businesses/.test(section.body) &&
          /Operator-grade planning for launch teams/.test(section.body) &&
          /Launch planning sprint/.test(section.body),
      ),
      true,
    );
    assert.equal(
      body.brandReview.sections.some(
        (section: { title: string; body: string }) =>
          section.title === 'Voice and guardrails' &&
          /Schedule a planning call/.test(section.body) &&
          /Built around real operator workflows\./.test(section.body),
      ),
      true,
    );
  });
});

test('/api/marketing/jobs/:jobId keeps strategy-only legacy jobs non-crashing with creativeReview null and zero creative counts', async () => {
  await withRuntimeEnv(async () => {
    const { handleGetMarketingJobStatus } = await import('../app/api/marketing/jobs/[jobId]/handler');
    const jobId = 'mkt_legacy_strategy_only';
    const tenantId = 'tenant_legacy_strategy_only';
    const stage2RunId = 'run-legacy-strategy-only';
    const runtimeFile = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs', `${jobId}.json`);
    const plannerPath = path.join(process.env.LOBSTER_STAGE2_CACHE_DIR!, stage2RunId, 'campaign_planner.json');
    const websiteAnalysisPath = path.join(process.env.LOBSTER_STAGE2_CACHE_DIR!, stage2RunId, 'website_brand_analysis.json');
    const strategyReviewPath = path.join(process.env.LOBSTER_STAGE2_CACHE_DIR!, stage2RunId, 'strategy_review_preview.json');
    const proposalPath = path.join(process.env.OPENCLAW_LOBSTER_CWD!, 'output', 'tenant-legacy-strategy-only-campaign-proposal.md');

    await mkdir(path.dirname(runtimeFile), { recursive: true });
    await mkdir(path.dirname(plannerPath), { recursive: true });
    await mkdir(path.dirname(proposalPath), { recursive: true });
    await writeFile(
      plannerPath,
      JSON.stringify({
        brand_slug: 'tenant-legacy-strategy-only',
        campaign_plan: {
          campaign_name: 'Legacy Strategy Launch',
          objective: 'Drive strategy calls',
          core_message: 'Proof-led systems for founder teams.',
          audience: 'Founder-operators',
          offer: 'Strategy sprint',
          primary_cta: 'Book a strategy call',
          channel_plans: [
            {
              channel: 'meta-ads',
              goal: 'Qualified calls',
              message: 'Show proof and operating leverage.',
              creative_bias: 'Operator proof',
              cta: 'Book a strategy call',
            },
          ],
        },
      }, null, 2),
    );
    await writeFile(
      websiteAnalysisPath,
      JSON.stringify({
        brand_slug: 'tenant-legacy-strategy-only',
        brand_analysis: {
          brand_name: 'Legacy Strategy Co',
          website_url: 'https://legacy-strategy.example',
          brand_promise: 'Operator-first strategy for founder launches.',
          audience_summary: 'Founder teams who need an execution plan.',
        },
      }, null, 2),
    );
    await writeFile(
      strategyReviewPath,
      JSON.stringify({
        review_packet: {
          campaign_name: 'Legacy Strategy Launch',
          objective: 'Drive strategy calls',
          core_message: 'Proof-led systems for founder teams.',
          channels_in_scope: ['meta-ads'],
        },
      }, null, 2),
    );
    await writeFile(
      proposalPath,
      [
        '# Legacy Strategy Launch',
        '',
        'Proof-led systems for founder teams.',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      runtimeFile,
      JSON.stringify({
        schema_name: 'marketing_job_state_schema',
        schema_version: '1.0.0',
        job_id: jobId,
        job_type: 'brand_campaign',
        tenant_id: tenantId,
        state: 'approval_required',
        status: 'awaiting_approval',
        current_stage: 'production',
        stage_order: ['research', 'strategy', 'production', 'publish'],
        stages: {
          research: { stage: 'research', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-research', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          strategy: { stage: 'strategy', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: stage2RunId, summary: null, primary_output: { run_id: stage2RunId }, outputs: {}, artifacts: [], errors: [] },
          production: { stage: 'production', status: 'awaiting_approval', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: { approval_id: 'mkta_legacy_strategy_only', workflow_step_id: 'approve_stage_3' }, artifacts: [], errors: [] },
          publish: { stage: 'publish', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
        },
        approvals: {
          current: {
            stage: 'production',
            status: 'awaiting_approval',
            approval_id: 'mkta_legacy_strategy_only',
            workflow_name: 'marketing-pipeline',
            workflow_step_id: 'approve_stage_3',
            title: 'Strategy review required',
            message: 'Review the campaign proposal before production begins.',
            requested_at: '2026-03-31T00:00:00.000Z',
            resume_token: 'resume-legacy-strategy-only',
            action_label: 'Review strategy',
            publish_config: null,
          },
          history: [],
        },
        publish_config: { platforms: ['meta-ads'], live_publish_platforms: [], video_render_platforms: [] },
        inputs: {
          request: {
            brandUrl: 'https://legacy-strategy.example',
          },
          brand_url: 'https://legacy-strategy.example',
          competitor_url: 'https://competitor.example',
          competitor_facebook_url: null,
        },
        errors: [],
        last_error: null,
        history: [],
        created_at: '2026-03-31T00:00:00.000Z',
        updated_at: '2026-03-31T00:05:00.000Z',
      }, null, 2),
    );

    const response = await handleGetMarketingJobStatus(
      jobId,
      async () => ({
        userId: 'user_legacy',
        tenantId,
        tenantSlug: 'legacy-strategy',
        role: 'tenant_admin',
      }),
    );
    const body = (await response.json()) as Record<string, any>;

    assert.equal(response.status, 200);
    assert.notEqual(body.strategyReview, null);
    assert.equal(body.creativeReview, null);
    assert.equal(body.dashboard.campaign.counts.landingPages, 0);
    assert.equal(body.dashboard.campaign.counts.imageAds, 0);
    assert.equal(body.dashboard.campaign.counts.scripts, 0);
  });
});

test('/api/marketing/jobs/:jobId hydrates creativeReview and dashboard counts from real production artifacts on disk', async () => {
  await withRuntimeEnv(async (dataRoot) => {
    const { handleGetMarketingJobStatus } = await import('../app/api/marketing/jobs/[jobId]/handler');
    const jobId = 'mkt_creative_review_hydrated';
    const stage2RunId = 'run-strategy-creative-real';
    const stage3RunId = 'run-production-real';
    const runtimeFile = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs', `${jobId}.json`);
    const plannerPath = path.join(process.env.LOBSTER_STAGE2_CACHE_DIR!, stage2RunId, 'campaign_planner.json');
    const productionReviewPath = path.join(process.env.LOBSTER_STAGE3_CACHE_DIR!, stage3RunId, 'production_review_preview.json');
    const campaignRoot = path.join(process.env.OPENCLAW_LOBSTER_CWD!, 'output', 'public-sugarandleather-com-campaign');
    const landingPagePath = path.join(campaignRoot, 'landing-pages', 'spring-launch.html');
    const imagePath = path.join(campaignRoot, 'ad-images', 'meta-ads-main.png');
    const scriptPath = path.join(campaignRoot, 'scripts', 'meta-ads.md');
    const videoScriptPath = path.join(campaignRoot, 'scripts', 'short-video.md');

    await mkdir(path.dirname(runtimeFile), { recursive: true });
    await mkdir(path.dirname(plannerPath), { recursive: true });
    await mkdir(path.dirname(productionReviewPath), { recursive: true });
    await mkdir(path.dirname(landingPagePath), { recursive: true });
    await mkdir(path.dirname(imagePath), { recursive: true });
    await mkdir(path.dirname(scriptPath), { recursive: true });
    await mkdir(path.dirname(videoScriptPath), { recursive: true });
    await writeFile(
      plannerPath,
      JSON.stringify({
        campaign_plan: {
          campaign_name: 'Spring Leather Launch',
          objective: 'Drive qualified lead volume for the spring planning intensive.',
          core_message: 'Proof-led coaching for modern founders.',
          primary_cta: 'Book a strategy call',
          channel_plans: [{ channel: 'meta-ads', goal: 'Leads', message: 'Founder proof', creative_bias: 'Operator testimonials', cta: 'Book now' }],
        },
      }, null, 2),
    );
    await writeFile(
      productionReviewPath,
      JSON.stringify({
        review_packet: {
          summary: {
            core_message: 'Production assets are ready for approval.',
          },
          asset_previews: {
            landing_page_headline: 'Book the founder strategy intensive',
            meta_ad_hook: 'See how operator-led launches close faster.',
            video_opening_line: 'Founders need proof, not just promises.',
          },
          artifacts: {
            preview_path: imagePath,
          },
        },
      }, null, 2),
    );
    await writeFile(
      landingPagePath,
      [
        '<!doctype html>',
        '<html><body>',
        '<h1>Book the founder strategy intensive</h1>',
        '<p>Proof-led launch planning for founder-led brands.</p>',
        '<a href="/apply">Book a strategy call</a>',
        '<h2>Operator proof</h2>',
        '</body></html>',
      ].join(''),
      'utf8',
    );
    await writeFile(imagePath, 'png-preview', 'utf8');
    await writeFile(
      scriptPath,
      [
        '# Meta Ads Script',
        '',
        '## Hook',
        'See how operator-led launches close faster.',
        '',
        '## Body',
        '- Book a strategy call.',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      videoScriptPath,
      [
        '# Short Video Script',
        '',
        '## Opening Line',
        'Founders need proof, not just promises.',
        '',
        '## Beats',
        '- Show operator wins.',
        '- Invite founders to book.',
      ].join('\n'),
      'utf8',
    );
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
          research: { stage: 'research', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-research', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          strategy: { stage: 'strategy', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: stage2RunId, summary: null, primary_output: { run_id: stage2RunId }, outputs: {}, artifacts: [], errors: [] },
          production: { stage: 'production', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: stage3RunId, summary: null, primary_output: { run_id: stage3RunId }, outputs: {}, artifacts: [], errors: [] },
          publish: { stage: 'publish', status: 'awaiting_approval', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: { approval_id: 'mkta_publish_creative', workflow_step_id: 'approve_stage_4' }, artifacts: [], errors: [] },
        },
        approvals: {
          current: {
            stage: 'publish',
            status: 'awaiting_approval',
            approval_id: 'mkta_publish_creative',
            workflow_name: 'marketing-pipeline',
            workflow_step_id: 'approve_stage_4',
            title: 'Creative review required',
            message: 'Review the generated assets before publish continues.',
            requested_at: '2026-03-30T11:00:00.000Z',
            resume_token: 'resume-publish-creative',
            action_label: 'Review creative',
            publish_config: { platforms: ['meta-ads'], live_publish_platforms: ['meta-ads'], video_render_platforms: [] },
          },
          history: [],
        },
        publish_config: { platforms: ['meta-ads'], live_publish_platforms: ['meta-ads'], video_render_platforms: [] },
        brand_kit: {
          path: path.join(dataRoot, 'generated', 'validated', 'tenant_real', 'brand-kit.json'),
          source_url: 'https://sugarandleather.com',
          canonical_url: 'https://sugarandleather.com',
          brand_name: 'Sugar & Leather',
          logo_urls: ['https://sugarandleather.com/assets/wordmark.png'],
          colors: { primary: '#9c6b3e', secondary: '#f3e9dd', accent: '#3d2410', palette: ['#9c6b3e', '#f3e9dd', '#3d2410'] },
          font_families: ['Manrope'],
          external_links: [],
          extracted_at: '2026-03-30T10:55:00.000Z',
          brand_voice_summary: 'Proof-led coaching with an operator-first tone.',
          offer_summary: 'Spring planning intensive',
        },
        inputs: {
          request: {
            brandUrl: 'https://sugarandleather.com',
            brandSlug: 'public-sugarandleather-com',
            competitorUrl: 'https://betterup.com',
          },
          brand_url: 'https://sugarandleather.com',
          competitor_url: 'https://betterup.com',
          competitor_facebook_url: null,
        },
        errors: [],
        last_error: null,
        history: [],
        created_at: '2026-03-30T10:50:00.000Z',
        updated_at: '2026-03-30T11:00:00.000Z',
      }, null, 2),
    );

    const response = await handleGetMarketingJobStatus(
      jobId,
      async () => ({
        userId: 'user_123',
        tenantId: 'tenant_real',
        tenantSlug: 'acme',
        role: 'tenant_admin',
      }),
    );
    const body = (await response.json()) as Record<string, any>;

    assert.equal(response.status, 200);
    assert.notEqual(body.creativeReview, null);
    assert.equal(body.creativeReview.assets.length >= 3, true);
    assert.equal(body.creativeReview.assets.every((asset: { fullPreviewUrl: string | null }) => typeof asset.fullPreviewUrl === 'string' && asset.fullPreviewUrl.includes(`/api/marketing/jobs/${jobId}/assets/`)), true);
    assert.equal(body.creativeReview.assets.some((asset: { notes: string[] }) => asset.notes.some((note) => note.includes('Headline: Book the founder strategy intensive'))), true);
    assert.equal(body.creativeReview.assets.some((asset: { notes: string[] }) => asset.notes.some((note) => note.includes('Hook: See how operator-led launches close faster.'))), true);
    assert.equal(body.creativeReview.assets.some((asset: { notes: string[] }) => asset.notes.some((note) => note.includes('Opening line: Founders need proof, not just promises.'))), true);
    assert.equal(body.creativeReview.assets.some((asset: { notes: string[] }) => asset.notes.some((note) => note.includes('Source file: meta-ads-main.png'))), true);
    assert.equal(body.creativeReview.assets.some((asset: { summary: string }) => asset.summary === 'Book the founder strategy intensive'), true);
    assert.equal(body.creativeReview.assets.some((asset: { summary: string }) => /Generated .*ready for publishing workflows\./i.test(asset.summary)), false);
    assert.equal(body.dashboard.campaign.counts.landingPages > 0, true);
    assert.equal(body.dashboard.campaign.counts.imageAds > 0, true);
    assert.equal(body.dashboard.campaign.counts.scripts > 0, true);
    assert.equal(body.dashboard.assets.some((asset: { provenance: { sourceKind: string } }) => asset.provenance.sourceKind === 'creative_output'), true);
    assert.equal(body.artifacts.some((artifact: { details: string[] }) => artifact.details.some((detail) => /n\/a|No details yet\./i.test(detail))), false);
  });
});

test('/api/marketing/jobs/:jobId resolves https-prefixed stage log run ids into real creative assets and syncs review progression', async () => {
  await withRuntimeEnv(async (dataRoot) => {
    const { handleGetMarketingJobStatus } = await import('../app/api/marketing/jobs/[jobId]/handler');
    const jobId = 'mkt_https_prefixed_run_id_creative';
    const tenantId = 'tenant_https_prefixed';
    const stageRunId = 'https-confidecoaching-com-1ca280f0';
    const runtimeFile = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs', `${jobId}.json`);
    const brandProfilePath = path.join(dataRoot, 'generated', 'validated', tenantId, 'brand-profile.json');
    const strategyLogPath = path.join(
      process.env.OPENCLAW_LOBSTER_CWD!,
      'output',
      'logs',
      stageRunId,
      'stage-2-strategy',
      'campaign_planner.json',
    );
    const productionReviewLogPath = path.join(
      process.env.OPENCLAW_LOBSTER_CWD!,
      'output',
      'logs',
      stageRunId,
      'stage-3-production',
      'production_review_preview.json',
    );
    const campaignRoot = path.join(process.env.OPENCLAW_LOBSTER_CWD!, 'output', '10-campaign');
    const landingPagePath = path.join(campaignRoot, 'landing-pages', 'index.html');
    const imagePath = path.join(campaignRoot, 'ad-images', 'meta-feed.png');
    const storyImagePath = path.join(campaignRoot, 'ad-images', 'meta-story.png');
    const scriptPath = path.join(campaignRoot, 'scripts', 'meta-ad-script.md');
    const videoScriptPath = path.join(campaignRoot, 'scripts', 'short-video-script.md');

    await mkdir(path.dirname(runtimeFile), { recursive: true });
    await mkdir(path.dirname(brandProfilePath), { recursive: true });
    await mkdir(path.dirname(strategyLogPath), { recursive: true });
    await mkdir(path.dirname(productionReviewLogPath), { recursive: true });
    await mkdir(path.dirname(landingPagePath), { recursive: true });
    await mkdir(path.dirname(imagePath), { recursive: true });
    await mkdir(path.dirname(scriptPath), { recursive: true });

    await writeFile(
      brandProfilePath,
      JSON.stringify({
        brand_name: 'Sugar & Leather | Elite Coaching Network',
        audience: 'Founder-led operators',
        positioning: 'Proof-led coaching with operational rigor.',
        offer: 'Founder intensives',
        primary_cta: 'Book Demo',
        proof_points: ['Operator-grade coaching systems.'],
        brand_voice: ['Proof-led', 'Operator clarity'],
      }, null, 2),
    );
    await writeFile(
      strategyLogPath,
      JSON.stringify({
        brand_slug: '10',
        campaign_plan: {
          campaign_name: '10-stage2-plan',
          objective: 'Build a cross-channel strategy handoff from the canonical brand profile.',
          core_message: 'Proof-led coaching for modern founders.',
          primary_cta: 'Book Demo',
          channel_plans: [
            {
              channel: 'meta',
              goal: 'Translate the core message into meta execution.',
              message: 'Based on the provided brand data and competitive landscape, here is the brand strategy analysis for **Sugar & Leather**:',
              creative_bias: 'performance-first paid acquisition testing',
              cta: 'Book Demo',
            },
          ],
        },
      }, null, 2),
    );
    await writeFile(
      productionReviewLogPath,
      JSON.stringify({
        review_packet: {
          summary: {
            core_message: 'Production assets are ready for approval.',
          },
          asset_previews: {
            landing_page_headline: 'Unlock your full potential with elite coaching',
            meta_ad_hook: 'High-performers need rigor with support.',
            video_opening_line: 'This is the coaching system built for operators.',
          },
          artifacts: {
            preview_path: imagePath,
          },
        },
      }, null, 2),
    );
    await writeFile(
      landingPagePath,
      [
        '<!doctype html>',
        '<html><body>',
        '<h1>Unlock your full potential with elite coaching</h1>',
        '<p>Proof-led planning for ambitious operators.</p>',
        '<a href="/book">Book Demo</a>',
        '<h2>Operator proof</h2>',
        '</body></html>',
      ].join(''),
      'utf8',
    );
    await writeFile(imagePath, 'png-preview', 'utf8');
    await writeFile(storyImagePath, 'png-story-preview', 'utf8');
    await writeFile(
      scriptPath,
      [
        '# Meta Ad Script',
        '',
        '## Hook',
        'High-performers need rigor with support.',
        '',
        '## Body',
        '- Book Demo.',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      videoScriptPath,
      [
        '# Short Video Script',
        '',
        '## Opening Line',
        'This is the coaching system built for operators.',
        '',
        '## Beats',
        '- Show the duality of support and accountability.',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      runtimeFile,
      JSON.stringify({
        schema_name: 'marketing_job_state_schema',
        schema_version: '1.0.0',
        job_id: jobId,
        job_type: 'brand_campaign',
        tenant_id: tenantId,
        state: 'approval_required',
        status: 'awaiting_approval',
        current_stage: 'publish',
        stage_order: ['research', 'strategy', 'production', 'publish'],
        stages: {
          research: { stage: 'research', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-research', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          strategy: { stage: 'strategy', status: 'completed', started_at: '2026-03-30T10:00:00.000Z', completed_at: '2026-03-30T10:10:00.000Z', failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          production: { stage: 'production', status: 'completed', started_at: '2026-03-30T10:10:00.000Z', completed_at: '2026-03-30T10:20:00.000Z', failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          publish: { stage: 'publish', status: 'awaiting_approval', started_at: '2026-03-30T10:20:00.000Z', completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: { approval_id: 'mkta_https_prefixed', workflow_step_id: 'approve_stage_4' }, artifacts: [], errors: [] },
        },
        approvals: {
          current: {
            stage: 'publish',
            status: 'awaiting_approval',
            approval_id: 'mkta_https_prefixed',
            workflow_name: 'marketing-pipeline',
            workflow_step_id: 'approve_stage_4',
            title: 'Creative review required',
            message: 'Review the generated assets before publish continues.',
            requested_at: '2026-03-30T10:20:00.000Z',
            resume_token: 'resume-publish-creative',
            action_label: 'Review creative',
            publish_config: { platforms: ['meta-ads'], live_publish_platforms: ['meta-ads'], video_render_platforms: [] },
          },
          history: [],
        },
        publish_config: { platforms: ['meta-ads'], live_publish_platforms: ['meta-ads'], video_render_platforms: [] },
        brand_kit: {
          path: path.join(dataRoot, 'generated', 'validated', tenantId, 'brand-kit.json'),
          source_url: 'https://sugarandleather.com/',
          canonical_url: 'https://sugarandleather.com/',
          brand_name: 'Sugar & Leather | Elite Coaching Network',
          logo_urls: ['https://sugarandleather.com/assets/wordmark.png'],
          colors: { primary: '#9c6b3e', secondary: '#f3e9dd', accent: '#3d2410', palette: ['#9c6b3e', '#f3e9dd', '#3d2410'] },
          font_families: ['Manrope'],
          external_links: [],
          extracted_at: '2026-03-30T09:55:00.000Z',
          brand_voice_summary: 'Proof-led coaching with operator clarity.',
          offer_summary: 'Founder intensives',
        },
        inputs: {
          request: {
            brandUrl: 'https://sugarandleather.com/',
            competitorUrl: 'https://confidecoaching.com/',
          },
          brand_url: 'https://sugarandleather.com/',
          competitor_url: 'https://confidecoaching.com/',
          competitor_facebook_url: null,
        },
        errors: [],
        last_error: null,
        history: [],
        created_at: '2026-03-30T09:50:00.000Z',
        updated_at: '2026-03-30T10:20:00.000Z',
      }, null, 2),
    );

    const response = await handleGetMarketingJobStatus(
      jobId,
      async () => ({
        userId: 'user_https',
        tenantId,
        tenantSlug: 'tenant-https',
        role: 'tenant_admin',
      }),
    );
    const body = (await response.json()) as Record<string, any>;
    const channelPlanSection = body.strategyReview.sections.find((section: { id: string }) => section.id === 'channel-plan');

    assert.equal(response.status, 200);
    assert.equal(body.workflowState, 'creative_review_required');
    assert.equal(body.brandReview.status, 'approved');
    assert.equal(body.strategyReview.status, 'approved');
    assert.notEqual(body.creativeReview, null);
    assert.equal(body.creativeReview.assets.length >= 5, true);
    assert.equal(body.dashboard.campaign.counts.landingPages, 1);
    assert.equal(body.dashboard.campaign.counts.imageAds >= 2, true);
    assert.equal(body.dashboard.campaign.counts.scripts >= 2, true);
    assert.equal(body.dashboard.assets.some((asset: { provenance: { sourceKind: string } }) => asset.provenance.sourceKind === 'creative_output'), true);
    assert.equal(body.approvalRequired, true);
    assert.equal(typeof channelPlanSection?.body, 'string');
    assert.match(channelPlanSection.body, /META/);
    assert.match(channelPlanSection.body, /performance-first paid acquisition testing/i);
    assert.match(channelPlanSection.body, /Book Demo/);
    assert.equal(/Based on the provided brand data/i.test(channelPlanSection.body), false);
    assert.equal(/Translate the core message into meta execution/i.test(channelPlanSection.body), false);
  });
});

test('/api/marketing/jobs/:jobId reconstructs reviewBundle and publish counts from real Stage 4 artifacts when runtime review payloads are sparse', async () => {
  await withRuntimeEnv(async (dataRoot) => {
    const { handleGetMarketingJobStatus } = await import('../app/api/marketing/jobs/[jobId]/handler');
    const jobId = 'mkt_publish_review_reconstructed';
    const stage4RunId = 'run-publish-reconstructed';
    const runtimeFile = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs', `${jobId}.json`);
    const launchReviewPath = path.join(process.env.LOBSTER_STAGE4_CACHE_DIR!, stage4RunId, 'launch_review_preview.json');
    const preflightPath = path.join(process.env.LOBSTER_STAGE4_CACHE_DIR!, stage4RunId, 'performance_marketer_preflight.json');
    const metaPublisherPath = path.join(process.env.LOBSTER_STAGE4_CACHE_DIR!, stage4RunId, 'meta_ads_publisher.json');
    const campaignRoot = path.join(process.env.OPENCLAW_LOBSTER_CWD!, 'output', 'brand-example-campaign');
    const landingPagePath = path.join(campaignRoot, 'landing-pages', 'april-launch.html');
    const metaScriptPath = path.join(campaignRoot, 'scripts', 'meta-ads.md');
    const shortVideoScriptPath = path.join(campaignRoot, 'scripts', 'short-video.md');
    const publishRoot = path.join(process.env.OPENCLAW_LOBSTER_CWD!, 'output', 'publish-ready', 'brand-example-stage2-plan', 'meta-ads');
    const imagePath = path.join(publishRoot, 'meta-ads.png');
    const copyPath = path.join(publishRoot, 'copy.json');
    const contractPath = path.join(publishRoot, 'meta-ads.json');
    const reviewPackagePath = path.join(
      process.env.OPENCLAW_LOBSTER_CWD!,
      'output',
      'aries-review',
      'tenant_real',
      'brand-example-stage2-plan',
      'meta-ads',
      'review-package.json',
    );

    await mkdir(path.dirname(runtimeFile), { recursive: true });
    await mkdir(path.dirname(launchReviewPath), { recursive: true });
    await mkdir(path.dirname(preflightPath), { recursive: true });
    await mkdir(path.dirname(metaPublisherPath), { recursive: true });
    await mkdir(path.dirname(landingPagePath), { recursive: true });
    await mkdir(path.dirname(metaScriptPath), { recursive: true });
    await mkdir(path.dirname(shortVideoScriptPath), { recursive: true });
    await mkdir(path.dirname(imagePath), { recursive: true });
    await mkdir(path.dirname(reviewPackagePath), { recursive: true });

    await writeFile(
      landingPagePath,
      [
        '<!doctype html>',
        '<html><body>',
        '<h1>Book the founder strategy intensive</h1>',
        '<p>Operator-led launch planning for founder-led teams.</p>',
        '<a href="/apply">Book the strategy call</a>',
        '<h2>Proof-led process</h2>',
        '</body></html>',
      ].join(''),
      'utf8',
    );
    await writeFile(
      metaScriptPath,
      [
        '# Meta Ads Script',
        '',
        '## Hook',
        'See how operator-led launches close faster.',
        '',
        '## Body',
        '- Operator-led launch guidance for April buyers.',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      shortVideoScriptPath,
      [
        '# Short Video Script',
        '',
        '## Opening Line',
        'Founders need proof, not just promises.',
        '',
        '## Beats',
        '- Show operator wins.',
        '- Invite founders to book.',
      ].join('\n'),
      'utf8',
    );
    await writeFile(imagePath, 'png-preview', 'utf8');
    await writeFile(
      copyPath,
      JSON.stringify({
        headline: 'April collection launch',
        body_lines: ['Operator-led launch guidance for April buyers.'],
        primary_cta: 'Book the strategy call',
      }, null, 2),
      'utf8',
    );
    await writeFile(
      contractPath,
      JSON.stringify({
        platform_slug: 'meta-ads',
        creative: {
          headline: 'April collection launch',
        },
      }, null, 2),
      'utf8',
    );

    const workspacePath = (filePath: string) =>
      filePath.replace(process.env.CODE_ROOT!, '/home/node/workspace/aries-app');

    await writeFile(
      reviewPackagePath,
      JSON.stringify({
        platform: 'meta-ads',
        summary: 'Compiled current package',
        contract_path: workspacePath(contractPath),
        asset_paths: {
          copy_path: workspacePath(copyPath),
          image_path: workspacePath(imagePath),
        },
      }, null, 2),
      'utf8',
    );
    await writeFile(
      launchReviewPath,
      JSON.stringify({
        generated_at: '2026-03-30T11:15:00.000Z',
        approval_preview: {
          message: 'Approve creation of the Meta campaigns, ad sets, and ads as PAUSED.',
        },
      }, null, 2),
      'utf8',
    );
    await writeFile(
      preflightPath,
      JSON.stringify({
        run_id: stage4RunId,
        campaign_name: 'brand-example-stage2-plan',
        production_handoff: {
          production_brief: {
            core_message: 'Operator-led launch package ready for paused publish.',
          },
          offer_summary: 'April planning intensive',
        },
      }, null, 2),
      'utf8',
    );
    await writeFile(
      metaPublisherPath,
      JSON.stringify({
        platform: 'meta-ads',
        publish_package: {
          review_package_path: workspacePath(reviewPackagePath),
          image_path: workspacePath(imagePath),
          copy_path: workspacePath(copyPath),
        },
        contract_path: workspacePath(contractPath),
      }, null, 2),
      'utf8',
    );
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
          research: { stage: 'research', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-r', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          strategy: { stage: 'strategy', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-s', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          production: { stage: 'production', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-p', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          publish: {
            stage: 'publish',
            status: 'awaiting_approval',
            started_at: '2026-03-30T11:15:00.000Z',
            completed_at: null,
            failed_at: null,
            run_id: stage4RunId,
            summary: { summary: 'Stage 4 pre-flight complete.' },
            primary_output: null,
            outputs: {
              approval_id: 'mkta_publish_reconstructed',
              workflow_step_id: 'approve_stage_4_publish',
              resume_token: 'resume-publish-reconstructed',
            },
            artifacts: [],
            errors: [],
          },
        },
        approvals: {
          current: {
            stage: 'publish',
            status: 'awaiting_approval',
            approval_id: 'mkta_publish_reconstructed',
            workflow_step_id: 'approve_stage_4_publish',
            title: 'Publish to Meta (paused) approval required',
            message: 'Approve creation of the Meta campaigns, ad sets, and ads as PAUSED.',
            requested_at: '2026-03-30T11:15:00.000Z',
            resume_token: 'resume-publish-reconstructed',
            action_label: 'Approve paused publish',
            publish_config: { platforms: ['meta-ads'], live_publish_platforms: ['meta-ads'], video_render_platforms: [] },
          },
          history: [],
        },
        publish_config: { platforms: ['meta-ads'], live_publish_platforms: ['meta-ads'], video_render_platforms: [] },
        brand_kit: {
          path: path.join(dataRoot, 'generated', 'validated', 'tenant_real', 'brand-kit.json'),
          source_url: 'https://brand.example',
          canonical_url: 'https://brand.example',
          brand_name: 'Brand Example',
          logo_urls: [],
          colors: { primary: '#111111', secondary: '#f4f4f4', accent: '#c24d2c', palette: ['#111111', '#f4f4f4', '#c24d2c'] },
          font_families: ['Manrope'],
          external_links: [],
          extracted_at: '2026-03-30T10:55:00.000Z',
        },
        inputs: {
          request: {
            brandUrl: 'https://brand.example',
            competitorUrl: 'https://betterup.com',
          },
          brand_url: 'https://brand.example',
          competitor_url: 'https://betterup.com',
          competitor_facebook_url: null,
        },
        errors: [],
        last_error: null,
        history: [],
        created_at: '2026-03-30T11:00:00.000Z',
        updated_at: '2026-03-30T11:15:00.000Z',
      }, null, 2),
      'utf8',
    );

    const response = await handleGetMarketingJobStatus(
      jobId,
      async () => ({
        userId: 'user_123',
        tenantId: 'tenant_real',
        tenantSlug: 'acme',
        role: 'tenant_admin',
      }),
    );
    const body = (await response.json()) as Record<string, any>;
    const serializedReviewBundle = JSON.stringify(body.reviewBundle);

    assert.equal(response.status, 200);
    assert.notEqual(body.reviewBundle, null);
    assert.equal(body.reviewBundle.summary, 'Operator-led launch package ready for paused publish.');
    assert.equal(body.reviewBundle.approvalMessage, 'Approve creation of the Meta campaigns, ad sets, and ads as PAUSED.');
    assert.equal(body.reviewBundle.landingPage.headline, 'Book the founder strategy intensive');
    assert.equal(body.reviewBundle.landingPage.cta, 'Book the strategy call');
    assert.equal(body.reviewBundle.scriptPreview.metaAdHook, 'See how operator-led launches close faster.');
    assert.equal(body.reviewBundle.scriptPreview.shortVideoOpeningLine, 'Founders need proof, not just promises.');
    assert.equal(body.reviewBundle.platformPreviews.length > 0, true);
    assert.equal(body.reviewBundle.platformPreviews.some((preview: { platformSlug: string }) => preview.platformSlug === 'meta-ads'), true);
    assert.equal(body.reviewBundle.platformPreviews.some((preview: { summary: string }) => preview.summary === 'Operator-led launch guidance for April buyers.'), true);
    assert.equal(body.reviewBundle.platformPreviews.some((preview: { platformSlug: string; mediaAssets: Array<{ url: string }> }) => preview.platformSlug === 'meta-ads' && preview.mediaAssets[0]?.url === `/api/marketing/jobs/${jobId}/assets/platform-preview-meta-ads-media-1`), true);
    assert.equal(body.reviewBundle.platformPreviews.some((preview: { platformSlug: string; assetLinks: unknown[] }) => preview.platformSlug === 'meta-ads' && preview.assetLinks.length > 0), true);
    assert.equal(body.assetPreviewCards.length > 0, true);
    assert.equal(body.dashboard.campaign.counts.publishItems > 0, true);
    assert.equal(body.dashboard.publishItems.length > 0, true);
    assert.doesNotMatch(serializedReviewBundle, /No details yet\.|\"n\/a\"/i);
  });
});

test('/api/marketing/jobs/:jobId does not leak an older Stage 4 launch review into a fresh strategy approval', async () => {
  await withRuntimeEnv(async (dataRoot) => {
    const { handleGetMarketingJobStatus } = await import('../app/api/marketing/jobs/[jobId]/handler');
    const jobId = 'mkt_strategy_no_publish_leak';
    const runtimeFile = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs', `${jobId}.json`);
    const runId = 'betterup-com-oldrun';
    const logsRoot = path.join(process.env.OPENCLAW_LOBSTER_CWD!, 'output', 'logs', runId, 'stage-4-publish-optimize');
    const stalePublishImagePath = path.join(process.env.CODE_ROOT!, 'lobster', 'output', 'publish-ready', '6-stage2-plan', 'meta-ads', 'meta.png');

    await mkdir(path.dirname(runtimeFile), { recursive: true });
    await mkdir(logsRoot, { recursive: true });
    await mkdir(path.dirname(stalePublishImagePath), { recursive: true });
    await writeFile(stalePublishImagePath, 'png-preview', 'utf8');
    await writeFile(
      path.join(logsRoot, 'launch_review_preview.json'),
      JSON.stringify({
        generated_at: '2026-03-27T09:11:25.000Z',
        review_bundle: {
          campaign_name: '6-stage2-plan',
          summary: {
            core_message: 'This stale launch review must not attach to a new strategy checkpoint.',
          },
          platform_previews: [
            {
              platform_slug: 'meta-ads',
              platform_name: 'Meta Ads',
              channel_type: 'paid-social',
              summary: 'Old launch package',
              media_paths: [stalePublishImagePath],
              asset_paths: {},
            },
          ],
        },
      }, null, 2)
    );

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
        current_stage: 'strategy',
        stage_order: ['research', 'strategy', 'production', 'publish'],
        stages: {
          research: { stage: 'research', status: 'completed', started_at: '2026-03-27T09:25:35.136Z', completed_at: '2026-03-27T09:25:43.384Z', failed_at: null, run_id: null, summary: null, primary_output: {}, outputs: {}, artifacts: [], errors: [] },
          strategy: { stage: 'strategy', status: 'awaiting_approval', started_at: '2026-03-27T09:25:43.387Z', completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: {}, outputs: { approval_id: 'mkta_strategy', workflow_step_id: 'approve_stage_2' }, artifacts: [], errors: [] },
          production: { stage: 'production', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          publish: { stage: 'publish', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
        },
        approvals: {
          current: {
            stage: 'strategy',
            status: 'awaiting_approval',
            approval_id: 'mkta_strategy',
            workflow_name: 'marketing-pipeline',
            workflow_step_id: 'approve_stage_2',
            title: 'Strategy approval required',
            message: 'Stage 1 complete. Continue to Stage 2 and run head-of-marketing for the provided brand_url?',
            requested_at: '2026-03-27T09:25:43.387Z',
            resume_token: 'resume-strategy',
            action_label: 'Review strategy',
            publish_config: null,
          },
          history: [],
        },
        publish_config: { platforms: ['meta-ads'], live_publish_platforms: ['meta-ads'], video_render_platforms: [] },
        brand_kit: {
          path: path.join(dataRoot, 'generated', 'validated', 'tenant_real', 'brand-kit.json'),
          source_url: 'https://sugarandleather.com',
          canonical_url: 'https://sugarandleather.com',
          brand_name: 'Sugar & Leather | Elite Coaching Network',
          logo_urls: [],
          colors: { primary: '#000000', secondary: '#ffffff', accent: '#fb2c36', palette: ['#000000', '#ffffff', '#fb2c36'] },
          font_families: ['Inter'],
          external_links: [],
          extracted_at: '2026-03-27T08:35:42.657Z',
        },
        inputs: {
          request: {
            brandUrl: 'https://sugarandleather.com',
            competitorUrl: 'https://betterup.com',
          },
          brand_url: 'https://sugarandleather.com',
          competitor_url: 'https://betterup.com',
          competitor_facebook_url: null,
        },
        errors: [],
        last_error: null,
        history: [],
        created_at: '2026-03-27T09:25:35.134Z',
        updated_at: '2026-03-27T09:25:43.387Z',
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
    const body = (await response.json()) as Record<string, any>;

    assert.equal(response.status, 200);
    assert.equal(body.marketing_stage, 'strategy');
    assert.equal(body.summary.headline, 'Research complete');
    assert.equal(body.summary.subheadline, 'Research is complete. Continue to brand analysis.');
    assert.equal(body.workflowState, 'draft');
    assert.equal(body.brandReview, null);
    assert.equal(body.approval.title, 'Research complete');
    assert.equal(body.approval.message, 'Research is complete. Continue to brand analysis.');
    assert.equal(body.approval.actionLabel, 'Continue to brand analysis');
    assert.equal(body.approval.actionHref, `/review/${encodeURIComponent(`${jobId}::approval`)}`);
    assert.equal(
      body.stageCards.some(
        (card: { stage: string; summary: string }) =>
          card.stage === 'strategy' && card.summary === 'Research is complete. Continue to brand analysis.',
      ),
      true,
    );
    assert.equal(
      body.timeline.some(
        (entry: { label: string; description: string }) =>
          entry.label === 'Brand analysis checkpoint requested' &&
          entry.description === 'Research is complete. Continue to brand analysis.',
      ),
      true,
    );
    assert.equal(body.reviewBundle, null);
    assert.equal(body.assetPreviewCards.length, 0);
    assert.equal(body.dashboard.campaign.name, 'Sugar & Leather | Elite Coaching Network');
    assert.equal(body.dashboard.campaign.approvalActionHref, `/review/${encodeURIComponent(`${jobId}::approval`)}`);
    assert.equal(body.dashboard.assets.length, 0);
    assert.equal(body.dashboard.posts.length, 0);
    assert.equal(body.dashboard.publishItems.length, 0);
    assert.equal(body.dashboard.calendarEvents.length, 0);
  });
});

test('buildCampaignWorkspaceView keeps upload-only brand review pending and reopens it when real brand artifacts arrive', async () => {
  await withRuntimeEnv(async (dataRoot) => {
    const { buildCampaignWorkspaceView } = await import('../backend/marketing/workspace-views');
    const {
      ensureCampaignWorkspaceRecord,
      loadCampaignWorkspaceRecord,
      saveCampaignWorkspaceAssets,
      saveCampaignWorkspaceRecord,
    } = await import('../backend/marketing/workspace-store');
    const jobId = 'mkt_brand_review_auto_approval_guard';
    const tenantId = 'tenant_brand_review_auto_approval_guard';
    const runtimeFile = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs', `${jobId}.json`);
    const brandProfilePath = path.join(dataRoot, 'generated', 'validated', tenantId, 'brand-profile.json');

    await mkdir(path.dirname(runtimeFile), { recursive: true });
    await writeFile(
      runtimeFile,
      JSON.stringify({
        schema_name: 'marketing_job_state_schema',
        schema_version: '1.0.0',
        job_id: jobId,
        job_type: 'brand_campaign',
        tenant_id: tenantId,
        state: 'approval_required',
        status: 'awaiting_approval',
        current_stage: 'production',
        stage_order: ['research', 'strategy', 'production', 'publish'],
        stages: {
          research: { stage: 'research', status: 'completed', started_at: '2026-03-31T00:00:00.000Z', completed_at: '2026-03-31T00:05:00.000Z', failed_at: null, run_id: 'run-research', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          strategy: { stage: 'strategy', status: 'completed', started_at: '2026-03-31T00:05:00.000Z', completed_at: '2026-03-31T00:10:00.000Z', failed_at: null, run_id: 'run-strategy', summary: null, primary_output: {}, outputs: { approval_id: 'mkta_strategy_auto_guard', workflow_step_id: 'approve_stage_2' }, artifacts: [], errors: [] },
          production: { stage: 'production', status: 'awaiting_approval', started_at: '2026-03-31T00:10:00.000Z', completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: { approval_id: 'mkta_production_auto_guard', workflow_step_id: 'approve_stage_3' }, artifacts: [], errors: [] },
          publish: { stage: 'publish', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
        },
        approvals: {
          current: {
            stage: 'production',
            status: 'awaiting_approval',
            approval_id: 'mkta_production_auto_guard',
            workflow_name: 'marketing-pipeline',
            workflow_step_id: 'approve_stage_3',
            title: 'Strategy review required',
            message: 'Review the campaign proposal before production begins.',
            requested_at: '2026-03-31T00:10:00.000Z',
            resume_token: 'resume-production-auto-guard',
            action_label: 'Review strategy',
            publish_config: null,
          },
          history: [],
        },
        publish_config: { platforms: ['meta-ads'], live_publish_platforms: [], video_render_platforms: [] },
        brand_kit: {
          path: path.join(dataRoot, 'generated', 'validated', tenantId, 'brand-kit.json'),
          source_url: 'https://auto-guard.example',
          canonical_url: 'https://auto-guard.example',
          brand_name: 'Auto Guard Co',
          logo_urls: ['https://auto-guard.example/logo.png'],
          colors: { primary: '#111111', secondary: '#f5f5f5', accent: '#c24d2c', palette: ['#111111', '#f5f5f5', '#c24d2c'] },
          font_families: ['Manrope'],
          external_links: [],
          extracted_at: '2026-03-31T00:04:00.000Z',
          brand_voice_summary: 'Direct and proof-led.',
        },
        inputs: {
          request: {
            brandUrl: 'https://auto-guard.example',
            businessName: 'Auto Guard Co',
            goal: 'Drive qualified calls',
            offer: 'Planning sprint',
            brandVoice: 'Direct and proof-led',
          },
          brand_url: 'https://auto-guard.example',
          competitor_url: 'https://competitor.example',
          competitor_facebook_url: null,
        },
        errors: [],
        last_error: null,
        history: [],
        created_at: '2026-03-31T00:00:00.000Z',
        updated_at: '2026-03-31T00:10:00.000Z',
      }, null, 2),
    );

    const record = ensureCampaignWorkspaceRecord({
      jobId,
      tenantId,
      payload: {
        websiteUrl: 'https://auto-guard.example',
        businessName: 'Auto Guard Co',
        goal: 'Drive qualified calls',
        offer: 'Planning sprint',
        brandVoice: 'Direct and proof-led',
      },
    });
    saveCampaignWorkspaceAssets(record, [
      {
        name: 'logo-lockup.png',
        contentType: 'image/png',
        data: Buffer.from('logo-lockup'),
      },
    ]);

    const uploadOnlyView = buildCampaignWorkspaceView(jobId);
    let savedRecord = loadCampaignWorkspaceRecord(jobId, tenantId);

    assert.equal(uploadOnlyView.workflowState, 'draft');
    assert.equal(uploadOnlyView.brandReview?.status, 'pending_review');
    assert.equal(savedRecord?.stage_reviews.brand.status, 'pending_review');
    assert.equal(savedRecord?.stage_reviews.brand.evidenceKind, 'upload_only');

    savedRecord = {
      ...savedRecord!,
      stage_reviews: {
        ...savedRecord!.stage_reviews,
        brand: {
          ...savedRecord!.stage_reviews.brand,
          status: 'approved',
          latestNote: 'Keep the uploaded logo lockup.',
          evidenceKind: 'upload_only',
        },
      },
    };
    saveCampaignWorkspaceRecord(savedRecord);

    await mkdir(path.dirname(brandProfilePath), { recursive: true });
    await writeFile(
      brandProfilePath,
      JSON.stringify({
        brand_name: 'Auto Guard Co',
        audience: 'Founder-led teams',
        positioning: 'Operator-led planning for launches that need sharper proof.',
        offer: 'Planning sprint',
        primary_cta: 'Book a planning call',
        proof_points: ['Proof-driven operating plans.'],
        brand_voice: ['Direct', 'Proof-led'],
      }, null, 2),
    );

    const realArtifactView = buildCampaignWorkspaceView(jobId);
    savedRecord = loadCampaignWorkspaceRecord(jobId, tenantId);

    assert.equal(realArtifactView.brandReview?.status, 'pending_review');
    assert.equal(savedRecord?.stage_reviews.brand.status, 'pending_review');
    assert.equal(savedRecord?.stage_reviews.brand.evidenceKind, 'real_artifacts');
    assert.equal(savedRecord?.stage_reviews.brand.latestNote, 'Keep the uploaded logo lockup.');
  });
});

test('buildCampaignWorkspaceView backfills an empty campaign brief brand voice from validated brand analysis', async () => {
  await withRuntimeEnv(async (dataRoot) => {
    const { buildCampaignWorkspaceView } = await import('../backend/marketing/workspace-views');
    const { loadCampaignWorkspaceRecord } = await import('../backend/marketing/workspace-store');
    const jobId = 'mkt_brief_brand_voice_backfill';
    const tenantId = 'tenant_brief_brand_voice_backfill';
    const runtimeFile = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs', `${jobId}.json`);
    const brandProfilePath = path.join(dataRoot, 'generated', 'validated', tenantId, 'brand-profile.json');

    await mkdir(path.dirname(runtimeFile), { recursive: true });
    await writeFile(
      runtimeFile,
      JSON.stringify({
        schema_name: 'marketing_job_state_schema',
        schema_version: '1.0.0',
        job_id: jobId,
        job_type: 'brand_campaign',
        tenant_id: tenantId,
        state: 'approval_required',
        status: 'awaiting_approval',
        current_stage: 'strategy',
        stage_order: ['research', 'strategy', 'production', 'publish'],
        stages: {
          research: { stage: 'research', status: 'completed', started_at: '2026-04-04T00:00:00.000Z', completed_at: '2026-04-04T00:05:00.000Z', failed_at: null, run_id: 'run-research', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          strategy: { stage: 'strategy', status: 'awaiting_approval', started_at: '2026-04-04T00:05:00.000Z', completed_at: null, failed_at: null, run_id: 'run-strategy', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          production: { stage: 'production', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          publish: { stage: 'publish', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
        },
        approvals: {
          current: {
            stage: 'strategy',
            status: 'awaiting_approval',
            title: 'Brand review required',
            message: 'Review the derived brand profile before strategy continues.',
            requested_at: '2026-04-04T00:05:00.000Z',
            resume_token: 'resume-strategy-brief-backfill',
            action_label: 'Review brand analysis',
            publish_config: null,
          },
          history: [],
        },
        publish_config: { platforms: ['meta-ads'], live_publish_platforms: [], video_render_platforms: [] },
        brand_kit: {
          path: path.join(dataRoot, 'generated', 'validated', tenantId, 'brand-kit.json'),
          source_url: 'https://sugarandleather.com',
          canonical_url: 'https://sugarandleather.com',
          brand_name: 'Sugar & Leather',
          logo_urls: [],
          colors: {
            primary: '#f6339a',
            secondary: '#a855f7',
            accent: '#e60076',
            palette: ['#f6339a', '#a855f7', '#e60076'],
          },
          font_families: ['Inter'],
          external_links: [],
          extracted_at: '2026-04-04T00:04:00.000Z',
          brand_voice_summary: 'Sophisticated, provocative, and authoritative.',
          offer_summary: 'Elite coaching network',
        },
        inputs: {
          request: {
            brandUrl: 'https://sugarandleather.com',
            websiteUrl: 'https://sugarandleather.com',
          },
          brand_url: 'https://sugarandleather.com',
          competitor_url: null,
          competitor_facebook_url: null,
        },
        errors: [],
        last_error: null,
        history: [],
        created_at: '2026-04-04T00:00:00.000Z',
        updated_at: '2026-04-04T00:05:00.000Z',
      }, null, 2),
    );

    await mkdir(path.dirname(brandProfilePath), { recursive: true });
    await writeFile(
      brandProfilePath,
      JSON.stringify({
        brand_name: 'Sugar & Leather',
        website_url: 'https://sugarandleather.com',
        audience: 'High-performing executives',
        positioning: 'Elite coaching for high-stakes operators.',
        offer: 'Elite coaching network',
        primary_cta: 'Apply for Elite Coaching',
        proof_points: ['Elite practitioners', 'Bespoke coaching frameworks'],
        brand_voice: ['Sophisticated', 'Provocative', 'Authoritative'],
      }, null, 2),
    );

    const view = buildCampaignWorkspaceView(jobId);
    const savedRecord = loadCampaignWorkspaceRecord(jobId, tenantId);

    assert.equal(view.campaignBrief?.brandVoice, 'Sophisticated\nProvocative\nAuthoritative');
    assert.equal(savedRecord?.brief.brandVoice, 'Sophisticated\nProvocative\nAuthoritative');
  });
});

test('/api/marketing/jobs/:jobId does not surface creative-output posts before production has actually started', async () => {
  await withRuntimeEnv(async (dataRoot) => {
    const { handleGetMarketingJobStatus } = await import('../app/api/marketing/jobs/[jobId]/handler');
    const jobId = 'mkt_production_gate_no_creative_leak';
    const runtimeFile = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs', `${jobId}.json`);
    const proposalRoot = path.join(process.env.OPENCLAW_LOBSTER_CWD!, 'output');
    const staticContractPath = path.join(proposalRoot, 'static-contracts', '6-stage2-plan', 'meta-ads.json');
    const plannerPath = path.join(process.env.LOBSTER_STAGE2_CACHE_DIR!, 'run-strategy', 'campaign_planner.json');

    await mkdir(path.dirname(runtimeFile), { recursive: true });
    await mkdir(path.dirname(staticContractPath), { recursive: true });
    await mkdir(path.dirname(plannerPath), { recursive: true });
    await writeFile(
      plannerPath,
      JSON.stringify({
        brand_slug: 'sugarandleather-com',
        campaign_plan: {
          campaign_name: '6-stage2-plan',
          objective: 'Grow lead volume with proof-led messaging.',
          channel_plans: [
            { channel: 'meta-ads', message: 'Proof-led Meta concept' },
            { channel: 'instagram', message: 'Proof-led Instagram concept' },
          ],
        },
      }, null, 2)
    );
    await writeFile(staticContractPath, JSON.stringify({
      campaign_id: '6-stage2-plan',
      platform_slug: 'meta-ads',
      creative: {
        headline: 'Stale production creative',
      },
    }, null, 2));
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
        current_stage: 'production',
        stage_order: ['research', 'strategy', 'production', 'publish'],
        stages: {
          research: { stage: 'research', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-research', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          strategy: { stage: 'strategy', status: 'completed', started_at: '2026-03-27T09:25:43.387Z', completed_at: '2026-03-27T09:30:00.000Z', failed_at: null, run_id: 'run-strategy', summary: null, primary_output: {}, outputs: { approval_id: 'mkta_strategy', workflow_step_id: 'approve_stage_2' }, artifacts: [], errors: [] },
          production: { stage: 'production', status: 'awaiting_approval', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: { approval_id: 'mkta_production', workflow_step_id: 'approve_stage_3' }, artifacts: [], errors: [] },
          publish: { stage: 'publish', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
        },
        approvals: {
          current: {
            stage: 'production',
            status: 'awaiting_approval',
            approval_id: 'mkta_production',
            workflow_name: 'marketing-pipeline',
            workflow_step_id: 'approve_stage_3',
            title: 'Production approval required',
            message: 'Approve the strategy proposal before production begins.',
            requested_at: '2026-03-27T09:30:00.000Z',
            resume_token: 'resume-production',
            action_label: 'Review proposal',
            publish_config: null,
          },
          history: [],
        },
        publish_config: { platforms: ['meta-ads'], live_publish_platforms: ['meta-ads'], video_render_platforms: [] },
        brand_kit: {
          path: path.join(dataRoot, 'generated', 'validated', 'tenant_real', 'brand-kit.json'),
          source_url: 'https://sugarandleather.com',
          canonical_url: 'https://sugarandleather.com',
          brand_name: 'Sugar & Leather | Elite Coaching Network',
          logo_urls: [],
          colors: { primary: '#000000', secondary: '#ffffff', accent: '#fb2c36', palette: ['#000000', '#ffffff', '#fb2c36'] },
          font_families: ['Inter'],
          external_links: [],
          extracted_at: '2026-03-27T08:35:42.657Z',
        },
        inputs: {
          request: {
            brandUrl: 'https://sugarandleather.com',
            competitorUrl: 'https://betterup.com',
          },
          brand_url: 'https://sugarandleather.com',
          competitor_url: 'https://betterup.com',
          competitor_facebook_url: null,
        },
        errors: [],
        last_error: null,
        history: [],
        created_at: '2026-03-27T09:25:35.134Z',
        updated_at: '2026-03-27T09:30:00.000Z',
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
    const body = (await response.json()) as Record<string, any>;

    assert.equal(response.status, 200);
    assert.equal(body.marketing_stage, 'production');
    assert.equal(body.dashboard.campaign.counts.proposalConcepts > 0, true);
    assert.equal(body.dashboard.posts.some((post: { provenance: { sourceKind: string } }) => post.provenance.sourceKind === 'creative_output'), false);
    assert.equal(body.dashboard.assets.some((asset: { provenance: { sourceKind: string } }) => asset.provenance.sourceKind === 'creative_output'), false);
  });
});

test('/api/marketing/jobs/:jobId does not surface Stage 4 launch review content during the earlier launch-approval gate', async () => {
  await withRuntimeEnv(async (dataRoot) => {
    const { handleGetMarketingJobStatus } = await import('../app/api/marketing/jobs/[jobId]/handler');
    const jobId = 'mkt_launch_gate_no_publish_review';
    const runtimeFile = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs', `${jobId}.json`);
    const runId = 'betterup-com-live';
    const logsRoot = path.join(process.env.OPENCLAW_LOBSTER_CWD!, 'output', 'logs', runId, 'stage-4-publish-optimize');
    const publishImagePath = path.join(process.env.OPENCLAW_LOBSTER_CWD!, 'output', 'publish-ready', '6-stage2-plan', 'meta-ads', 'meta-ads.png');

    await mkdir(path.dirname(runtimeFile), { recursive: true });
    await mkdir(logsRoot, { recursive: true });
    await mkdir(path.dirname(publishImagePath), { recursive: true });
    await writeFile(publishImagePath, 'png-preview', 'utf8');
    await writeFile(
      path.join(logsRoot, 'launch_review_preview.json'),
      JSON.stringify({
        generated_at: '2026-03-27T09:40:46.725Z',
        review_bundle: {
          campaign_name: 'Sugar & Leather April Launch',
          summary: {
            core_message: 'This stale Stage 4 launch review should not appear during approve_stage_4.',
          },
          platform_previews: [
            {
              platform_slug: 'meta-ads',
              platform_name: 'Meta Ads',
              channel_type: 'paid-social',
              summary: 'Paused-publish preview',
              media_paths: [publishImagePath],
              asset_paths: {},
            },
          ],
        },
      }, null, 2)
    );
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
          research: { stage: 'research', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-r', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          strategy: { stage: 'strategy', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-s', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          production: { stage: 'production', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-p', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          publish: {
            stage: 'publish',
            status: 'awaiting_approval',
            started_at: '2026-03-27T09:40:46.725Z',
            completed_at: null,
            failed_at: null,
            run_id: null,
            summary: { summary: 'Stage 3 complete. Approve the creative assets and continue to Stage 4 publishing?' },
            primary_output: {},
            outputs: {
              approval_id: 'mkta_launch',
              workflow_step_id: 'approve_stage_4',
              resume_token: 'resume-launch',
            },
            artifacts: [],
            errors: [],
          },
        },
        approvals: {
          current: {
            stage: 'publish',
            status: 'awaiting_approval',
            approval_id: 'mkta_launch',
            workflow_name: 'marketing-pipeline',
            workflow_step_id: 'approve_stage_4',
            title: 'Launch approval required',
            message: 'Stage 3 complete. Approve the creative assets and continue to Stage 4 publishing?',
            requested_at: '2026-03-27T09:40:46.725Z',
            resume_token: 'resume-launch',
            action_label: 'Approve launch review',
            publish_config: { platforms: ['meta-ads'], live_publish_platforms: ['meta-ads'], video_render_platforms: [] },
          },
          history: [],
        },
        publish_config: { platforms: ['meta-ads'], live_publish_platforms: ['meta-ads'], video_render_platforms: [] },
        brand_kit: {
          path: path.join(dataRoot, 'generated', 'validated', 'tenant_real', 'brand-kit.json'),
          source_url: 'https://sugarandleather.com',
          canonical_url: 'https://sugarandleather.com',
          brand_name: 'Sugar & Leather | Elite Coaching Network',
          logo_urls: [],
          colors: { primary: '#000000', secondary: '#ffffff', accent: '#fb2c36', palette: ['#000000', '#ffffff', '#fb2c36'] },
          font_families: ['Inter'],
          external_links: [],
          extracted_at: '2026-03-27T08:35:42.657Z',
        },
        inputs: {
          request: {
            brandUrl: 'https://sugarandleather.com',
            competitorUrl: 'https://betterup.com',
          },
          brand_url: 'https://sugarandleather.com',
          competitor_url: 'https://betterup.com',
          competitor_facebook_url: null,
        },
        errors: [],
        last_error: null,
        history: [],
        created_at: '2026-03-27T09:25:35.134Z',
        updated_at: '2026-03-27T09:40:46.725Z',
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
    const body = (await response.json()) as Record<string, any>;

    assert.equal(response.status, 200);
    assert.equal(body.marketing_stage, 'publish');
    assert.equal(body.approval.workflowStepId, 'approve_stage_4');
    assert.equal(body.reviewBundle, null);
    assert.equal(body.assetPreviewCards.length, 0);
  });
});

test('/api/marketing/jobs/:jobId/assets/:assetId serves a tenant-scoped preview asset without exposing file paths', async () => {
  await withRuntimeEnv(async (dataRoot) => {
    const { handleGetMarketingJobAsset } = await import('../app/api/marketing/jobs/[jobId]/assets/[assetId]/handler');
    const jobId = 'mkt_asset_job';
    const runtimeFile = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs', `${jobId}.json`);
    const mediaAssetRelativePath = path.join('generated', 'draft', 'marketing-assets', 'meta-preview.png');
    const mediaAssetPath = path.join(dataRoot, mediaAssetRelativePath);
    await mkdir(path.dirname(runtimeFile), { recursive: true });
    await mkdir(path.dirname(mediaAssetPath), { recursive: true });
    await writeFile(mediaAssetPath, 'png-preview', 'utf8');
    let tenantLoaderCalls = 0;
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
          research: { stage: 'research', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-r', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          strategy: { stage: 'strategy', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-s', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          production: { stage: 'production', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-p', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          publish: {
            stage: 'publish',
            status: 'awaiting_approval',
            started_at: null,
            completed_at: null,
            failed_at: null,
            run_id: 'run-publish',
            summary: null,
            primary_output: null,
            outputs: {
              review: {
                review_bundle: {
                  campaign_name: 'Sugar & Leather',
                  summary: {},
                  platform_previews: [
                    {
                      platform_slug: 'meta-ads',
                      platform_name: 'Meta Ads',
                      channel_type: 'paid-social',
                      summary: 'Preview ready',
                      media_paths: [mediaAssetRelativePath],
                      asset_paths: {},
                    },
                  ],
                },
              },
            },
            artifacts: [],
            errors: [],
          },
        },
        approvals: { current: null, history: [] },
        publish_config: { platforms: ['meta-ads'], live_publish_platforms: [], video_render_platforms: [] },
        brand_kit: {
          path: path.join(dataRoot, 'generated', 'validated', 'tenant_real', 'brand-kit.json'),
          source_url: 'https://sugarandleather.com',
          canonical_url: 'https://sugarandleather.com',
          brand_name: 'Sugar & Leather',
          logo_urls: [],
          colors: { primary: '#9c6b3e', secondary: '#f3e9dd', accent: '#3d2410', palette: ['#9c6b3e', '#f3e9dd', '#3d2410'] },
          font_families: ['Manrope'],
          external_links: [],
          extracted_at: '2026-03-18T00:00:00.000Z',
        },
        inputs: { request: {}, brand_url: 'https://sugarandleather.com' },
        errors: [],
        last_error: null,
        history: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, null, 2)
    );

    const response = await handleGetMarketingJobAsset(
      jobId,
      'platform-preview-meta-ads-media-1',
      async () => {
        tenantLoaderCalls += 1;
        return {
          userId: 'user_123',
          tenantId: 'tenant_real',
          tenantSlug: 'acme',
          role: 'tenant_admin',
        };
      }
    );
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(body, 'png-preview');
    assert.equal(tenantLoaderCalls, 1);
  });
});

test('/api/marketing/jobs/:jobId/assets/:assetId sniffs image bytes so preview content types stay truthful when file extensions drift', async () => {
  await withRuntimeEnv(async (dataRoot) => {
    const { handleGetMarketingJobAsset } = await import('../app/api/marketing/jobs/[jobId]/assets/[assetId]/handler');
    const jobId = 'mkt_asset_sniffed_job';
    const runtimeFile = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs', `${jobId}.json`);
    const mediaAssetRelativePath = path.join('generated', 'draft', 'marketing-assets', 'meta-preview.png');
    const mediaAssetPath = path.join(dataRoot, mediaAssetRelativePath);
    await mkdir(path.dirname(runtimeFile), { recursive: true });
    await mkdir(path.dirname(mediaAssetPath), { recursive: true });
    await writeFile(mediaAssetPath, Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00]));
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
          research: { stage: 'research', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-r', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          strategy: { stage: 'strategy', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-s', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          production: { stage: 'production', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-p', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          publish: {
            stage: 'publish',
            status: 'awaiting_approval',
            started_at: null,
            completed_at: null,
            failed_at: null,
            run_id: 'run-publish',
            summary: null,
            primary_output: null,
            outputs: {
              review: {
                review_bundle: {
                  campaign_name: 'Sugar & Leather',
                  summary: {},
                  platform_previews: [
                    {
                      platform_slug: 'meta-ads',
                      platform_name: 'Meta Ads',
                      channel_type: 'paid-social',
                      summary: 'Preview ready',
                      media_paths: [mediaAssetRelativePath],
                      asset_paths: {},
                    },
                  ],
                },
              },
            },
            artifacts: [],
            errors: [],
          },
        },
        approvals: { current: null, history: [] },
        publish_config: { platforms: ['meta-ads'], live_publish_platforms: [], video_render_platforms: [] },
        brand_kit: {
          path: path.join(dataRoot, 'generated', 'validated', 'tenant_real', 'brand-kit.json'),
          source_url: 'https://sugarandleather.com',
          canonical_url: 'https://sugarandleather.com',
          brand_name: 'Sugar & Leather',
          logo_urls: [],
          colors: { primary: '#9c6b3e', secondary: '#f3e9dd', accent: '#3d2410', palette: ['#9c6b3e', '#f3e9dd', '#3d2410'] },
          font_families: ['Manrope'],
          external_links: [],
          extracted_at: '2026-03-18T00:00:00.000Z',
        },
        inputs: { request: {}, brand_url: 'https://sugarandleather.com' },
        errors: [],
        last_error: null,
        history: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, null, 2)
    );

    const response = await handleGetMarketingJobAsset(
      jobId,
      'platform-preview-meta-ads-media-1',
      async () => ({
        userId: 'user_123',
        tenantId: 'tenant_real',
        tenantSlug: 'acme',
        role: 'tenant_admin',
      })
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/jpeg');
  });
});

test('/api/marketing/jobs/:jobId/assets/:assetId allows runtime-derived absolute paths inside trusted roots', async () => {
  await withRuntimeEnv(async (dataRoot) => {
    const { handleGetMarketingJobAsset } = await import('../app/api/marketing/jobs/[jobId]/assets/[assetId]/handler');
    const jobId = 'mkt_asset_job_blocked';
    const runtimeFile = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs', `${jobId}.json`);
    const mediaAssetPath = path.join(dataRoot, 'meta-preview.png');
    await mkdir(path.dirname(runtimeFile), { recursive: true });
    await writeFile(mediaAssetPath, 'png-preview', 'utf8');
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
          research: { stage: 'research', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-r', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          strategy: { stage: 'strategy', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-s', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          production: { stage: 'production', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-p', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          publish: {
            stage: 'publish',
            status: 'awaiting_approval',
            started_at: null,
            completed_at: null,
            failed_at: null,
            run_id: 'run-publish',
            summary: null,
            primary_output: null,
            outputs: {
              review: {
                review_bundle: {
                  campaign_name: 'Sugar & Leather',
                  summary: {},
                  platform_previews: [
                    {
                      platform_slug: 'meta-ads',
                      platform_name: 'Meta Ads',
                      channel_type: 'paid-social',
                      summary: 'Preview ready',
                      media_paths: [mediaAssetPath],
                      asset_paths: {},
                    },
                  ],
                },
              },
            },
            artifacts: [],
            errors: [],
          },
        },
        approvals: { current: null, history: [] },
        publish_config: { platforms: ['meta-ads'], live_publish_platforms: [], video_render_platforms: [] },
        brand_kit: {
          path: path.join(dataRoot, 'generated', 'validated', 'tenant_real', 'brand-kit.json'),
          source_url: 'https://sugarandleather.com',
          canonical_url: 'https://sugarandleather.com',
          brand_name: 'Sugar & Leather',
          logo_urls: [],
          colors: { primary: '#9c6b3e', secondary: '#f3e9dd', accent: '#3d2410', palette: ['#9c6b3e', '#f3e9dd', '#3d2410'] },
          font_families: ['Manrope'],
          external_links: [],
          extracted_at: '2026-03-18T00:00:00.000Z',
        },
        inputs: { request: {}, brand_url: 'https://sugarandleather.com' },
        errors: [],
        last_error: null,
        history: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, null, 2)
    );

    const response = await handleGetMarketingJobAsset(
      jobId,
      'platform-preview-meta-ads-media-1',
      async () => ({
        userId: 'user_123',
        tenantId: 'tenant_real',
        tenantSlug: 'acme',
        role: 'tenant_admin',
      })
    );
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(body, 'png-preview');
  });
});

test('/api/marketing/jobs/:jobId/assets/:assetId supports legacy saved code paths with an extra /aries-app segment', async () => {
  await withRuntimeEnv(async () => {
    const { handleGetMarketingJobAsset } = await import('../app/api/marketing/jobs/[jobId]/assets/[assetId]/handler');
    const jobId = 'mkt_asset_job_legacy_path';
    const runtimeFile = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs', `${jobId}.json`);
    const actualAssetPath = path.join(process.env.CODE_ROOT!, 'lobster', 'output', 'publish-ready', 'brand-example-stage2-plan', 'meta-ads', 'meta-ads.png');
    const legacySavedPath = path.join(process.env.CODE_ROOT!, 'aries-app', 'lobster', 'output', 'publish-ready', 'brand-example-stage2-plan', 'meta-ads', 'meta-ads.png');
    await mkdir(path.dirname(runtimeFile), { recursive: true });
    await mkdir(path.dirname(actualAssetPath), { recursive: true });
    await writeFile(actualAssetPath, 'png-preview', 'utf8');
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
          research: { stage: 'research', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-r', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          strategy: { stage: 'strategy', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-s', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          production: { stage: 'production', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-p', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          publish: {
            stage: 'publish',
            status: 'awaiting_approval',
            started_at: null,
            completed_at: null,
            failed_at: null,
            run_id: 'run-publish',
            summary: null,
            primary_output: {
              launch_review: {
                review_bundle: {
                  campaign_name: 'Sugar & Leather',
                  summary: {},
                  platform_previews: [
                    {
                      platform_slug: 'meta-ads',
                      platform_name: 'Meta Ads',
                      channel_type: 'paid-social',
                      summary: 'Preview ready',
                      media_paths: [legacySavedPath],
                      asset_paths: {},
                    },
                  ],
                },
              },
            },
            outputs: {},
            artifacts: [],
            errors: [],
          },
        },
        approvals: { current: null, history: [] },
        publish_config: { platforms: ['meta-ads'], live_publish_platforms: [], video_render_platforms: [] },
        brand_kit: {
          path: path.join(process.env.DATA_ROOT!, 'generated', 'validated', 'tenant_real', 'brand-kit.json'),
          source_url: 'https://sugarandleather.com',
          canonical_url: 'https://sugarandleather.com',
          brand_name: 'Sugar & Leather',
          logo_urls: [],
          colors: { primary: '#9c6b3e', secondary: '#f3e9dd', accent: '#3d2410', palette: ['#9c6b3e', '#f3e9dd', '#3d2410'] },
          font_families: ['Manrope'],
          external_links: [],
          extracted_at: '2026-03-18T00:00:00.000Z',
        },
        inputs: { request: {}, brand_url: 'https://sugarandleather.com' },
        errors: [],
        last_error: null,
        history: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, null, 2)
    );

    const response = await handleGetMarketingJobAsset(
      jobId,
      'platform-preview-meta-ads-media-1',
      async () => ({
        userId: 'user_123',
        tenantId: 'tenant_real',
        tenantSlug: 'acme',
        role: 'tenant_admin',
      })
    );
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(body, 'png-preview');
  });
});

test('/api/marketing/jobs/:jobId/assets/:assetId rejects runtime-derived absolute paths outside trusted roots', async () => {
  await withRuntimeEnv(async () => {
    const { handleGetMarketingJobAsset } = await import('../app/api/marketing/jobs/[jobId]/assets/[assetId]/handler');
    const jobId = 'mkt_asset_job_outside_root';
    const runtimeFile = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs', `${jobId}.json`);
    const outsideRoot = await mkdtemp(path.join(tmpdir(), 'aries-asset-outside-'));
    const outsideFile = path.join(outsideRoot, 'outside-preview.png');
    await mkdir(path.dirname(runtimeFile), { recursive: true });
    await writeFile(outsideFile, 'png-preview', 'utf8');
    try {
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
            research: { stage: 'research', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-r', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
            strategy: { stage: 'strategy', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-s', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
            production: { stage: 'production', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-p', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
            publish: {
              stage: 'publish',
              status: 'awaiting_approval',
              started_at: null,
              completed_at: null,
              failed_at: null,
              run_id: 'run-publish',
              summary: null,
              primary_output: null,
              outputs: {
                review: {
                  review_bundle: {
                    campaign_name: 'Sugar & Leather',
                    summary: {},
                    platform_previews: [
                      {
                        platform_slug: 'meta-ads',
                        platform_name: 'Meta Ads',
                        channel_type: 'paid-social',
                        summary: 'Preview ready',
                        media_paths: [outsideFile],
                        asset_paths: {},
                      },
                    ],
                  },
                },
              },
              artifacts: [],
              errors: [],
            },
          },
          approvals: { current: null, history: [] },
          publish_config: { platforms: ['meta-ads'], live_publish_platforms: [], video_render_platforms: [] },
          brand_kit: {
            path: path.join(process.env.DATA_ROOT!, 'generated', 'validated', 'tenant_real', 'brand-kit.json'),
            source_url: 'https://sugarandleather.com',
            canonical_url: 'https://sugarandleather.com',
            brand_name: 'Sugar & Leather',
            logo_urls: [],
            colors: { primary: '#9c6b3e', secondary: '#f3e9dd', accent: '#3d2410', palette: ['#9c6b3e', '#f3e9dd', '#3d2410'] },
            font_families: ['Manrope'],
            external_links: [],
            extracted_at: '2026-03-18T00:00:00.000Z',
          },
          inputs: { request: {}, brand_url: 'https://sugarandleather.com' },
          errors: [],
          last_error: null,
          history: [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }, null, 2)
      );

      const response = await handleGetMarketingJobAsset(
        jobId,
        'platform-preview-meta-ads-media-1',
        async () => ({
          userId: 'user_123',
          tenantId: 'tenant_real',
          tenantSlug: 'acme',
          role: 'tenant_admin',
        })
      );
      const body = (await response.json()) as Record<string, unknown>;

      assert.equal(response.status, 404);
      assert.equal(body.reason, 'marketing_asset_not_found');
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
});

test('/api/marketing/jobs/:jobId/assets/:assetId rejects traversal-style runtime paths', async () => {
  await withRuntimeEnv(async (dataRoot) => {
    const { handleGetMarketingJobAsset } = await import('../app/api/marketing/jobs/[jobId]/assets/[assetId]/handler');
    const jobId = 'mkt_asset_job_traversal';
    const runtimeFile = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs', `${jobId}.json`);
    await mkdir(path.dirname(runtimeFile), { recursive: true });
    await writeFile(path.join(dataRoot, 'secret.txt'), 'secret', 'utf8');
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
          research: { stage: 'research', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-r', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          strategy: { stage: 'strategy', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-s', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          production: { stage: 'production', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-p', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          publish: {
            stage: 'publish',
            status: 'awaiting_approval',
            started_at: null,
            completed_at: null,
            failed_at: null,
            run_id: 'run-publish',
            summary: null,
            primary_output: null,
            outputs: {
              review: {
                review_bundle: {
                  campaign_name: 'Sugar & Leather',
                  summary: {},
                  platform_previews: [
                    {
                      platform_slug: 'meta-ads',
                      platform_name: 'Meta Ads',
                      channel_type: 'paid-social',
                      summary: 'Preview ready',
                      media_paths: ['..\\secret.txt'],
                      asset_paths: {},
                    },
                  ],
                },
              },
            },
            artifacts: [],
            errors: [],
          },
        },
        approvals: { current: null, history: [] },
        publish_config: { platforms: ['meta-ads'], live_publish_platforms: [], video_render_platforms: [] },
        brand_kit: {
          path: path.join(dataRoot, 'generated', 'validated', 'tenant_real', 'brand-kit.json'),
          source_url: 'https://sugarandleather.com',
          canonical_url: 'https://sugarandleather.com',
          brand_name: 'Sugar & Leather',
          logo_urls: [],
          colors: { primary: '#9c6b3e', secondary: '#f3e9dd', accent: '#3d2410', palette: ['#9c6b3e', '#f3e9dd', '#3d2410'] },
          font_families: ['Manrope'],
          external_links: [],
          extracted_at: '2026-03-18T00:00:00.000Z',
        },
        inputs: { request: {}, brand_url: 'https://sugarandleather.com' },
        errors: [],
        last_error: null,
        history: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, null, 2)
    );

    const response = await handleGetMarketingJobAsset(
      jobId,
      'platform-preview-meta-ads-media-1',
      async () => ({
        userId: 'user_123',
        tenantId: 'tenant_real',
        tenantSlug: 'acme',
        role: 'tenant_admin',
      })
    );
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 404);
    assert.equal(body.reason, 'marketing_asset_not_found');
  });
});

test('/api/marketing/jobs/:jobId/assets/:assetId rejects symlink escapes from allowed roots', async () => {
  await withRuntimeEnv(async (dataRoot) => {
    const { handleGetMarketingJobAsset } = await import('../app/api/marketing/jobs/[jobId]/assets/[assetId]/handler');
    const jobId = 'mkt_asset_job_symlink';
    const runtimeFile = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs', `${jobId}.json`);
    const outsideRoot = await mkdtemp(path.join(tmpdir(), 'aries-asset-outside-'));
    const outsideFile = path.join(outsideRoot, 'secret.txt');
    const symlinkRelativePath = path.join('generated', 'draft', 'marketing-assets', 'linked-secret.txt');
    const symlinkPath = path.join(dataRoot, symlinkRelativePath);
    await mkdir(path.dirname(runtimeFile), { recursive: true });
    await mkdir(path.dirname(symlinkPath), { recursive: true });
    await writeFile(outsideFile, 'secret', 'utf8');
    await symlink(outsideFile, symlinkPath);
    try {
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
            research: { stage: 'research', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-r', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
            strategy: { stage: 'strategy', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-s', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
            production: { stage: 'production', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-p', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
            publish: {
              stage: 'publish',
              status: 'awaiting_approval',
              started_at: null,
              completed_at: null,
              failed_at: null,
              run_id: 'run-publish',
              summary: null,
              primary_output: null,
              outputs: {
                review: {
                  review_bundle: {
                    campaign_name: 'Sugar & Leather',
                    summary: {},
                    platform_previews: [
                      {
                        platform_slug: 'meta-ads',
                        platform_name: 'Meta Ads',
                        channel_type: 'paid-social',
                        summary: 'Preview ready',
                        media_paths: [symlinkRelativePath],
                        asset_paths: {},
                      },
                    ],
                  },
                },
              },
              artifacts: [],
              errors: [],
            },
          },
          approvals: { current: null, history: [] },
          publish_config: { platforms: ['meta-ads'], live_publish_platforms: [], video_render_platforms: [] },
          brand_kit: {
            path: path.join(dataRoot, 'generated', 'validated', 'tenant_real', 'brand-kit.json'),
            source_url: 'https://sugarandleather.com',
            canonical_url: 'https://sugarandleather.com',
            brand_name: 'Sugar & Leather',
            logo_urls: [],
            colors: { primary: '#9c6b3e', secondary: '#f3e9dd', accent: '#3d2410', palette: ['#9c6b3e', '#f3e9dd', '#3d2410'] },
            font_families: ['Manrope'],
            external_links: [],
            extracted_at: '2026-03-18T00:00:00.000Z',
          },
          inputs: { request: {}, brand_url: 'https://sugarandleather.com' },
          errors: [],
          last_error: null,
          history: [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }, null, 2)
      );

      const response = await handleGetMarketingJobAsset(
        jobId,
        'platform-preview-meta-ads-media-1',
        async () => ({
          userId: 'user_123',
          tenantId: 'tenant_real',
          tenantSlug: 'acme',
          role: 'tenant_admin',
        })
      );
      const body = (await response.json()) as Record<string, unknown>;

      assert.equal(response.status, 404);
      assert.equal(body.reason, 'marketing_asset_not_found');
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
});

test('/api/marketing/jobs/:jobId/assets/:assetId skips tenant loading in public mode', async () => {
  await withRuntimeEnv(async (dataRoot) => {
    const { handleGetMarketingJobAsset } = await import('../app/api/marketing/jobs/[jobId]/assets/[assetId]/handler');
    const previousStatusPublic = process.env.MARKETING_STATUS_PUBLIC;
    const jobId = 'mkt_asset_job_public';
    const runtimeFile = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs', `${jobId}.json`);
    const mediaAssetRelativePath = path.join('generated', 'draft', 'marketing-assets', 'public-preview.png');
    const mediaAssetPath = path.join(dataRoot, mediaAssetRelativePath);
    let tenantLoaderCalls = 0;
    await mkdir(path.dirname(runtimeFile), { recursive: true });
    await mkdir(path.dirname(mediaAssetPath), { recursive: true });
    await writeFile(mediaAssetPath, 'png-preview', 'utf8');
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
          research: { stage: 'research', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-r', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          strategy: { stage: 'strategy', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-s', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          production: { stage: 'production', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-p', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          publish: {
            stage: 'publish',
            status: 'awaiting_approval',
            started_at: null,
            completed_at: null,
            failed_at: null,
            run_id: 'run-publish',
            summary: null,
            primary_output: null,
            outputs: {
              review: {
                review_bundle: {
                  campaign_name: 'Sugar & Leather',
                  summary: {},
                  platform_previews: [
                    {
                      platform_slug: 'meta-ads',
                      platform_name: 'Meta Ads',
                      channel_type: 'paid-social',
                      summary: 'Preview ready',
                      media_paths: [mediaAssetRelativePath],
                      asset_paths: {},
                    },
                  ],
                },
              },
            },
            artifacts: [],
            errors: [],
          },
        },
        approvals: { current: null, history: [] },
        publish_config: { platforms: ['meta-ads'], live_publish_platforms: [], video_render_platforms: [] },
        brand_kit: {
          path: path.join(dataRoot, 'generated', 'validated', 'tenant_real', 'brand-kit.json'),
          source_url: 'https://sugarandleather.com',
          canonical_url: 'https://sugarandleather.com',
          brand_name: 'Sugar & Leather',
          logo_urls: [],
          colors: { primary: '#9c6b3e', secondary: '#f3e9dd', accent: '#3d2410', palette: ['#9c6b3e', '#f3e9dd', '#3d2410'] },
          font_families: ['Manrope'],
          external_links: [],
          extracted_at: '2026-03-18T00:00:00.000Z',
        },
        inputs: { request: {}, brand_url: 'https://sugarandleather.com' },
        errors: [],
        last_error: null,
        history: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, null, 2)
    );

    process.env.MARKETING_STATUS_PUBLIC = '1';
    try {
      const response = await handleGetMarketingJobAsset(
        jobId,
        'platform-preview-meta-ads-media-1',
        async () => {
          tenantLoaderCalls += 1;
          return {
            userId: 'user_123',
            tenantId: 'tenant_real',
            tenantSlug: 'acme',
            role: 'tenant_admin',
          };
        }
      );
      const body = await response.text();

      assert.equal(response.status, 200);
      assert.equal(body, 'png-preview');
      assert.equal(tenantLoaderCalls, 0);
    } finally {
      if (previousStatusPublic === undefined) delete process.env.MARKETING_STATUS_PUBLIC;
      else process.env.MARKETING_STATUS_PUBLIC = previousStatusPublic;
    }
  });
});

test('/api/marketing/jobs/:jobId/approve resolves tenant context server-side and returns a product-safe payload', async () => {
  await withRuntimeEnv(async () => {
    const { handlePostMarketingJobs } = await import('../app/api/marketing/jobs/handler');
    const { handleApproveMarketingJob } = await import('../app/api/marketing/jobs/[jobId]/approve/handler');
    const capture = { value: null as Record<string, unknown> | null };
    const actionLog: string[] = [];
    installMarketingPipelineInvoker(capture, actionLog);
    const restoreFetch = installBrandExampleFetchMock();

    try {
      const created = await handlePostMarketingJobs(
        new Request('http://localhost/api/marketing/jobs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jobType: 'brand_campaign',
            payload: {
              brandUrl: 'https://brand.example',
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
      assert.deepEqual(actionLog, ['run', 'resume', 'resume', 'resume']);
      const lastArgs = (capture.value as { args?: Record<string, unknown> })?.args;
      assert.equal(lastArgs?.action, 'resume');
      assert.equal(lastArgs?.approve, true);
      assert.equal(String(lastArgs?.token), 'resume_publish');
      assert.equal(lastArgs?.cwd, process.env.OPENCLAW_LOBSTER_CWD);
    } finally {
      restoreFetch();
      clearOpenClawTestInvoker();
    }
});

test('/api/marketing/reviews/[reviewId] decodes encoded review ids before loading the review item', async () => {
  await withRuntimeEnv(async (dataRoot) => {
    const { handleGetMarketingReviewItem } = await import('../app/api/marketing/reviews/[reviewId]/route');
    const jobsRoot = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs');
    const jobId = 'mkt_review_encoded';
    const runtimeDoc = makeApprovalReviewRuntimeDoc({
      dataRoot,
      jobId,
      tenantId: 'tenant_review',
    }) as Record<string, any>;

    runtimeDoc.inputs.request = {
      websiteUrl: 'https://tenant_review.example.com',
      competitorUrl: 'https://betterup.com',
      businessName: 'Brand Example',
      businessType: 'B2B SaaS',
      goal: 'Book walkthroughs',
      offer: 'Proof-led launch audit',
      brandVoice: 'Grounded and direct',
      styleVibe: 'Minimal and editorial',
      notes: 'Lead with concrete proof points.',
    };
    runtimeDoc.stages.research.summary = {
      summary: 'Competitive research is complete.',
      highlight: 'Proof-led hooks are winning.',
    };
    runtimeDoc.stages.research.artifacts = [
      {
        id: 'research-summary',
        stage: 'research',
        title: 'Competitor research summary',
        category: 'analysis',
        status: 'completed',
        summary: 'BetterUp leans on proof-led executive outcomes.',
        details: [
          'Competitor: betterup.com',
          'Ads reviewed: 6',
          'Trust-building testimonials outperform abstract inspiration.',
        ],
        path: path.join(process.env.LOBSTER_STAGE1_CACHE_DIR!, 'run-research', 'ads_analyst_compile.json'),
        preview_path: null,
      },
    ];
    runtimeDoc.stages.research.primary_output = {
      run_id: 'run-research',
      executive_summary: {
        market_positioning: 'Competitive research is complete.',
        campaign_takeaway: 'Proof-led hooks are winning.',
      },
    };
    runtimeDoc.stages.strategy.outputs = {
      approval_id: 'mkta_review',
      workflow_step_id: 'approve_stage_2',
    };
    runtimeDoc.approvals.current = {
      ...runtimeDoc.approvals.current,
      approval_id: 'mkta_review',
      workflow_step_id: 'approve_stage_2',
      title: 'Strategy approval required',
      message: 'Stage 1 complete. Continue to Stage 2 and run head-of-marketing for the provided brand_url?',
      action_label: 'Review strategy',
    };
    runtimeDoc.brand_kit = {
      ...runtimeDoc.brand_kit,
      logo_urls: ['https://tenant_review.example.com/assets/logo-wordmark.png'],
      colors: {
        primary: '#9c6b3e',
        secondary: '#f3e9dd',
        accent: '#3d2410',
        palette: ['#9c6b3e', '#f3e9dd', '#3d2410'],
      },
      font_families: ['Manrope'],
    };

    await mkdir(jobsRoot, { recursive: true });
    await mkdir(path.join(process.env.LOBSTER_STAGE1_CACHE_DIR!, 'run-research'), { recursive: true });
    await mkdir(path.dirname(runtimeDoc.brand_kit.path as string), { recursive: true });
    await writeFile(
      path.join(process.env.LOBSTER_STAGE1_CACHE_DIR!, 'run-research', 'ads_analyst_compile.json'),
      JSON.stringify({
        competitor: 'betterup.com',
        inputs: {
          ads_seen: 6,
        },
        executive_summary: {
          market_positioning: 'BetterUp leans on proof-led executive outcomes.',
          campaign_takeaway: 'Proof-led hooks are winning.',
          creative_takeaway: 'Trust-building testimonials outperform abstract inspiration.',
        },
      }, null, 2),
    );
    await writeFile(
      runtimeDoc.brand_kit.path as string,
      JSON.stringify({
        brand_name: 'Brand Example',
        source_url: 'https://tenant_review.example.com',
        canonical_url: 'https://tenant_review.example.com',
        logo_urls: ['https://tenant_review.example.com/assets/logo-wordmark.png'],
        colors: {
          primary: '#9c6b3e',
          secondary: '#f3e9dd',
          accent: '#3d2410',
          palette: ['#9c6b3e', '#f3e9dd', '#3d2410'],
        },
        font_families: ['Manrope'],
      }, null, 2),
    );
    await writeFile(
      path.join(jobsRoot, `${jobId}.json`),
      JSON.stringify(runtimeDoc, null, 2),
    );

    const response = await handleGetMarketingReviewItem(
      `${jobId}%3A%3Aapproval`,
      async () => ({
        userId: 'user_1',
        tenantId: 'tenant_review',
        tenantSlug: 'tenant-review',
        role: 'tenant_admin',
      }),
    );
    const body = (await response.json()) as Record<string, unknown>;
    const review = body.review as {
      id: string;
      sections: Array<{
        title: string;
        body: string;
        brandKitVisuals?: {
          logos: string[];
          colors: Array<{ label: string; hex: string }>;
          fonts: Array<{ label: string; family: string; sampleText: string }>;
        };
      }>;
      attachments: Array<{ label: string }>;
    };
    const researchSummarySection = review.sections.find((section) => section.title === 'Research summary');
    const campaignBriefSection = review.sections.find((section) => section.title === 'Campaign brief');
    const extractedBrandKitSection = review.sections.find((section) => section.title === 'Extracted brand kit');

    assert.equal(response.status, 200);
    assert.equal(review.id, `${jobId}::approval`);
    assert.deepEqual(review.sections.map((section) => section.title), [
      'Research summary',
      'Campaign brief',
      'Extracted brand kit',
    ]);
    assert.equal(review.sections.some((section) => section.body.includes('Workflow checkpoint')), false);
    assert.equal(researchSummarySection?.body.includes('BetterUp leans on proof-led executive outcomes.'), true);
    assert.equal(researchSummarySection?.body.includes('Competitor: betterup.com'), true);
    assert.equal(researchSummarySection?.body.includes('Ads reviewed: 6'), true);
    assert.equal(campaignBriefSection?.body.includes('Website:'), false);
    assert.equal(extractedBrandKitSection?.brandKitVisuals?.logos.length, 1);
    assert.equal(extractedBrandKitSection?.brandKitVisuals?.colors.length, 3);
    assert.equal(extractedBrandKitSection?.brandKitVisuals?.fonts[0]?.family, 'Manrope');
    assert.equal(review.attachments.some((attachment) => attachment.label === 'Competitor research summary'), true);
    assert.equal(review.attachments.some((attachment) => attachment.label === 'Extracted brand kit'), true);
  });
});

test('/api/marketing/reviews/[reviewId]/decision decodes encoded review ids before saving the decision', async () => {
  await withRuntimeEnv(async (dataRoot) => {
    const { handlePostMarketingReviewDecision } = await import('../app/api/marketing/reviews/[reviewId]/decision/route');
    const jobsRoot = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs');
    const jobId = 'mkt_review_encoded_decision';
    installMarketingPipelineInvoker({ value: null });
    await mkdir(jobsRoot, { recursive: true });
    await writeFile(
      path.join(jobsRoot, `${jobId}.json`),
      JSON.stringify(makeApprovalReviewRuntimeDoc({
        dataRoot,
        jobId,
        tenantId: 'tenant_review',
        resumeToken: 'resume_strategy',
      }), null, 2),
    );

    const response = await handlePostMarketingReviewDecision(
      `${jobId}%3A%3Aapproval`,
      new Request('http://localhost/api/marketing/reviews/test/decision', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'approve',
          actedBy: 'operator',
          note: 'Looks good.',
        }),
      }),
      async () => ({
        userId: 'user_1',
        tenantId: 'tenant_review',
        tenantSlug: 'tenant-review',
        role: 'tenant_admin',
      }),
    );
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 200);
    assert.equal((body.review as { id: string; status: string }).id, `${jobId}::approval`);
    assert.equal((body.review as { id: string; status: string }).status, 'approved');
    clearOpenClawTestInvoker();
  });
});
});
