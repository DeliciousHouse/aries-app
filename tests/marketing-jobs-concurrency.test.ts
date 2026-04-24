import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import test from 'node:test';

import {
  getMarketingJobStatus,
  overrideMarketingJobStatusDependenciesForTests,
  resetMarketingJobStatusCacheForTests,
} from '../backend/marketing/jobs-status';
import type {
  MarketingCampaignWindow,
  MarketingCalendarEvent,
  MarketingReviewBundle,
} from '../backend/marketing/jobs-status';
import type { MarketingBrandKitReference, MarketingJobRuntimeDocument } from '../backend/marketing/runtime-state';
import {
  createMarketingJobRuntimeDocument,
  saveMarketingJobRuntime,
} from '../backend/marketing/runtime-state';
import type { ValidatedMarketingProfileSnapshot } from '../backend/marketing/validated-profile-store';
import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildBrandKit(dataRoot: string): MarketingBrandKitReference {
  return {
    path: path.join(dataRoot, 'generated', 'validated', 'tenant-real', 'brand-kit.json'),
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
    brand_voice_summary: 'Confident and clear.',
    offer_summary: 'Operator-led launch intensives.',
    extracted_at: '2026-03-19T00:00:00.000Z',
  };
}

function buildRuntimeDoc(dataRoot: string, jobId: string, tenantId: string): MarketingJobRuntimeDocument {
  return createMarketingJobRuntimeDocument({
    jobId,
    tenantId,
    payload: {
      brandUrl: 'https://brand.example',
      businessName: 'Brand Example',
      channels: ['meta-ads'],
    },
    brandKit: buildBrandKit(dataRoot),
    createdBy: 'user_123',
  });
}

function buildValidatedProfileSnapshot(): ValidatedMarketingProfileSnapshot {
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
    brandName: 'Brand Example',
    brandSlug: 'brand-example',
    websiteUrl: 'https://brand.example',
    canonicalUrl: 'https://brand.example',
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
    businessName: 'Brand Example',
    businessType: null,
    primaryGoal: null,
    launchApproverName: null,
    channels: ['meta-ads'],
    competitorUrl: null,
    brandIdentity: null,
  };
}

async function withRuntimeEnv<T>(run: (dataRoot: string) => Promise<T>): Promise<T> {
  const previousCodeRoot = process.env.CODE_ROOT;
  const previousDataRoot = process.env.DATA_ROOT;
  const previousOpenClawLobsterCwd = process.env.OPENCLAW_LOBSTER_CWD;
  const previousGatewayLobsterCwd = process.env.OPENCLAW_GATEWAY_LOBSTER_CWD;
  const previousStage1CacheDir = process.env.LOBSTER_STAGE1_CACHE_DIR;
  const previousStage2CacheDir = process.env.LOBSTER_STAGE2_CACHE_DIR;
  const previousStage3CacheDir = process.env.LOBSTER_STAGE3_CACHE_DIR;
  const previousStage4CacheDir = process.env.LOBSTER_STAGE4_CACHE_DIR;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-marketing-concurrency-'));

  process.env.CODE_ROOT = PROJECT_ROOT;
  process.env.DATA_ROOT = dataRoot;
  process.env.OPENCLAW_LOBSTER_CWD = path.join(PROJECT_ROOT, 'lobster');
  process.env.OPENCLAW_GATEWAY_LOBSTER_CWD = 'lobster';
  process.env.LOBSTER_STAGE1_CACHE_DIR = path.join(dataRoot, 'lobster-stage1-cache');
  process.env.LOBSTER_STAGE2_CACHE_DIR = path.join(dataRoot, 'lobster-stage2-cache');
  process.env.LOBSTER_STAGE3_CACHE_DIR = path.join(dataRoot, 'lobster-stage3-cache');
  process.env.LOBSTER_STAGE4_CACHE_DIR = path.join(dataRoot, 'lobster-stage4-cache');

  try {
    return await run(dataRoot);
  } finally {
    resetMarketingJobStatusCacheForTests();
    if (previousCodeRoot === undefined) delete process.env.CODE_ROOT;
    else process.env.CODE_ROOT = previousCodeRoot;
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    if (previousOpenClawLobsterCwd === undefined) delete process.env.OPENCLAW_LOBSTER_CWD;
    else process.env.OPENCLAW_LOBSTER_CWD = previousOpenClawLobsterCwd;
    if (previousGatewayLobsterCwd === undefined) delete process.env.OPENCLAW_GATEWAY_LOBSTER_CWD;
    else process.env.OPENCLAW_GATEWAY_LOBSTER_CWD = previousGatewayLobsterCwd;
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

test.beforeEach(() => {
  resetMarketingJobStatusCacheForTests();
});

test.afterEach(() => {
  resetMarketingJobStatusCacheForTests();
});

test('buildMarketingJobStatus fans out independent collectors in parallel', async () => {
  await withRuntimeEnv(async (dataRoot) => {
    const jobId = 'job-status-concurrency';
    saveMarketingJobRuntime(jobId, buildRuntimeDoc(dataRoot, jobId, 'tenant-real'));

    const starts: number[] = [];
    const timedDelay = async <T>(result: T): Promise<T> => {
      starts.push(performance.now());
      await delay(90);
      return result;
    };

    overrideMarketingJobStatusDependenciesForTests({
      buildReviewBundle: async () => timedDelay<MarketingReviewBundle | null>(null),
      buildCampaignWindow: async () => timedDelay<MarketingCampaignWindow | null>(null),
      buildCalendarEvents: async () => timedDelay<MarketingCalendarEvent[]>([]),
      buildPostCounts: async () => ({
        plannedPostCount: null,
        createdPostCount: null,
      }),
      loadValidatedMarketingProfileSnapshot: async () => timedDelay(buildValidatedProfileSnapshot()),
    });

    const startedAt = performance.now();
    const status = await getMarketingJobStatus(jobId);
    const elapsedMs = performance.now() - startedAt;

    assert.equal(status.jobId, jobId);
    assert.equal(starts.length, 4);
    assert.ok(
      Math.max(...starts) - Math.min(...starts) < 40,
      `expected collectors to start together, got spread ${(Math.max(...starts) - Math.min(...starts)).toFixed(1)}ms`,
    );
    assert.ok(elapsedMs < 170, `expected parallel execution under 170ms, got ${elapsedMs.toFixed(1)}ms`);
  });
});

test('buildReviewBundle overlaps publish-review resolution with asset-link loading', async () => {
  await withRuntimeEnv(async (dataRoot) => {
    const jobId = 'job-review-bundle-concurrency';
    saveMarketingJobRuntime(jobId, buildRuntimeDoc(dataRoot, jobId, 'tenant-real'));

    const starts: number[] = [];
    const markAndDelay = async <T>(result: T): Promise<T> => {
      starts.push(performance.now());
      await delay(90);
      return result;
    };

    overrideMarketingJobStatusDependenciesForTests({
      resolvePublishReviewBundle: async () =>
        markAndDelay({
          reviewPayload: {
            generated_at: '2026-03-21T00:00:00.000Z',
            approval_preview: { message: 'Ready for approval.' },
          },
          reviewBundle: {
            campaign_name: 'Spring Launch',
            approval_message: 'Ready for approval.',
            summary: {
              core_message: 'Launch summary',
            },
            platform_previews: [],
          },
          source: 'runtime' as const,
        }),
      buildMarketingAssetLinks: async () => markAndDelay([]),
      buildCampaignWindow: async () => null,
      buildCalendarEvents: async () => [],
      buildPostCounts: async () => ({
        plannedPostCount: null,
        createdPostCount: null,
      }),
      loadValidatedMarketingProfileSnapshot: async () => buildValidatedProfileSnapshot(),
    });

    const startedAt = performance.now();
    const status = await getMarketingJobStatus(jobId);
    const elapsedMs = performance.now() - startedAt;

    assert.equal(status.reviewBundle?.campaignName, 'Spring Launch');
    assert.equal(starts.length, 2);
    assert.ok(
      Math.max(...starts) - Math.min(...starts) < 40,
      `expected review bundle dependencies to start together, got spread ${(Math.max(...starts) - Math.min(...starts)).toFixed(1)}ms`,
    );
    assert.ok(elapsedMs < 170, `expected overlapping review bundle work under 170ms, got ${elapsedMs.toFixed(1)}ms`);
  });
});
