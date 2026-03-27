import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

type DashboardEnv = {
  dataRoot: string;
  lobsterRoot: string;
};

async function withDashboardEnv<T>(run: (env: DashboardEnv) => Promise<T>): Promise<T> {
  const previousCodeRoot = process.env.CODE_ROOT;
  const previousDataRoot = process.env.DATA_ROOT;
  const previousLocalLobsterCwd = process.env.OPENCLAW_LOCAL_LOBSTER_CWD;
  const previousOpenClawLobsterCwd = process.env.OPENCLAW_LOBSTER_CWD;
  const previousStage1CacheDir = process.env.LOBSTER_STAGE1_CACHE_DIR;
  const previousStage2CacheDir = process.env.LOBSTER_STAGE2_CACHE_DIR;
  const previousStage3CacheDir = process.env.LOBSTER_STAGE3_CACHE_DIR;
  const previousStage4CacheDir = process.env.LOBSTER_STAGE4_CACHE_DIR;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-dashboard-adapter-'));
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
    return await run({ dataRoot, lobsterRoot });
  } finally {
    if (previousCodeRoot === undefined) delete process.env.CODE_ROOT;
    else process.env.CODE_ROOT = previousCodeRoot;
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    if (previousLocalLobsterCwd === undefined) delete process.env.OPENCLAW_LOCAL_LOBSTER_CWD;
    else process.env.OPENCLAW_LOCAL_LOBSTER_CWD = previousLocalLobsterCwd;
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

async function writeJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

async function writeText(filePath: string, value: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, value, 'utf8');
}

function stageRecord(stage: 'research' | 'strategy' | 'production' | 'publish', status: string, runId: string | null) {
  return {
    stage,
    status,
    started_at: '2026-03-20T00:00:00.000Z',
    completed_at: status === 'completed' ? '2026-03-20T00:05:00.000Z' : null,
    failed_at: null,
    run_id: runId,
    summary: null,
    primary_output: null,
    outputs: {},
    artifacts: [],
    errors: [],
  };
}

function baseRuntimeDoc(jobId: string, tenantId: string) {
  return {
    schema_name: 'marketing_job_state_schema',
    schema_version: '1.0.0',
    job_id: jobId,
    job_type: 'brand_campaign',
    tenant_id: tenantId,
    state: 'running',
    status: 'running',
    current_stage: 'strategy',
    stage_order: ['research', 'strategy', 'production', 'publish'],
    stages: {
      research: stageRecord('research', 'completed', 'run-research'),
      strategy: stageRecord('strategy', 'completed', 'plan-run'),
      production: stageRecord('production', 'not_started', null),
      publish: stageRecord('publish', 'not_started', null),
    },
    approvals: {
      current: null,
      history: [],
    },
    publish_config: {
      platforms: ['meta-ads', 'tiktok'],
      live_publish_platforms: ['meta-ads'],
      video_render_platforms: ['tiktok'],
    },
    brand_kit: {
      path: path.join(process.env.DATA_ROOT!, 'generated', 'validated', tenantId, 'brand-kit.json'),
      source_url: 'https://brand.example',
      canonical_url: 'https://brand.example',
      brand_name: 'Brand Example',
      logo_urls: [],
      colors: {
        primary: '#123456',
        secondary: '#abcdef',
        accent: '#fedcba',
        palette: ['#123456', '#abcdef', '#fedcba'],
      },
      font_families: ['Manrope'],
      external_links: [],
      extracted_at: '2026-03-19T00:00:00.000Z',
    },
    inputs: {
      request: {},
      brand_url: 'https://brand.example',
    },
    errors: [],
    last_error: null,
    history: [],
    created_at: '2026-03-20T00:00:00.000Z',
    updated_at: '2026-03-20T00:10:00.000Z',
  };
}

async function seedPlanner(runId: string) {
  await writeJson(path.join(process.env.LOBSTER_STAGE2_CACHE_DIR!, runId, 'campaign_planner.json'), {
    brand_slug: 'brand-example',
    brand_profiles_record: {
      brand_slug: 'brand-example',
      created_at: '2026-03-20T00:00:00.000Z',
    },
    campaign_plan: {
      campaign_name: 'brand-example-stage2-plan',
      objective: 'Drive demo requests from a proof-first launch.',
      core_message: 'Proof-first messaging should make the launch feel lower risk.',
      primary_cta: 'Book Demo',
      offer: 'Free strategy call',
      audience: 'Mid-funnel buyers',
      channel_plans: [
        {
          channel: 'meta',
          message: 'Proof-first Meta concept',
          creative_bias: 'Outcome proof with a direct CTA',
        },
        {
          channel: 'landing-page',
          goal: 'Message-match landing page',
          creative_bias: 'Tight message match and low-friction CTA',
        },
      ],
    },
  });
}

async function seedCreativeArtifacts(env: DashboardEnv) {
  await writeText(path.join(env.lobsterRoot, 'output', 'brand-example-campaign', 'landing-pages', 'index.html'), '<html><body>Landing page</body></html>');
  await writeText(path.join(env.lobsterRoot, 'output', 'brand-example-campaign', 'ad-images', 'meta-feed.png'), 'png-preview');
  await writeText(path.join(env.lobsterRoot, 'output', 'brand-example-campaign', 'scripts', 'meta-ad-script.md'), '# Meta Script\n\nProof-first launch copy.');
  await writeJson(path.join(env.lobsterRoot, 'output', 'static-contracts', 'brand-example-stage2-plan', 'meta-ads.json'), {
    campaign_id: 'brand-example-stage2-plan',
    concept_id: 'proof-first-meta-concept',
    platform: 'Meta Ads',
    platform_slug: 'meta-ads',
    creative: {
      headline: 'Proof-first Meta concept',
      body_lines: ['Proof line', 'CTA line'],
      primary_cta: 'Book Demo',
    },
    landing_page: {
      slug: '/launch',
      hero_subheadline: 'See the proof before you commit.',
    },
  });
  await writeJson(path.join(env.lobsterRoot, 'output', 'static-contracts', 'brand-example-stage2-plan', 'landing-page.json'), {
    campaign_id: 'brand-example-stage2-plan',
    concept_id: 'landing-page-concept',
    platform: 'Landing Page',
    platform_slug: 'landing-page',
    creative: {
      headline: 'Landing page concept',
    },
    landing_page: {
      slug: '/launch',
      hero_subheadline: 'See the proof before you commit.',
    },
  });
}

async function seedPublishArtifacts(env: DashboardEnv, runId: string, options: { paused?: boolean; liveEvent?: boolean } = {}) {
  const reviewPackagePath = path.join(env.lobsterRoot, 'output', 'aries-review', 'tenant_dashboard', 'brand-example-stage2-plan', 'meta-ads', 'review-package.json');
  const publishImagePath = path.join(env.lobsterRoot, 'output', 'publish-ready', 'brand-example-stage2-plan', 'meta-ads', 'meta-ads.png');
  const publishCopyPath = path.join(env.lobsterRoot, 'output', 'publish-ready', 'brand-example-stage2-plan', 'meta-ads', 'meta-ads.json');
  await writeText(publishImagePath, 'png-preview');
  await writeJson(publishCopyPath, {
    headline: 'Meta launch package',
    body_lines: ['Proof block', 'CTA block'],
  });
  await writeJson(reviewPackagePath, {
    asset_paths: {
      copy_path: publishCopyPath,
      image_path: publishImagePath,
      landing_page_path: path.join(env.lobsterRoot, 'output', 'brand-example-campaign', 'landing-pages', 'index.html'),
    },
    campaign_id: 'brand-example-stage2-plan',
    platform: 'meta-ads',
    review_status: 'pending_tenant_review',
    tenant_profile_id: 'tenant_dashboard',
  });
  await writeJson(path.join(process.env.LOBSTER_STAGE4_CACHE_DIR!, runId, 'meta_ads_publisher.json'), {
    platform: 'meta-ads',
    generated_at: '2026-03-21T00:00:00.000Z',
    publish_package: {
      copy_path: publishCopyPath,
      image_path: publishImagePath,
      review_package_path: reviewPackagePath,
    },
    live_draft_publish: options.paused
      ? {
          status: 'ok',
          created_at: '2026-03-21T09:00:00.000Z',
          campaign_status: 'PAUSED',
          ad_status: 'PAUSED',
        }
      : {
          status: 'not_configured',
        },
  });
}

async function writeRuntimeDoc(jobId: string, doc: Record<string, unknown>) {
  await writeJson(path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs', `${jobId}.json`), doc);
}

test('dashboard adapter derives proposal-backed content and calendar without live schedule signals', async () => {
  await withDashboardEnv(async () => {
    const jobId = 'proposal-only';
    const doc: any = baseRuntimeDoc(jobId, 'tenant_dashboard');
    await seedPlanner('plan-run');
    await writeText(path.join(process.env.OPENCLAW_LOBSTER_CWD!, 'output', 'brand-example-campaign-proposal.md'), '# Proposal');
    await writeRuntimeDoc(jobId, doc);

    const { getMarketingDashboardContent } = await import('../backend/marketing/dashboard-content');
    const { listMarketingCampaignsForTenant } = await import('../backend/marketing/runtime-views');

    const content = getMarketingDashboardContent(jobId, {
      referenceDate: new Date('2026-03-27T00:00:00.000Z'),
    });
    const campaigns = await listMarketingCampaignsForTenant('tenant_dashboard');

    assert.equal(content.campaigns.length, 1);
    assert.equal(content.posts.some((post) => post.provenance.sourceKind === 'proposal'), true);
    assert.equal(content.calendarEvents.length > 0, true);
    assert.equal(content.calendarEvents[0].provenance.isPlatformNative, false);
    assert.notEqual(content.calendarEvents[0].status, 'live');
    assert.equal(campaigns.length, 1);
    assert.equal(campaigns[0].dashboard.posts.length > 0, true);
    assert.notEqual(campaigns[0].nextScheduled, 'Nothing scheduled yet');
  });
});

test('dashboard adapter recovers proposal artifacts from live Lobster logs when strategy run_id is missing', async () => {
  await withDashboardEnv(async (env) => {
    const jobId = 'proposal-inferred-run';
    const doc: any = baseRuntimeDoc(jobId, '6');
    doc.current_stage = 'production';
    doc.inputs = {
      request: {
        competitorUrl: 'betterup.com',
      },
      brand_url: 'https://sugarandleather.com',
      competitor_url: 'betterup.com',
    };
    doc.brand_kit = {
      ...doc.brand_kit,
      source_url: 'https://sugarandleather.com',
      canonical_url: 'https://sugarandleather.com',
      brand_name: 'Sugar & Leather',
    };
    doc.stages.strategy = stageRecord('strategy', 'completed', null);
    doc.updated_at = '2026-03-27T08:37:06.000Z';
    await writeJson(path.join(env.lobsterRoot, 'output', 'logs', 'betterup-com-live123', 'stage-2-strategy', 'campaign_planner.json'), {
      brand_slug: '6',
      brand_profiles_record: {
        brand_slug: '6',
        created_at: '2026-03-27T08:36:00.000Z',
      },
      campaign_plan: {
        campaign_name: '6-stage2-plan',
        objective: 'Grow coaching leads with proof-first messaging.',
        core_message: 'Lead with proof, then invite the next step.',
        primary_cta: 'Book a call',
        offer: 'Free coaching assessment',
        audience: 'Mid-funnel buyers',
        channel_plans: [
          {
            channel: 'meta',
            message: 'Proof-first Meta concept',
            creative_bias: 'Outcome proof with a direct CTA',
          },
        ],
      },
    });
    await writeText(path.join(env.lobsterRoot, 'output', '6-campaign-proposal.md'), '# Sugar & Leather Proposal');
    await writeRuntimeDoc(jobId, doc);

    const { getMarketingDashboardContent } = await import('../backend/marketing/dashboard-content');
    const content = getMarketingDashboardContent(jobId, {
      referenceDate: new Date('2026-03-27T00:00:00.000Z'),
    });

    assert.equal(content.posts.some((post) => post.provenance.sourceKind === 'proposal'), true);
    assert.equal(content.assets.some((asset) => asset.type === 'proposal_document'), true);
    assert.equal((content.campaigns[0]?.counts.proposalConcepts ?? 0) > 0, true);
  });
});

test('dashboard adapter keeps proposal approval truthful and does not leak future-stage artifacts before production starts', async () => {
  await withDashboardEnv(async (env) => {
    const jobId = 'pre-production-approval';
    const doc: any = baseRuntimeDoc(jobId, 'tenant_dashboard');
    doc.current_stage = 'production';
    doc.state = 'approval_required';
    doc.status = 'awaiting_approval';
    doc.stages.production = stageRecord('production', 'awaiting_approval', null);
    doc.stages.publish = stageRecord('publish', 'not_started', null);
    doc.approvals = {
      current: {
        stage: 'production',
        status: 'awaiting_approval',
        workflow_step_id: 'approve_stage_3',
        title: 'Production approval required',
        message: 'Stage 2 complete. Approve the campaign proposal and continue to Stage 3 production?',
        requested_at: '2026-03-27T08:37:06.603Z',
      },
      history: [],
    };

    await seedPlanner('plan-run');
    await writeText(path.join(env.lobsterRoot, 'output', 'brand-example-campaign-proposal.md'), '# Proposal');

    await seedCreativeArtifacts(env);
    await seedPublishArtifacts(env, 'older-publish-run', { paused: true });
    await writeJson(path.join(env.lobsterRoot, 'output', 'logs', 'betterup-com-oldrun', 'stage-4-publish-optimize', 'meta_ads_publisher.json'), {
      platform: 'meta-ads',
      generated_at: '2026-03-20T00:00:00.000Z',
      publish_package: {
        copy_path: path.join(env.lobsterRoot, 'output', 'publish-ready', 'brand-example-stage2-plan', 'meta-ads', 'meta-ads.json'),
        image_path: path.join(env.lobsterRoot, 'output', 'publish-ready', 'brand-example-stage2-plan', 'meta-ads', 'meta-ads.png'),
      },
    });
    await writeRuntimeDoc(jobId, doc);

    const { getMarketingDashboardContent } = await import('../backend/marketing/dashboard-content');
    const content = getMarketingDashboardContent(jobId, {
      referenceDate: new Date('2026-03-27T00:00:00.000Z'),
    });

    assert.equal(content.posts.some((post) => post.provenance.sourceKind === 'proposal' && post.status === 'in_review'), true);
    assert.equal(content.assets.some((asset) => asset.type === 'proposal_document' && asset.status === 'in_review'), true);
    assert.equal(content.assets.some((asset) => asset.provenance.sourceKind === 'creative_output'), false);
    assert.equal(content.publishItems.length, 0);
    assert.equal(content.posts.some((post) => post.provenance.sourceKind === 'publish_review' || post.provenance.sourceKind === 'live_publish_result'), false);
  });
});

test('dashboard adapter surfaces generated landing pages, image ads, scripts, and creative-output posts', async () => {
  await withDashboardEnv(async (env) => {
    const jobId = 'creative-ready';
    const doc: any = baseRuntimeDoc(jobId, 'tenant_dashboard');
    doc.current_stage = 'production';
    doc.stages.production = stageRecord('production', 'completed', 'prod-run');
    await seedPlanner('plan-run');
    await seedCreativeArtifacts(env);
    await writeRuntimeDoc(jobId, doc);

    const { getMarketingDashboardContent } = await import('../backend/marketing/dashboard-content');
    const content = getMarketingDashboardContent(jobId, {
      referenceDate: new Date('2026-03-27T00:00:00.000Z'),
    });

    assert.equal(content.assets.some((asset) => asset.type === 'landing_page'), true);
    assert.equal(content.assets.some((asset) => asset.type === 'image_ad'), true);
    assert.equal(content.assets.some((asset) => asset.type === 'script'), true);
    assert.equal(content.posts.some((post) => post.provenance.sourceKind === 'creative_output'), true);
    assert.equal(content.campaigns[0]?.counts.landingPages, 1);
    assert.equal(content.campaigns[0]?.counts.imageAds, 1);
    assert.equal(content.campaigns[0]?.counts.scripts, 1);
  });
});

test('dashboard adapter surfaces pre-publish review items as ready to publish', async () => {
  await withDashboardEnv(async (env) => {
    const jobId = 'review-ready';
    const doc: any = baseRuntimeDoc(jobId, 'tenant_dashboard');
    doc.current_stage = 'publish';
    doc.state = 'approval_required';
    doc.status = 'awaiting_approval';
    doc.stages.production = stageRecord('production', 'completed', 'prod-run');
    doc.stages.publish = stageRecord('publish', 'awaiting_approval', 'publish-run');
    doc.approvals = {
      current: {
        stage: 'publish',
        status: 'awaiting_approval',
        title: 'Launch approval required',
        message: 'Approve launch.',
        requested_at: '2026-03-21T00:00:00.000Z',
      },
      history: [],
    };
    doc.stages.publish.outputs = {
      review: {
        review_bundle: {
          campaign_name: 'Brand Example Launch',
          summary: {
            campaign_window: {
              start: '2026-03-24T00:00:00.000Z',
              end: '2026-03-31T00:00:00.000Z',
            },
          },
          platform_previews: [
            {
              platform_slug: 'meta-ads',
              platform_name: 'Meta Ads',
              summary: 'Launch package ready for review.',
              headline: 'Meta launch package',
              media_paths: [path.join(env.lobsterRoot, 'output', 'brand-example-campaign', 'ad-images', 'meta-feed.png')],
              asset_paths: {},
            },
          ],
        },
      },
    };
    await seedPlanner('plan-run');
    await seedCreativeArtifacts(env);
    await seedPublishArtifacts(env, 'publish-run');
    await writeRuntimeDoc(jobId, doc);

    const { getMarketingDashboardContent } = await import('../backend/marketing/dashboard-content');
    const content = getMarketingDashboardContent(jobId, {
      referenceDate: new Date('2026-03-27T00:00:00.000Z'),
    });

    assert.equal(content.publishItems.some((item) => item.status === 'ready_to_publish'), true);
    assert.equal(content.posts.some((item) => item.status === 'ready_to_publish'), true);
    assert.equal(content.calendarEvents.some((event) => event.statusLabel === 'Ready to Publish'), true);
  });
});

test('dashboard adapter surfaces paused Meta ads as published to Meta (paused)', async () => {
  await withDashboardEnv(async (env) => {
    const jobId = 'paused-meta';
    const doc: any = baseRuntimeDoc(jobId, 'tenant_dashboard');
    doc.current_stage = 'publish';
    doc.stages.production = stageRecord('production', 'completed', 'prod-run');
    doc.stages.publish = stageRecord('publish', 'completed', 'publish-run');
    await seedPlanner('plan-run');
    await seedCreativeArtifacts(env);
    await seedPublishArtifacts(env, 'publish-run', { paused: true });
    await writeRuntimeDoc(jobId, doc);

    const { getMarketingDashboardContent } = await import('../backend/marketing/dashboard-content');
    const content = getMarketingDashboardContent(jobId, {
      referenceDate: new Date('2026-03-27T00:00:00.000Z'),
    });

    assert.equal(content.publishItems.some((item) => item.status === 'published_to_meta_paused'), true);
    assert.equal(content.posts.some((item) => item.status === 'published_to_meta_paused'), true);
    assert.equal(content.calendarEvents.some((event) => event.statusLabel === 'Published to Meta (Paused)'), true);
  });
});

test('dashboard adapter prefers live platform schedule signals over fallback events when present', async () => {
  await withDashboardEnv(async (env) => {
    const jobId = 'live-override';
    const doc: any = baseRuntimeDoc(jobId, 'tenant_dashboard');
    doc.current_stage = 'publish';
    doc.stages.production = stageRecord('production', 'completed', 'prod-run');
    doc.stages.publish = stageRecord('publish', 'completed', 'publish-run');
    doc.stages.publish.outputs = {
      live_platform_events: {
        events: [
          {
            id: 'live_evt_1',
            title: 'Meta launch window',
            platform: 'meta-ads',
            status: 'scheduled',
            starts_at: '2026-03-28T12:00:00.000Z',
          },
        ],
      },
    };
    await seedPlanner('plan-run');
    await seedCreativeArtifacts(env);
    await seedPublishArtifacts(env, 'publish-run');
    await writeRuntimeDoc(jobId, doc);

    const { getMarketingDashboardContent } = await import('../backend/marketing/dashboard-content');
    const content = getMarketingDashboardContent(jobId, {
      referenceDate: new Date('2026-03-27T00:00:00.000Z'),
    });

    assert.equal(content.calendarEvents.length > 0, true);
    assert.equal(content.calendarEvents[0]?.title, 'Meta launch window');
    assert.equal(content.calendarEvents[0]?.status, 'scheduled');
    assert.equal(content.calendarEvents[0]?.provenance.isPlatformNative, true);
  });
});
