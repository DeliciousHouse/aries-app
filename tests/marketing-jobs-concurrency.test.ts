import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import {
  getMarketingJobStatus,
  overrideMarketingJobStatusDepsForTests,
  resetMarketingJobStatusCacheForTests,
} from '../backend/marketing/jobs-status';
import type { MarketingJobRuntimeDocument, MarketingStageRecord } from '../backend/marketing/runtime-state';

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

test.beforeEach(() => {
  resetMarketingJobStatusCacheForTests();
});

test.afterEach(() => {
  resetMarketingJobStatusCacheForTests();
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
