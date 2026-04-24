import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

function readRepoFile(relativePath: string) {
  return readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
}

function setOpenClawTestInvoker(
  impl: (payload: Record<string, unknown>) => unknown | Promise<unknown>,
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

async function withMarketingRuntimeEnv<T>(run: (dataRoot: string) => Promise<T>): Promise<T> {
  const previousCodeRoot = process.env.CODE_ROOT;
  const previousDataRoot = process.env.DATA_ROOT;
  const previousOpenClawLobsterCwd = process.env.OPENCLAW_LOBSTER_CWD;
  const previousStage1CacheDir = process.env.LOBSTER_STAGE1_CACHE_DIR;
  const previousStage2CacheDir = process.env.LOBSTER_STAGE2_CACHE_DIR;
  const previousStage3CacheDir = process.env.LOBSTER_STAGE3_CACHE_DIR;
  const previousStage4CacheDir = process.env.LOBSTER_STAGE4_CACHE_DIR;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-runtime-views-'));

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
    if (previousCodeRoot === undefined) delete process.env.CODE_ROOT;
    else process.env.CODE_ROOT = previousCodeRoot;
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    if (previousOpenClawLobsterCwd === undefined) delete process.env.OPENCLAW_LOBSTER_CWD;
    else process.env.OPENCLAW_LOBSTER_CWD = previousOpenClawLobsterCwd;
    if (previousStage1CacheDir === undefined) delete process.env.LOBSTER_STAGE1_CACHE_DIR;
    else process.env.LOBSTER_STAGE1_CACHE_DIR = previousStage1CacheDir;
    if (previousStage2CacheDir === undefined) delete process.env.LOBSTER_STAGE2_CACHE_DIR;
    else process.env.LOBSTER_STAGE2_CACHE_DIR = previousStage2CacheDir;
    if (previousStage3CacheDir === undefined) delete process.env.LOBSTER_STAGE3_CACHE_DIR;
    else process.env.LOBSTER_STAGE3_CACHE_DIR = previousStage3CacheDir;
    if (previousStage4CacheDir === undefined) delete process.env.LOBSTER_STAGE4_CACHE_DIR;
    else process.env.LOBSTER_STAGE4_CACHE_DIR = previousStage4CacheDir;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

function installMinimalMarketingInvoker(): void {
  setOpenClawTestInvoker((payload) => {
    const args = (payload.args as Record<string, unknown> | undefined) ?? {};
    const action = String(args.action || '');

    if (action === 'run') {
      return {
        ok: true,
        status: 'needs_approval',
        output: [
          {
            run_id: 'run-research',
            executive_summary: {
              market_positioning: 'Proof-led competitive research is complete.',
              campaign_takeaway: 'Outcome-first hooks are winning.',
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
    }

    throw new Error(`Unexpected action: ${action}`);
  });
}

function makeAwaitingPublishApprovalRuntimeDoc(input: {
  dataRoot: string;
  jobId: string;
  tenantId: string;
  launchPreviewPath: string;
  platformSlug?: string | null;
  platformPreviews?: Array<{
    platformSlug: string;
    platformName: string;
    channelType?: string;
  }>;
  renderedVideos?: Array<{
    platformSlug: string;
    familyId: string;
    title?: string;
    posterUrl?: string;
    url?: string;
  }>;
  updatedAt?: string;
}) {
  const updatedAt = input.updatedAt ?? '2026-03-20T00:10:00.000Z';
  const platformPreviews = input.platformPreviews
    ? input.platformPreviews.map((preview) => ({
        platform_slug: preview.platformSlug,
        platform_name: preview.platformName,
        channel_type: preview.channelType ?? 'paid-social',
        summary: `${preview.platformName} preview ready for launch.`,
        headline: 'April collection launch',
        caption_text: 'Meet the April collection.',
        cta: 'Shop the drop',
        media_paths: [],
      }))
    : input.platformSlug
      ? [
          {
            platform_slug: input.platformSlug,
            platform_name: 'Meta Ads',
            channel_type: 'paid-social',
            summary: 'Carousel preview ready for launch.',
            headline: 'April collection launch',
            caption_text: 'Meet the April collection.',
            cta: 'Shop the drop',
            media_paths: [],
          },
        ]
      : [];
  const renderedVideos = input.renderedVideos ?? [];

  return {
    schema_name: 'marketing_job_state_schema',
    schema_version: '1.0.0',
    job_id: input.jobId,
    job_type: 'brand_campaign',
    tenant_id: input.tenantId,
    state: 'approval_required',
    status: 'awaiting_approval',
    current_stage: 'publish',
    stage_order: ['research', 'strategy', 'production', 'publish'],
    stages: {
      research: { stage: 'research', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-r', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
      strategy: { stage: 'strategy', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-s', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
      production: {
        stage: 'production',
        status: 'completed',
        started_at: null,
        completed_at: null,
        failed_at: null,
        run_id: 'run-p',
        summary: null,
        primary_output: null,
        outputs: {},
        artifacts: renderedVideos.map((video) => ({
          id: `video-${video.platformSlug}-${video.familyId}`,
          stage: 'production',
          type: 'video',
          title: video.title ?? `${video.platformSlug} — ${video.familyId}`,
          category: 'video',
          status: 'completed',
          summary: `${video.platformSlug} render for ${video.familyId}.`,
          details: [],
          contentType: 'video/mp4',
          url: video.url ?? `/api/marketing/jobs/${input.jobId}/assets/video-${video.platformSlug}-${video.familyId}`,
          posterUrl: video.posterUrl ?? `/api/marketing/jobs/${input.jobId}/assets/video-${video.platformSlug}-${video.familyId}-poster`,
          platformSlug: video.platformSlug,
          familyId: video.familyId,
          durationSeconds: 15,
          aspectRatio: '9:16',
        })),
        errors: [],
      },
      publish: {
        stage: 'publish',
        status: 'awaiting_approval',
        started_at: null,
        completed_at: null,
        failed_at: null,
        run_id: 'run-publish',
        summary: { summary: 'Approval needed before publish-ready assets are generated.', highlight: null },
        primary_output: null,
        outputs: {
          review: {
            review_bundle: {
              campaign_name: 'April Launch',
              generated_at: updatedAt,
              approval_message: 'Approval needed before publish-ready assets are generated.',
              summary: {
                core_message: 'Launch the April collection with proof-led creative.',
              },
              platform_previews: platformPreviews,
            },
          },
        },
        artifacts: [{
          id: 'launch-review',
          stage: 'publish',
          title: 'Launch review package',
          category: 'approval',
          status: 'awaiting_approval',
          summary: 'Approval needed before publish-ready assets are generated.',
          details: ['Static contracts: 7'],
          preview_path: input.launchPreviewPath,
        }],
        errors: [],
      },
    },
    approvals: {
      current: {
        stage: 'publish',
        status: 'awaiting_approval',
        title: 'Launch approval required',
        message: 'Approval needed before publish-ready assets are generated.',
        requested_at: updatedAt,
        action_label: 'Approve launch',
        publish_config: {
          platforms: ['meta-ads'],
          live_publish_platforms: [],
          video_render_platforms: [],
        },
      },
      history: [],
    },
    publish_config: {
      platforms: ['meta-ads'],
      live_publish_platforms: [],
      video_render_platforms: [],
    },
    brand_kit: {
      path: path.join(input.dataRoot, 'generated', 'validated', input.tenantId, 'brand-kit.json'),
      source_url: `https://${input.tenantId}.example.com`,
      canonical_url: `https://${input.tenantId}.example.com`,
      brand_name: 'Brand Example',
      logo_urls: [],
      colors: { primary: '#123456', secondary: '#abcdef', accent: '#fedcba', palette: ['#123456', '#abcdef', '#fedcba'] },
      font_families: ['Manrope'],
      external_links: [],
      extracted_at: '2026-03-20T00:00:00.000Z',
    },
    inputs: { request: {}, brand_url: `https://${input.tenantId}.example.com` },
    errors: [],
    last_error: null,
    history: [],
    created_at: '2026-03-20T00:00:00.000Z',
    updated_at: updatedAt,
  };
}

test('production authenticated v1 surfaces do not import demo fixture data directly', () => {
  const files = [
    'components/redesign/layout/app-shell.tsx',
    'frontend/aries-v1/home-dashboard.tsx',
    'frontend/aries-v1/campaign-list.tsx',
    'frontend/aries-v1/campaign-workspace.tsx',
    'frontend/aries-v1/review-queue.tsx',
    'frontend/aries-v1/review-item.tsx',
    'frontend/aries-v1/calendar-screen.tsx',
    'frontend/aries-v1/results-screen.tsx',
    'frontend/aries-v1/settings-screen.tsx',
    'frontend/aries-v1/presenters/dashboard-home-presenter.tsx',
    'frontend/aries-v1/presenters/campaign-list-presenter.tsx',
    'frontend/aries-v1/presenters/results-presenter.tsx',
    'frontend/aries-v1/presenters/calendar-presenter.tsx',
    'frontend/aries-v1/presenters/settings-presenter.tsx',
    'frontend/aries-v1/view-models/dashboard-home.ts',
    'frontend/aries-v1/view-models/campaign-list.ts',
    'frontend/aries-v1/view-models/results.ts',
    'frontend/aries-v1/view-models/calendar.ts',
    'frontend/aries-v1/view-models/settings.ts',
  ];

  for (const file of files) {
    const source = readRepoFile(file);
    assert.doesNotMatch(source, /from ['"]\.\/data['"]/);
    assert.doesNotMatch(source, /from ['"]@\/frontend\/aries-v1\/data['"]/);
    assert.doesNotMatch(source, /ARIES_CAMPAIGNS|ARIES_REVIEW_ITEMS|ARIES_CHANNELS|ARIES_WORKSPACE/);
  }
});

test('authenticated app shell exposes a visible logout control and does not hardcode review badge counts', () => {
  const serverSource = readRepoFile('components/redesign/layout/app-shell.tsx');
  const clientSource = readRepoFile('components/redesign/layout/app-shell-client.tsx');

  assert.match(clientSource, /Logout/);
  assert.doesNotMatch(`${serverSource}\n${clientSource}`, /ARIES_REVIEW_ITEMS/);
});

test('runtime campaign and review view services exist and return honest empty states without demo data', async () => {
  await withMarketingRuntimeEnv(async () => {
    const views = await import('../backend/marketing/runtime-views');

    const campaigns = await views.listMarketingCampaignsForTenant('tenant_empty');
    const reviews = await views.listMarketingReviewItemsForTenant('tenant_empty');

    assert.deepEqual(campaigns, []);
    assert.deepEqual(reviews, []);
  });
});

test('runtime campaign views stay populated when proposal artifacts exist even without live schedule data', async () => {
  await withMarketingRuntimeEnv(async (dataRoot) => {
    const jobsRoot = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs');
    const jobId = 'proposal-backed-runtime-view';
    await mkdir(jobsRoot, { recursive: true });
    await mkdir(path.join(process.env.LOBSTER_STAGE2_CACHE_DIR!, 'plan-run'), { recursive: true });
    await writeFile(
      path.join(process.env.LOBSTER_STAGE2_CACHE_DIR!, 'plan-run', 'campaign_planner.json'),
      JSON.stringify({
        brand_slug: 'brand-example',
        campaign_plan: {
          campaign_name: 'brand-example-stage2-plan',
          objective: 'Drive demo requests from a proposal-backed launch.',
          core_message: 'Proof-first messaging keeps the dashboard truthful.',
          channel_plans: [
            { channel: 'meta', message: 'Meta launch concept', creative_bias: 'Outcome proof' },
          ],
        },
      }, null, 2)
    );
    await writeFile(
      path.join(jobsRoot, `${jobId}.json`),
      JSON.stringify({
        schema_name: 'marketing_job_state_schema',
        schema_version: '1.0.0',
        job_id: jobId,
        job_type: 'brand_campaign',
        tenant_id: 'tenant_runtime',
        state: 'running',
        status: 'running',
        current_stage: 'strategy',
        stage_order: ['research', 'strategy', 'production', 'publish'],
        stages: {
          research: { stage: 'research', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-r', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          strategy: { stage: 'strategy', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'plan-run', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          production: { stage: 'production', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          publish: { stage: 'publish', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
        },
        approvals: { current: null, history: [] },
        publish_config: { platforms: ['meta-ads'], live_publish_platforms: [], video_render_platforms: [] },
        brand_kit: {
          path: path.join(dataRoot, 'generated', 'validated', 'tenant_runtime', 'brand-kit.json'),
          source_url: 'https://brand.example',
          canonical_url: 'https://brand.example',
          brand_name: 'Brand Example',
          logo_urls: [],
          colors: { primary: '#123456', secondary: '#abcdef', accent: '#fedcba', palette: ['#123456', '#abcdef', '#fedcba'] },
          font_families: ['Manrope'],
          external_links: [],
          extracted_at: '2026-03-20T00:00:00.000Z',
        },
        inputs: { request: {}, brand_url: 'https://brand.example' },
        errors: [],
        last_error: null,
        history: [],
        created_at: '2026-03-20T00:00:00.000Z',
        updated_at: '2026-03-20T00:10:00.000Z',
      }, null, 2)
    );

    const views = await import('../backend/marketing/runtime-views');
    const campaigns = await views.listMarketingCampaignsForTenant('tenant_runtime');

    assert.equal(campaigns.length, 1);
    assert.equal(campaigns[0].dashboard.posts.length > 0, true);
    assert.notEqual(campaigns[0].nextScheduled, 'Nothing scheduled yet');
  });
});

test('tenant runtime views keep only the latest rerun for the same campaign identity', async () => {
  await withMarketingRuntimeEnv(async () => {
    const jobsRoot = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs');
    await mkdir(jobsRoot, { recursive: true });

    for (const runId of ['plan-run-old', 'plan-run-new']) {
      await mkdir(path.join(process.env.LOBSTER_STAGE2_CACHE_DIR!, runId), { recursive: true });
      await writeFile(
        path.join(process.env.LOBSTER_STAGE2_CACHE_DIR!, runId, 'campaign_planner.json'),
        JSON.stringify({
          brand_slug: 'brand-example',
          campaign_plan: {
            campaign_name: 'brand-example-stage2-plan',
            objective: 'Drive demo requests from a proposal-backed launch.',
            core_message: 'Proof-first messaging keeps the dashboard truthful.',
            channel_plans: [
              { channel: 'meta', message: 'Meta launch concept', creative_bias: 'Outcome proof' },
            ],
          },
        }, null, 2),
      );
    }

    const runtimeDoc = (jobId: string, runId: string, updatedAt: string) => ({
      schema_name: 'marketing_job_state_schema',
      schema_version: '1.0.0',
      job_id: jobId,
      job_type: 'brand_campaign',
      tenant_id: 'tenant_runtime_dedupe',
      state: 'running',
      status: 'running',
      current_stage: 'strategy',
      stage_order: ['research', 'strategy', 'production', 'publish'],
      stages: {
        research: { stage: 'research', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-r', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
        strategy: { stage: 'strategy', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: runId, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
        production: { stage: 'production', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
        publish: { stage: 'publish', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
      },
      approvals: { current: null, history: [] },
      publish_config: { platforms: ['meta-ads'], live_publish_platforms: [], video_render_platforms: [] },
      brand_kit: {
        path: path.join(process.env.DATA_ROOT!, 'generated', 'validated', 'tenant_runtime_dedupe', 'brand-kit.json'),
        source_url: 'https://brand.example',
        canonical_url: 'https://brand.example',
        brand_name: 'Brand Example',
        logo_urls: [],
        colors: { primary: '#123456', secondary: '#abcdef', accent: '#fedcba', palette: ['#123456', '#abcdef', '#fedcba'] },
        font_families: ['Manrope'],
        external_links: [],
        extracted_at: '2026-03-20T00:00:00.000Z',
      },
      inputs: { request: {}, brand_url: 'https://brand.example' },
      errors: [],
      last_error: null,
      history: [],
      created_at: '2026-03-20T00:00:00.000Z',
      updated_at: updatedAt,
    });

    await writeFile(
      path.join(jobsRoot, 'proposal-backed-runtime-view-old.json'),
      JSON.stringify(runtimeDoc('proposal-backed-runtime-view-old', 'plan-run-old', '2026-03-20T00:10:00.000Z'), null, 2),
    );
    await writeFile(
      path.join(jobsRoot, 'proposal-backed-runtime-view-new.json'),
      JSON.stringify(runtimeDoc('proposal-backed-runtime-view-new', 'plan-run-new', '2026-03-21T00:10:00.000Z'), null, 2),
    );

    const views = await import('../backend/marketing/runtime-views');
    const campaigns = await views.listMarketingCampaignsForTenant('tenant_runtime_dedupe');
    const posts = await views.listMarketingPostsForTenant('tenant_runtime_dedupe');

    assert.equal(campaigns.length, 1);
    assert.equal(campaigns[0].jobId, 'proposal-backed-runtime-view-new');
    assert.equal(posts.campaigns.length, 1);
    assert.equal(posts.posts.length, 1);
  });
});

test('runtime views ignore malformed legacy marketing runtime documents without crashing', async () => {
  await withMarketingRuntimeEnv(async () => {
    const jobsRoot = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs');
    await mkdir(jobsRoot, { recursive: true });
    await writeFile(
      path.join(jobsRoot, 'legacy-bad.json'),
      JSON.stringify({
        schema_name: 'job_runtime_state_schema',
        schema_version: '1.0.0',
        job_id: 'legacy-bad',
        job_type: 'brand_campaign',
        tenant_id: 'tenant_empty',
        state: 'approval_required',
        status: 'awaiting_approval',
        attempt: 1,
        max_attempts: 3,
        inputs: { request: {} },
        updated_at: new Date().toISOString(),
      }, null, 2)
    );

    const views = await import('../backend/marketing/runtime-views');
    const campaigns = await views.listMarketingCampaignsForTenant('tenant_empty');
    const reviews = await views.listMarketingReviewItemsForTenant('tenant_empty');

    assert.deepEqual(campaigns, []);
    assert.deepEqual(reviews, []);
  });
});

test('review decisions persist and can be reloaded from runtime-backed state', async () => {
  await withMarketingRuntimeEnv(async () => {
    installMinimalMarketingInvoker();
    const restoreFetch = installBrandExampleFetchMock();
    const { startMarketingJob } = await import('../backend/marketing/orchestrator');
    const views = await import('../backend/marketing/runtime-views');

    try {
      const started = await startMarketingJob({
        tenantId: 'tenant_123',
        jobType: 'brand_campaign',
          payload: {
            brandUrl: 'https://brand.example',
            competitorUrl: 'https://betterup.com',
          },
      });

      const reviewsBefore = await views.listMarketingReviewItemsForTenant('tenant_123');
      assert.equal(reviewsBefore.length > 0, true);

      const firstReview = reviewsBefore[0];
      await views.recordMarketingReviewDecision({
        tenantId: 'tenant_123',
        reviewId: firstReview.id,
        action: 'changes_requested',
        actedBy: 'Morgan',
        note: 'Tighten the headline before launch.',
      });

      const persisted = await views.getMarketingReviewItemForTenant('tenant_123', firstReview.id);
      assert.equal(persisted?.status, 'changes_requested');
      assert.equal(persisted?.lastDecision?.actedBy, 'Morgan');
      assert.equal(persisted?.lastDecision?.note, 'Tighten the headline before launch.');

      const runtimePath = path.join(
        process.env.DATA_ROOT!,
        'generated',
        'draft',
        'marketing-reviews',
        `${started.jobId}.json`,
      );
      const saved = JSON.parse(await readFile(runtimePath, 'utf8')) as Record<string, unknown>;
      assert.equal(typeof saved, 'object');
    } finally {
      restoreFetch();
      clearOpenClawTestInvoker();
    }
  });
});

test('approving a workflow approval review item resumes the marketing job', async () => {
  await withMarketingRuntimeEnv(async () => {
    installMinimalMarketingInvoker();
    const restoreFetch = installBrandExampleFetchMock();
    const { startMarketingJob } = await import('../backend/marketing/orchestrator');
    const { loadMarketingJobRuntime } = await import('../backend/marketing/runtime-state');
    const views = await import('../backend/marketing/runtime-views');

    try {
      const started = await startMarketingJob({
        tenantId: 'tenant_123',
        jobType: 'brand_campaign',
          payload: {
            brandUrl: 'https://brand.example',
            competitorUrl: 'https://betterup.com',
          },
      });

      const reviewsBefore = await views.listMarketingReviewItemsForTenant('tenant_123');
      const approvalItem = reviewsBefore.find((item) => item.id === `${started.jobId}::approval`);

      assert.equal(!!approvalItem, true);

      const approved = await views.recordMarketingReviewDecision({
        tenantId: 'tenant_123',
        reviewId: approvalItem!.id,
        action: 'approve',
        actedBy: 'Morgan',
        note: 'Move to the next stage.',
      });

      assert.equal(approved?.status, 'approved');
      assert.equal(approved?.lastDecision?.actedBy, 'Morgan');

      const runtimeDoc = await loadMarketingJobRuntime(started.jobId);
      assert.equal(runtimeDoc?.current_stage, 'production');
      assert.equal(runtimeDoc?.approvals.current?.stage, 'production');
    } finally {
      restoreFetch();
      clearOpenClawTestInvoker();
    }
  });
});

test('approve_stage_2 workflow reviews include research, brief, brand-kit, and uploaded brand assets', async () => {
  await withMarketingRuntimeEnv(async (dataRoot) => {
    installMinimalMarketingInvoker();
    const restoreFetch = installBrandExampleFetchMock();
    const { startMarketingJob } = await import('../backend/marketing/orchestrator');
    const views = await import('../backend/marketing/runtime-views');
    const { ensureCampaignWorkspaceRecord, saveCampaignWorkspaceRecord } = await import('../backend/marketing/workspace-store');

    try {
      const payload = {
        brandUrl: 'https://brand.example',
        competitorUrl: 'https://betterup.com',
        businessName: 'Brand Example',
        businessType: 'B2B SaaS',
        primaryGoal: 'Book walkthroughs',
        offer: 'Proof-led launch audit',
        brandVoice: 'Grounded and direct',
        styleVibe: 'Minimal and editorial',
        channels: ['meta-ads'],
        visualReferences: ['https://example.com/reference'],
        mustUseCopy: 'Book a walkthrough',
        mustAvoidAesthetics: 'Generic stock imagery',
        notes: 'Lead with proof points from recent launches.',
      };
      const started = await startMarketingJob({
        tenantId: 'tenant_123',
        jobType: 'brand_campaign',
        payload,
      });

      const record = await ensureCampaignWorkspaceRecord({
        jobId: started.jobId,
        tenantId: 'tenant_123',
        payload,
      });

      const uploadPath = path.join(dataRoot, 'brand-moodboard.pdf');
      await writeFile(uploadPath, 'brand moodboard', 'utf8');
      record.brief.brandAssets.push({
        id: 'brand-asset-1',
        name: 'Brand moodboard',
        fileName: 'brand-moodboard.pdf',
        contentType: 'application/pdf',
        filePath: uploadPath,
        size: 15,
        uploadedAt: '2026-04-04T00:00:00.000Z',
      });
      saveCampaignWorkspaceRecord(record);

      const reviews = await views.listMarketingReviewItemsForTenant('tenant_123');
      const approvalItem = reviews.find((item) => item.id === `${started.jobId}::approval`);
      const campaigns = await views.listMarketingCampaignsForTenant('tenant_123');
      const extractedBrandKitSection = approvalItem?.sections.find((section) => section.id === 'extracted-brand-kit');

      assert.equal(approvalItem?.reviewType, 'workflow_approval');
      assert.equal(approvalItem?.title, 'Research complete');
      assert.equal(approvalItem?.summary.includes('Brand analysis is ready next'), true);
      assert.equal(approvalItem?.channel, 'Research');
      assert.equal(approvalItem?.placement, 'Brand analysis next');
      assert.deepEqual(
        approvalItem?.sections.map((section) => section.title),
        ['Research summary', 'Campaign brief', 'Extracted brand kit', 'Uploaded brand assets'],
      );
      assert.equal(approvalItem?.sections.some((section) => section.title === 'Workflow checkpoint'), false);
      assert.equal(extractedBrandKitSection?.brandKitVisuals?.logos.length, 1);
      assert.equal(extractedBrandKitSection?.brandKitVisuals?.colors.length, 3);
      assert.equal(extractedBrandKitSection?.brandKitVisuals?.fonts.some((font) => font.family === 'Manrope'), true);
      assert.equal(approvalItem?.attachments.some((attachment) => attachment.label === 'Extracted brand kit'), true);
      assert.equal(approvalItem?.attachments.some((attachment) => attachment.label === 'Brand moodboard'), true);
      assert.equal(approvalItem?.attachments.every((attachment) => attachment.label.trim().length > 0 && attachment.url.trim().length > 0), true);
      assert.equal(approvalItem?.currentVersion.cta, 'Continue to brand analysis');
      assert.equal(campaigns[0]?.approvalActionHref, `/review/${encodeURIComponent(`${started.jobId}::approval`)}`);
    } finally {
      restoreFetch();
      clearOpenClawTestInvoker();
    }
  });
});

test('stale workflow approval ids do not advance a newer approval checkpoint', async () => {
  await withMarketingRuntimeEnv(async () => {
    installMinimalMarketingInvoker();
    const restoreFetch = installBrandExampleFetchMock();
    const { startMarketingJob } = await import('../backend/marketing/orchestrator');
    const { loadMarketingJobRuntime } = await import('../backend/marketing/runtime-state');
    const views = await import('../backend/marketing/runtime-views');

    try {
      const started = await startMarketingJob({
        tenantId: 'tenant_123',
        jobType: 'brand_campaign',
          payload: {
            brandUrl: 'https://brand.example',
            competitorUrl: 'https://betterup.com',
          },
      });

      const reviewsBefore = await views.listMarketingReviewItemsForTenant('tenant_123');
      const approvalItem = reviewsBefore.find((item) => item.id === `${started.jobId}::approval`);
      const staleApprovalId = approvalItem?.currentVersion.id.startsWith('approval:')
        ? approvalItem.currentVersion.id.slice('approval:'.length)
        : undefined;

      assert.equal(!!staleApprovalId, true);

      await views.recordMarketingReviewDecision({
        tenantId: 'tenant_123',
        reviewId: approvalItem!.id,
        action: 'approve',
        actedBy: 'Morgan',
        note: 'Move to the next stage.',
        approvalId: staleApprovalId,
      });

      let runtimeDoc = await loadMarketingJobRuntime(started.jobId);
      assert.equal(runtimeDoc?.current_stage, 'production');
      assert.equal(runtimeDoc?.approvals.current?.stage, 'production');

      await views.recordMarketingReviewDecision({
        tenantId: 'tenant_123',
        reviewId: approvalItem!.id,
        action: 'approve',
        actedBy: 'Morgan',
        note: 'A duplicate stale click should not advance the next approval.',
        approvalId: staleApprovalId,
      });

      runtimeDoc = await loadMarketingJobRuntime(started.jobId);
      assert.equal(runtimeDoc?.current_stage, 'production');
      assert.equal(runtimeDoc?.approvals.current?.stage, 'production');
    } finally {
      restoreFetch();
      clearOpenClawTestInvoker();
    }
  });
});

test('review decisions still resolve after the runtime preview id changes between list and approval', async () => {
  await withMarketingRuntimeEnv(async (dataRoot) => {
    const jobsRoot = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs');
    const jobId = 'review-id-churn';
    const runtimeFile = path.join(jobsRoot, `${jobId}.json`);
    const launchPreviewPath = path.join(dataRoot, 'launch-review-preview.txt');
    await mkdir(jobsRoot, { recursive: true });
    await writeFile(launchPreviewPath, 'Launch review packet', 'utf8');
    await writeFile(
      runtimeFile,
      JSON.stringify(makeAwaitingPublishApprovalRuntimeDoc({
        dataRoot,
        jobId,
        tenantId: 'tenant_review',
        launchPreviewPath,
        platformSlug: 'meta-ads',
      }), null, 2),
    );

    const views = await import('../backend/marketing/runtime-views');
    const reviewsBefore = await views.listMarketingReviewItemsForTenant('tenant_review');
    const previewReview = reviewsBefore.find((item) => item.currentVersion.id !== 'approval');

    assert.equal(!!previewReview, true);

    await writeFile(
      runtimeFile,
      JSON.stringify(makeAwaitingPublishApprovalRuntimeDoc({
        dataRoot,
        jobId,
        tenantId: 'tenant_review',
        launchPreviewPath,
        platformSlug: 'meta',
        updatedAt: '2026-03-20T00:12:00.000Z',
      }), null, 2),
    );

    const decided = await views.recordMarketingReviewDecision({
      tenantId: 'tenant_review',
      reviewId: previewReview!.id,
      action: 'approve',
      actedBy: 'Morgan',
      note: 'Ready to move forward.',
    });

    assert.equal(decided?.status, 'approved');
    assert.equal(decided?.lastDecision?.note, 'Ready to move forward.');

    const persisted = await views.getMarketingReviewItemForTenant('tenant_review', previewReview!.id);
    assert.equal(persisted?.status, 'approved');
    assert.equal(persisted?.lastDecision?.actedBy, 'Morgan');
  });
});

test('publish review previews stop counting as pending once the workflow checkpoint is approved', async () => {
  await withMarketingRuntimeEnv(async (dataRoot) => {
    const jobsRoot = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs');
    const reviewStateRoot = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-reviews');
    const jobId = 'review-approved-runtime';
    const runtimeFile = path.join(jobsRoot, `${jobId}.json`);
    const reviewStateFile = path.join(reviewStateRoot, `${jobId}.json`);
    const launchPreviewPath = path.join(dataRoot, 'launch-review-preview.txt');
    await mkdir(jobsRoot, { recursive: true });
    await mkdir(reviewStateRoot, { recursive: true });
    await writeFile(launchPreviewPath, 'Launch review packet', 'utf8');

    const awaitingApproval = makeAwaitingPublishApprovalRuntimeDoc({
      dataRoot,
      jobId,
      tenantId: 'tenant_review',
      launchPreviewPath,
      platformSlug: 'meta-ads',
    });

    await writeFile(runtimeFile, JSON.stringify(awaitingApproval, null, 2));

    const views = await import('../backend/marketing/runtime-views');
    const reviewsBefore = await views.listMarketingReviewItemsForTenant('tenant_review');
    assert.equal(reviewsBefore.length > 0, true);
    const previewReview = reviewsBefore.find((item) => item.currentVersion.id !== 'approval');
    assert.equal(!!previewReview, true);

    const resolvedRuntime = {
      ...awaitingApproval,
      state: 'completed',
      status: 'completed',
      stages: {
        ...awaitingApproval.stages,
        publish: {
          ...awaitingApproval.stages.publish,
          status: 'completed',
          completed_at: '2026-03-20T00:20:00.000Z',
        },
      },
      approvals: {
        current: null,
        history: [
          {
            stage: 'publish',
            status: 'approved',
            at: '2026-03-20T00:20:00.000Z',
            approval_id: 'mkta_publish',
            workflow_step_id: 'approve_stage_4_publish',
            approved_by: 'Morgan',
            message: 'Launch approval completed.',
          },
        ],
      },
      updated_at: '2026-03-20T00:20:00.000Z',
    };

    await writeFile(runtimeFile, JSON.stringify(resolvedRuntime, null, 2));

    const reviewsAfter = await views.listMarketingReviewItemsForTenant('tenant_review');
    assert.equal(reviewsAfter.some((item) => item.id === `${jobId}::approval`), false);

    const campaigns = await views.listMarketingCampaignsForTenant('tenant_review');
    assert.equal(campaigns.length, 1);

    const savedReviewState = JSON.parse(await readFile(reviewStateFile, 'utf8')) as {
      items: Record<string, { status: string }>;
    };
    assert.equal(typeof savedReviewState.items, 'object');
  });
});

test('publish approvals still surface a workflow review item when the bundle has no platform previews', async () => {
  await withMarketingRuntimeEnv(async (dataRoot) => {
    const jobsRoot = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs');
    const jobId = 'review-approval-fallback';
    const runtimeFile = path.join(jobsRoot, `${jobId}.json`);
    const launchPreviewPath = path.join(dataRoot, 'launch-review-preview.txt');
    await mkdir(jobsRoot, { recursive: true });
    await writeFile(launchPreviewPath, 'Launch review packet', 'utf8');
    await writeFile(
      runtimeFile,
      JSON.stringify(makeAwaitingPublishApprovalRuntimeDoc({
        dataRoot,
        jobId,
        tenantId: 'tenant_review',
        launchPreviewPath,
        platformSlug: null,
      }), null, 2),
    );

    const views = await import('../backend/marketing/runtime-views');
    const { loadCampaignWorkspaceRecord } = await import('../backend/marketing/workspace-store');
    const reviews = await views.listMarketingReviewItemsForTenant('tenant_review');

    assert.equal(reviews.some((item) => item.id === `${jobId}::approval`), true);

    const decided = await views.recordMarketingReviewDecision({
      tenantId: 'tenant_review',
      reviewId: `${jobId}::approval`,
      action: 'changes_requested',
      actedBy: 'Morgan',
      note: 'Workflow is clear to continue.',
    });

    assert.equal(decided?.status, 'changes_requested');
    assert.equal(decided?.lastDecision?.note, 'Workflow is clear to continue.');

    const updatedReviews = await views.listMarketingReviewItemsForTenant('tenant_review');
    const workflowReview = updatedReviews.find((item) => item.id === `${jobId}::approval`);
    const campaigns = await views.listMarketingCampaignsForTenant('tenant_review');
    const workspace = loadCampaignWorkspaceRecord(jobId, 'tenant_review');

    assert.equal(workflowReview?.workflowState, 'revisions_requested');
    assert.equal(workflowReview?.currentVersion.cta, 'Resolve revisions');
    assert.equal(campaigns.length, 1);
    assert.equal(campaigns[0].approvalActionHref, undefined);
    assert.equal(workspace?.workflow_state, 'revisions_requested');
    assert.equal(workspace?.stage_reviews.creative.status, 'changes_requested');
  });
});

test('publish-preview review items attach rendered mp4 previews for video platforms', async () => {
  await withMarketingRuntimeEnv(async (dataRoot) => {
    const jobsRoot = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs');
    const jobId = 'publish-preview-video-attachments';
    const runtimeFile = path.join(jobsRoot, `${jobId}.json`);
    const launchPreviewPath = path.join(dataRoot, 'launch-review-preview.txt');
    await mkdir(jobsRoot, { recursive: true });
    await writeFile(launchPreviewPath, 'Launch review packet', 'utf8');
    await writeFile(
      runtimeFile,
      JSON.stringify(makeAwaitingPublishApprovalRuntimeDoc({
        dataRoot,
        jobId,
        tenantId: 'tenant_review',
        launchPreviewPath,
        platformPreviews: [
          { platformSlug: 'tiktok', platformName: 'TikTok', channelType: 'video' },
          { platformSlug: 'youtube', platformName: 'YouTube', channelType: 'video' },
        ],
        renderedVideos: [
          { platformSlug: 'tiktok', familyId: 'portrait', title: 'TikTok — Portrait' },
          { platformSlug: 'youtube', familyId: 'shorts', title: 'YouTube — Shorts' },
        ],
      }), null, 2),
    );

    const views = await import('../backend/marketing/runtime-views');
    const reviews = await views.listMarketingReviewItemsForTenant('tenant_review');
    const publishPreviewReviews = reviews.filter((item) => item.id.startsWith(`${jobId}::publish-preview:`));

    assert.equal(publishPreviewReviews.length, 2);

    for (const [platformSlug, familyId] of [['tiktok', 'portrait'], ['youtube', 'shorts']] as const) {
      const review = publishPreviewReviews.find((item) => item.id === `${jobId}::publish-preview:${platformSlug}`);
      assert.ok(review, `expected publish preview review for ${platformSlug}`);

      const videoAttachment = review.attachments.find((attachment) => attachment.contentType === 'video/mp4');
      assert.ok(videoAttachment, `expected video attachment for ${platformSlug}`);
      assert.equal(videoAttachment?.id, `video-${platformSlug}-${familyId}`);
      assert.equal(videoAttachment?.kind, 'preview');
      assert.equal(videoAttachment?.posterUrl, `/api/marketing/jobs/${jobId}/assets/video-${platformSlug}-${familyId}-poster`);
    }
  });
});
