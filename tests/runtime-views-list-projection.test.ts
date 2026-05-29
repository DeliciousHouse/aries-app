import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

// Golden regression guard for the campaign-list perf refactor
// (perf(social-content): lightweight list projection — v0.1.13.6).
//
// The list path (listSocialContentJobsForTenant) now derives each card's
// `pendingApprovals` count from the phase-1 (runtimeDoc, status, view) context
// via buildReviewItemsFromContext, instead of re-hydrating each job through
// buildReviewItemsForJob. This test pins that the list count stays EQUAL to the
// count the re-hydrating review-items path (listMarketingReviewItemsForTenant,
// which calls buildReviewItemsForJob internally) produces for the same tenant,
// so the optimization can never silently drift the cards.

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

async function withMarketingRuntimeEnv<T>(run: (dataRoot: string) => Promise<T>): Promise<T> {
  const prevCodeRoot = process.env.CODE_ROOT;
  const prevDataRoot = process.env.DATA_ROOT;
  const prevStage2 = process.env.ARTIFACT_STAGE2_CACHE_DIR;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-list-projection-'));
  process.env.CODE_ROOT = PROJECT_ROOT;
  process.env.DATA_ROOT = dataRoot;
  process.env.ARTIFACT_STAGE2_CACHE_DIR = path.join(dataRoot, 'stage2-cache');
  try {
    return await run(dataRoot);
  } finally {
    if (prevCodeRoot === undefined) delete process.env.CODE_ROOT;
    else process.env.CODE_ROOT = prevCodeRoot;
    if (prevDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = prevDataRoot;
    if (prevStage2 === undefined) delete process.env.ARTIFACT_STAGE2_CACHE_DIR;
    else process.env.ARTIFACT_STAGE2_CACHE_DIR = prevStage2;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

function strategyBackedJob(dataRoot: string, tenantId: string, jobId: string): Record<string, unknown> {
  return {
    schema_name: 'marketing_job_state_schema',
    schema_version: '1.0.0',
    job_id: jobId,
    job_type: 'weekly_social_content',
    tenant_id: tenantId,
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
      path: path.join(dataRoot, 'generated', 'validated', tenantId, 'brand-kit.json'),
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
  };
}

function researchStageJob(tenantId: string, jobId: string): Record<string, unknown> {
  return {
    schema_name: 'marketing_job_state_schema',
    schema_version: '1.0.0',
    job_id: jobId,
    job_type: 'weekly_social_content',
    tenant_id: tenantId,
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
    brand_kit: null,
    inputs: { request: {}, brand_url: 'https://brand.example' },
    errors: [],
    last_error: null,
    history: [],
    created_at: '2026-03-20T00:00:00.000Z',
    updated_at: '2026-03-20T00:10:00.000Z',
  };
}

async function seedCampaignPlanner(): Promise<void> {
  await mkdir(path.join(process.env.ARTIFACT_STAGE2_CACHE_DIR!, 'plan-run'), { recursive: true });
  await writeFile(
    path.join(process.env.ARTIFACT_STAGE2_CACHE_DIR!, 'plan-run', 'campaign_planner.json'),
    JSON.stringify({
      brand_slug: 'brand-example',
      campaign_plan: {
        campaign_name: 'brand-example-stage2-plan',
        objective: 'Drive demo requests from a proposal-backed launch.',
        core_message: 'Proof-first messaging keeps the dashboard truthful.',
        channel_plans: [{ channel: 'meta', message: 'Meta launch concept', creative_bias: 'Outcome proof' }],
      },
    }, null, 2),
  );
}

// The invariant: the list-projection pendingApprovals count must equal the count
// the re-hydrating review-items path (buildReviewItemsForJob via
// listMarketingReviewItemsForTenant) produces for the same tenant. This holds
// regardless of the absolute count, which is the whole point — the optimization
// must never change the number the UI shows.
async function assertListMatchesOracle(tenantId: string): Promise<void> {
  const views = await import('../backend/marketing/runtime-views');
  const { posts } = await views.listSocialContentJobsForTenant(tenantId);
  assert.equal(posts.length, 1, 'one campaign expected');

  const allReviewItems = await views.listMarketingReviewItemsForTenant(tenantId);
  const expectedPending = allReviewItems.filter((item) => item.status !== 'approved').length;

  assert.equal(
    posts[0].pendingApprovals,
    expectedPending,
    'list-projection pendingApprovals must match the full-hydration review-items count',
  );
}

test('strategy-backed job: list pendingApprovals matches the re-hydrating oracle', async () => {
  await withMarketingRuntimeEnv(async (dataRoot) => {
    const tenantId = 'tenant_listproj';
    const jobId = 'list-projection-job';
    const jobsRoot = path.join(dataRoot, 'generated', 'draft', 'marketing-jobs');
    await mkdir(jobsRoot, { recursive: true });
    await seedCampaignPlanner();
    await writeFile(path.join(jobsRoot, `${jobId}.json`), JSON.stringify(strategyBackedJob(dataRoot, tenantId, jobId), null, 2));
    await assertListMatchesOracle(tenantId);
  });
});

test('brand-new research-stage job: list pendingApprovals matches the re-hydrating oracle', async () => {
  await withMarketingRuntimeEnv(async (dataRoot) => {
    const tenantId = 'tenant_listproj_new';
    const jobId = 'list-projection-new-job';
    const jobsRoot = path.join(dataRoot, 'generated', 'draft', 'marketing-jobs');
    await mkdir(jobsRoot, { recursive: true });
    await writeFile(path.join(jobsRoot, `${jobId}.json`), JSON.stringify(researchStageJob(tenantId, jobId), null, 2));
    await assertListMatchesOracle(tenantId);
  });
});
