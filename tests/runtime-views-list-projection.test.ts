import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

// Golden regression guard for the campaign-list perf refactor
// (perf(social-content): lightweight list projection — v0.1.13.6, extended for
// the v0.1.13.7 scoped wins).
//
// v0.1.13.6: the list path (listSocialContentJobsForTenant) derives each card's
// `pendingApprovals` count from the phase-1 (runtimeDoc, status, view) context
// via buildReviewItemsFromContext, instead of re-hydrating each job through
// buildReviewItemsForJob. assertListMatchesOracle pins that the list count stays
// EQUAL to the count the re-hydrating review-items path
// (listMarketingReviewItemsForTenant, which calls buildReviewItemsForJob
// internally) produces, so the optimization can never silently drift the cards.
//
// v0.1.13.7: the list threads a single preloaded runtime doc through
// getMarketingJobStatus + buildSocialContentWorkspaceView (collapsing the 3-4
// per-job runtime-doc disk reads to one). The view is still fully built, so the
// cards and the pendingApprovals count are unchanged. assertViewEquivalence pins
// the byte-identity: threading the doc produces output identical to reloading it
// (both the view and the status), for which loadSocialContentJobRuntime must stay
// a pure read and the builders must treat the doc as read-only.
//
// (A separate v0.1.13.7 attempt skipped the DB production creative_assets merge on
// the list path to drop a Postgres query; adversarial review found it under-counts
// pendingApprovals when an operator rejected a DB-only creative asset — mergeReviewState
// overrides the asset's 'approved' payload status with the persisted 'rejected'
// decision — so that part was reverted. The list keeps full hydration.)

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
async function assertListMatchesOracle(tenantId: string, jobId: string): Promise<void> {
  const views = await import('../backend/marketing/runtime-views');
  const store = await import('../backend/marketing/workspace-store');
  const { posts } = await views.listSocialContentJobsForTenant(tenantId);
  assert.equal(posts.length, 1, 'one campaign expected');

  const allReviewItems = await views.listMarketingReviewItemsForTenant(tenantId);
  const expectedPending = allReviewItems.filter((item) => item.status !== 'approved').length;

  assert.equal(
    posts[0].pendingApprovals,
    expectedPending,
    'list-projection pendingApprovals must match the full-hydration review-items count',
  );

  // Write-time denormalization invariant: the PERSISTED pending_approval_count
  // scalar (what the list reads O(1)) must equal the live re-hydrating oracle.
  // The list read above self-heals legacy records, so by now the scalar must be
  // present and exact.
  const record = store.loadSocialContentWorkspaceRecord(jobId, tenantId);
  assert.ok(record, 'workspace record must exist after a list load');
  assert.equal(
    record!.pending_approval_count,
    expectedPending,
    'persisted pending_approval_count must equal the live oracle count',
  );

  // And a direct recompute must agree too (the helper every write site calls).
  const recomputed = await views.recomputeAndPersistPendingApprovalCount(jobId);
  assert.equal(
    recomputed,
    expectedPending,
    'recomputeAndPersistPendingApprovalCount must equal the live oracle count',
  );
}

// v0.1.13.7 invariant: threading a preloaded runtime doc through the status and
// view builds must be byte-identical to letting each builder reload it from disk.
async function assertViewEquivalence(jobId: string): Promise<void> {
  const workspaceViews = await import('../backend/marketing/workspace-views');
  const jobsStatus = await import('../backend/marketing/jobs-status');
  const runtimeState = await import('../backend/marketing/runtime-state');

  // Warm up: the view build has converging write-on-read side effects (the
  // review-state normalizers + status_history sync persist the workspace record).
  // Run once so the comparison builds below all read a settled record and don't
  // diverge on a first-call mutation that the second call no longer performs.
  await workspaceViews.buildSocialContentWorkspaceView(jobId);

  // Doc-read collapse: threading a preloaded runtime doc must be byte-identical to
  // letting each builder reload it from disk. This holds only because
  // loadSocialContentJobRuntime returns a fresh object per call and the builders
  // treat the doc as read-only; if any builder mutated the shared object in place,
  // threading it would diverge from two independent reloads.
  const doc = await runtimeState.loadSocialContentJobRuntime(jobId);
  const threadedView = await workspaceViews.buildSocialContentWorkspaceView(jobId, { runtimeDoc: doc });
  const reloadedView = await workspaceViews.buildSocialContentWorkspaceView(jobId);
  assert.deepEqual(threadedView, reloadedView, 'threaded-doc view must equal the reload-doc view');

  const threadedStatus = await jobsStatus.getMarketingJobStatus(jobId, { runtimeDoc: doc });
  const reloadedStatus = await jobsStatus.getMarketingJobStatus(jobId);
  assert.deepEqual(threadedStatus, reloadedStatus, 'threaded-doc status must equal the reload-doc status');
}

test('strategy-backed job: list pendingApprovals matches the re-hydrating oracle', async () => {
  await withMarketingRuntimeEnv(async (dataRoot) => {
    const tenantId = 'tenant_listproj';
    const jobId = 'list-projection-job';
    const jobsRoot = path.join(dataRoot, 'generated', 'draft', 'marketing-jobs');
    await mkdir(jobsRoot, { recursive: true });
    await seedCampaignPlanner();
    await writeFile(path.join(jobsRoot, `${jobId}.json`), JSON.stringify(strategyBackedJob(dataRoot, tenantId, jobId), null, 2));
    await assertListMatchesOracle(tenantId, jobId);
    await assertViewEquivalence(jobId);
  });
});

test('brand-new research-stage job: list pendingApprovals matches the re-hydrating oracle', async () => {
  await withMarketingRuntimeEnv(async (dataRoot) => {
    const tenantId = 'tenant_listproj_new';
    const jobId = 'list-projection-new-job';
    const jobsRoot = path.join(dataRoot, 'generated', 'draft', 'marketing-jobs');
    await mkdir(jobsRoot, { recursive: true });
    await writeFile(path.join(jobsRoot, `${jobId}.json`), JSON.stringify(researchStageJob(tenantId, jobId), null, 2));
    await assertListMatchesOracle(tenantId, jobId);
    await assertViewEquivalence(jobId);
  });
});
