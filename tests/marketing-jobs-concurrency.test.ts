import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import {
  getMarketingJobStatus,
  overrideMarketingJobStatusDepsForTests,
  resetMarketingJobStatusCacheForTests,
  type MarketingJobStatusResponse,
} from '../backend/marketing/jobs-status';
import type { CampaignWorkspaceView } from '../backend/marketing/workspace-views';
import type { MarketingJobRuntimeDocument, MarketingStageRecord } from '../backend/marketing/runtime-state';
import {
  handleGetMarketingJobStatus,
  overrideMarketingJobStatusRouteDepsForTests,
  resetMarketingJobStatusRouteDepsForTests,
} from '../app/api/marketing/jobs/[jobId]/handler';
import type { TenantContext } from '../lib/tenant-context';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createStageRecord(stage: MarketingStageRecord['stage']): MarketingStageRecord {
  return {
    stage,
    status: 'completed',
    started_at: '2026-04-24T00:00:00.000Z',
    completed_at: '2026-04-24T00:01:00.000Z',
    failed_at: null,
    run_id: `${stage}-run`,
    summary: { summary: `${stage} complete` },
    primary_output: null,
    outputs: {},
    artifacts: [],
    errors: [],
  };
}

function createRuntimeDoc(jobId: string, tenantId: string): MarketingJobRuntimeDocument {
  return {
    schema_name: 'marketing_job_state_schema',
    schema_version: '1.0.0',
    job_id: jobId,
    tenant_id: tenantId,
    job_type: 'brand_campaign',
    state: 'completed',
    status: 'completed',
    current_stage: 'publish',
    stage_order: ['research', 'strategy', 'production', 'publish'],
    stages: {
      research: createStageRecord('research'),
      strategy: createStageRecord('strategy'),
      production: createStageRecord('production'),
      publish: createStageRecord('publish'),
    },
    approvals: {
      current: null,
      history: [],
    },
    publish_config: {
      platforms: [],
      live_publish_platforms: [],
      video_render_platforms: [],
    },
    brand_kit: null,
    inputs: {
      request: {},
      brand_url: 'https://brand.example',
    },
    summary: {
      headline: 'Campaign ready',
      subheadline: 'All stages are complete.',
    },
    errors: [],
    last_error: null,
    history: [],
    created_at: '2026-04-24T00:00:00.000Z',
    updated_at: '2026-04-24T00:01:00.000Z',
  };
}

function buildPayload(jobId: string, tenantId: string): MarketingJobStatusResponse {
  return {
    jobId,
    tenantId,
    tenantName: 'Tenant Name',
    brandWebsiteUrl: 'https://brand.example',
    campaignWindow: null,
    durationDays: null,
    plannedPostCount: null,
    createdPostCount: null,
    assetPreviewCards: [],
    calendarEvents: [],
    state: 'completed',
    status: 'completed',
    currentStage: 'publish',
    stageStatus: {
      research: 'completed',
      strategy: 'completed',
      production: 'completed',
      publish: 'completed',
    },
    updatedAt: '2026-04-24T00:01:00.000Z',
    approvalRequired: false,
    needsAttention: false,
    summary: {
      headline: 'Campaign ready',
      subheadline: 'All stages are complete.',
    },
    stageCards: [],
    artifacts: [],
    timeline: [],
    approval: null,
    reviewBundle: null,
    publishConfig: {
      platforms: [],
      livePublishPlatforms: [],
      videoRenderPlatforms: [],
    },
    nextStep: 'none',
    repairStatus: 'not_required',
  };
}

function buildWorkspaceView(jobId: string): CampaignWorkspaceView {
  return {
    jobId,
    tenantId: 'tenant-a',
    campaignBrief: null,
    workflowState: 'approved',
    statusHistory: [],
    brandReview: null,
    strategyReview: null,
    creativeReview: null,
    publishBlockedReason: null,
    dashboard: {
      campaign: null,
      posts: [],
      assets: [],
      publishItems: [],
      calendarEvents: [],
      statuses: {
        countsByStatus: {
          draft: 0,
          in_review: 0,
          ready: 0,
          ready_to_publish: 0,
          published_to_meta_paused: 0,
          scheduled: 0,
          live: 0,
        },
      },
    },
  };
}

test.beforeEach(() => {
  resetMarketingJobStatusCacheForTests();
  resetMarketingJobStatusRouteDepsForTests();
});

test.afterEach(() => {
  resetMarketingJobStatusCacheForTests();
  resetMarketingJobStatusRouteDepsForTests();
});

test('buildMarketingJobStatus overlaps review bundle resolution and asset link hydration', async () => {
  const runtimeDoc = createRuntimeDoc('job-parallel', 'tenant-a');
  const starts: Array<{ label: string; at: number }> = [];
  const markStart = (label: string): void => {
    starts.push({ label, at: performance.now() });
  };

  overrideMarketingJobStatusDepsForTests({
    assertMarketingRuntimeSchemas: async () => {},
    loadMarketingJobRuntime: async () => runtimeDoc,
    resolvePublishReviewBundle: async () => {
      markStart('resolvePublishReviewBundle');
      await delay(120);
      return {
        reviewPayload: null,
        reviewBundle: null,
        source: 'none',
      };
    },
    buildMarketingAssetLinks: async () => {
      markStart('buildMarketingAssetLinks');
      await delay(100);
      return [];
    },
    buildCampaignWindow: async () => {
      markStart('campaignWindow');
      return null;
    },
    buildCalendarEvents: async () => {
      markStart('calendarEvents');
      return [];
    },
    loadValidatedMarketingProfileSnapshot: async () => {
      markStart('validatedProfile');
      return {
        docs: {
          brandProfile: null,
          websiteAnalysis: null,
          businessProfile: null,
          brandKit: null,
          paths: {
            brandProfile: null,
            websiteAnalysis: null,
            businessProfile: null,
            brandKit: null,
          },
        },
        brandName: null,
        brandSlug: null,
        websiteUrl: null,
        canonicalUrl: null,
        audience: null,
        positioning: null,
        problemStatement: null,
        offer: null,
        primaryCta: null,
        proofPoints: [],
        brandVoice: [],
        channelSpecificAngles: null,
        hooks: null,
        openingLines: null,
        businessName: null,
        businessType: null,
        primaryGoal: null,
        launchApproverName: null,
        channels: [],
        competitorUrl: null,
        brandIdentity: null,
      };
    },
  });

  const startedAt = performance.now();
  const result = await getMarketingJobStatus(runtimeDoc.job_id);
  const elapsedMs = performance.now() - startedAt;

  assert.equal(result.jobId, runtimeDoc.job_id);
  const firstResolve = starts.find((entry) => entry.label === 'resolvePublishReviewBundle');
  const firstAssetLinks = starts.find((entry) => entry.label === 'buildMarketingAssetLinks');
  assert.ok(firstResolve, `expected resolvePublishReviewBundle to start, got ${JSON.stringify(starts)}`);
  assert.ok(firstAssetLinks, `expected buildMarketingAssetLinks to start, got ${JSON.stringify(starts)}`);
  assert.ok(Math.abs(firstResolve.at - firstAssetLinks.at) < 35, `expected review bundle branches to start together, got ${JSON.stringify(starts)}`);
  assert.ok(elapsedMs < 290, `expected overlapped execution under 290ms, got ${elapsedMs.toFixed(1)}ms`);
});

test('handleGetMarketingJobStatus overlaps cached status and workspace view', async () => {
  const runtimeDoc = createRuntimeDoc('job-route', 'tenant-a');
  const tenantContext: TenantContext = {
    userId: 'user-1',
    tenantId: 'tenant-a',
    tenantSlug: 'tenant-a',
    role: 'tenant_admin',
  };
  const starts: Array<{ label: string; at: number }> = [];
  const markStart = (label: string): void => {
    starts.push({ label, at: performance.now() });
  };

  overrideMarketingJobStatusRouteDepsForTests({
    loadMarketingJobRuntime: async () => runtimeDoc,
    getMarketingJobStatusCached: async (_tenantId, jobId) => {
      markStart('status');
      await delay(120);
      return {
        payload: buildPayload(jobId, tenantContext.tenantId),
        cacheStatus: 'miss',
      };
    },
    buildCampaignWorkspaceView: async (jobId) => {
      markStart('workspace');
      await delay(90);
      return buildWorkspaceView(jobId);
    },
  });

  const startedAt = performance.now();
  const response = await handleGetMarketingJobStatus(runtimeDoc.job_id, async () => tenantContext);
  const elapsedMs = performance.now() - startedAt;
  const body = await response.json() as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.equal(body.jobId, runtimeDoc.job_id);
  assert.equal(starts.length, 2);
  assert.ok(Math.abs(starts[0]!.at - starts[1]!.at) < 35, `expected both route branches to start together, got ${JSON.stringify(starts)}`);
  assert.ok(elapsedMs < 190, `expected overlapped execution under 190ms, got ${elapsedMs.toFixed(1)}ms`);
});
