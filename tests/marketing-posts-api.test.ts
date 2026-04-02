import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

async function withRuntimeEnv<T>(run: (dataRoot: string, lobsterRoot: string) => Promise<T>): Promise<T> {
  const previousCodeRoot = process.env.CODE_ROOT;
  const previousDataRoot = process.env.DATA_ROOT;
  const previousOpenClawLobsterCwd = process.env.OPENCLAW_LOBSTER_CWD;
  const previousStage1CacheDir = process.env.LOBSTER_STAGE1_CACHE_DIR;
  const previousStage2CacheDir = process.env.LOBSTER_STAGE2_CACHE_DIR;
  const previousStage3CacheDir = process.env.LOBSTER_STAGE3_CACHE_DIR;
  const previousStage4CacheDir = process.env.LOBSTER_STAGE4_CACHE_DIR;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-posts-api-'));
  const lobsterRoot = path.join(dataRoot, 'lobster');

  process.env.CODE_ROOT = PROJECT_ROOT;
  process.env.DATA_ROOT = dataRoot;
  process.env.OPENCLAW_LOBSTER_CWD = lobsterRoot;
  process.env.LOBSTER_STAGE1_CACHE_DIR = path.join(dataRoot, 'lobster-stage1-cache');
  process.env.LOBSTER_STAGE2_CACHE_DIR = path.join(dataRoot, 'lobster-stage2-cache');
  process.env.LOBSTER_STAGE3_CACHE_DIR = path.join(dataRoot, 'lobster-stage3-cache');
  process.env.LOBSTER_STAGE4_CACHE_DIR = path.join(dataRoot, 'lobster-stage4-cache');

  try {
    return await run(dataRoot, lobsterRoot);
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

async function writeJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

async function writeText(filePath: string, value: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, value, 'utf8');
}

test('/api/marketing/posts returns ready-to-publish inventory from review and publish-ready artifacts', async () => {
  await withRuntimeEnv(async (dataRoot, lobsterRoot) => {
    const { handleGetMarketingPosts } = await import('../app/api/marketing/posts/route');
    const jobId = 'mkt_posts_inventory';
    const runtimeFile = path.join(dataRoot, 'generated', 'draft', 'marketing-jobs', `${jobId}.json`);
    const copyPath = path.join(lobsterRoot, 'output', 'publish-ready', 'brand-example-stage2-plan', 'meta-ads', 'meta-ads.json');
    const imagePath = path.join(lobsterRoot, 'output', 'publish-ready', 'brand-example-stage2-plan', 'meta-ads', 'meta-ads.png');
    const landingPagePath = path.join(lobsterRoot, 'output', 'brand-example-campaign', 'landing-pages', 'index.html');
    const reviewPackagePath = path.join(lobsterRoot, 'output', 'aries-review', 'tenant_real', 'brand-example-stage2-plan', 'meta-ads', 'review-package.json');

    await writeText(imagePath, 'png-preview');
    await writeJson(copyPath, {
      headline: 'Meta launch package',
      body_lines: ['Proof block', 'CTA block'],
    });
    await writeText(landingPagePath, '<html>landing</html>');
    await writeJson(reviewPackagePath, {
      asset_paths: {
        copy_path: copyPath,
        image_path: imagePath,
        landing_page_path: landingPagePath,
      },
      campaign_id: 'brand-example-stage2-plan',
      platform: 'meta-ads',
      review_status: 'pending_tenant_review',
      tenant_profile_id: 'tenant_real',
    });
    await writeJson(path.join(process.env.LOBSTER_STAGE2_CACHE_DIR!, 'plan-run', 'campaign_planner.json'), {
      brand_slug: 'brand-example',
      campaign_plan: {
        campaign_name: 'brand-example-stage2-plan',
        objective: 'Drive demo requests',
        core_message: 'Proof-first launch',
        channel_plans: [{ channel: 'meta', message: 'Meta launch package' }],
      },
    });
    await writeJson(path.join(process.env.LOBSTER_STAGE4_CACHE_DIR!, 'publish-run', 'meta_ads_publisher.json'), {
      platform: 'meta-ads',
      generated_at: '2026-03-21T00:00:00.000Z',
      publish_package: {
        copy_path: copyPath,
        image_path: imagePath,
        review_package_path: reviewPackagePath,
      },
      live_draft_publish: {
        status: 'not_configured',
      },
    });
    await writeJson(runtimeFile, {
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
        strategy: { stage: 'strategy', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'plan-run', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
        production: { stage: 'production', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'prod-run', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
        publish: {
          stage: 'publish',
          status: 'awaiting_approval',
          started_at: null,
          completed_at: null,
          failed_at: null,
          run_id: 'publish-run',
          summary: null,
          primary_output: null,
          outputs: {
            review: {
              review_bundle: {
                campaign_name: 'Brand Example Launch',
                summary: {},
                platform_previews: [
                  {
                    platform_slug: 'meta-ads',
                    platform_name: 'Meta Ads',
                    summary: 'Launch package ready for review.',
                    headline: 'Meta launch package',
                    media_paths: [imagePath],
                    asset_paths: {
                      landing_page_path: landingPagePath,
                    },
                  },
                ],
              },
            },
          },
          artifacts: [],
          errors: [],
        },
      },
      approvals: {
        current: {
          stage: 'publish',
          status: 'awaiting_approval',
          title: 'Launch approval required',
          message: 'Approve launch.',
          requested_at: '2026-03-21T00:00:00.000Z',
        },
        history: [],
      },
      publish_config: {
        platforms: ['meta-ads'],
        live_publish_platforms: ['meta-ads'],
        video_render_platforms: [],
      },
      brand_kit: {
        path: path.join(dataRoot, 'generated', 'validated', 'tenant_real', 'brand-kit.json'),
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
      updated_at: '2026-03-21T00:00:00.000Z',
    });

    const response = await handleGetMarketingPosts(async () => ({
      userId: 'user_123',
      tenantId: 'tenant_real',
      tenantSlug: 'brand-example',
      role: 'tenant_admin',
    }));
    const body = (await response.json()) as Record<string, any>;

    assert.equal(response.status, 200);
    assert.equal(Array.isArray(body.publishItems), true);
    assert.equal(body.publishItems.length > 0, true);
    assert.equal(body.publishItems[0].status, 'ready_to_publish');
    assert.equal(body.publishItems[0].provenance.sourceKind, 'publish_review');
    assert.equal(Array.isArray(body.assets), true);
    assert.equal(body.assets.some((asset: Record<string, unknown>) => typeof asset.previewUrl === 'string'), true);
    assert.equal(Array.isArray(body.posts), true);
    assert.equal(body.posts.some((post: Record<string, unknown>) => post.status === 'ready_to_publish'), true);
    assert.equal(body.campaigns[0].counts.readyToPublish > 0, true);
  });
});
