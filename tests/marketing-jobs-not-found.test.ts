import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { MarketingJobStatusResponse } from '../backend/marketing/jobs-status';
import {
  getMarketingJobStatusCacheSizeForTests,
  overrideMarketingJobStatusBuilderForTests,
  resetMarketingJobStatusCacheForTests,
} from '../backend/marketing/jobs-status';
import type { MarketingBrandKitReference, MarketingJobRuntimeDocument } from '../backend/marketing/runtime-state';
import { createMarketingJobRuntimeDocument, saveMarketingJobRuntime } from '../backend/marketing/runtime-state';
import { handleGetMarketingJobStatus } from '../app/api/marketing/jobs/[jobId]/handler';
import { TenantContextError } from '../lib/tenant-context';
import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const originalConsoleWarn = console.warn;

type WarnEntry = {
  message: string;
  details?: Record<string, unknown>;
};

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

function buildPayload(jobId: string, tenantId: string): MarketingJobStatusResponse {
  return {
    jobId,
    tenantId,
    tenantName: 'Brand Example',
    brandWebsiteUrl: 'https://brand.example',
    campaignWindow: null,
    durationDays: null,
    plannedPostCount: 1,
    createdPostCount: 0,
    assetPreviewCards: [],
    calendarEvents: [],
    state: 'running',
    status: 'ok',
    currentStage: 'research',
    stageStatus: {
      research: 'in_progress',
      strategy: 'not_started',
      production: 'not_started',
      publish: 'not_started',
    },
    updatedAt: '2026-03-21T00:00:00.000Z',
    approvalRequired: false,
    needsAttention: false,
    summary: {
      headline: 'Campaign in progress',
      subheadline: 'Research is running.',
    },
    stageCards: [],
    artifacts: [],
    timeline: [],
    approval: null,
    reviewBundle: null,
    publishConfig: {
      platforms: ['meta-ads'],
      livePublishPlatforms: [],
      videoRenderPlatforms: [],
    },
    nextStep: 'wait_for_completion',
    repairStatus: 'not_required',
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
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-marketing-not-found-'));

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
  console.warn = () => {};
});

test.afterEach(() => {
  resetMarketingJobStatusCacheForTests();
  console.warn = originalConsoleWarn;
});

test('unknown job id returns opaque 404 and does not populate the cache', async () => {
  await withRuntimeEnv(async () => {
    let builderCalls = 0;
    overrideMarketingJobStatusBuilderForTests(async (tenantId, jobId) => {
      builderCalls += 1;
      return buildPayload(jobId, tenantId);
    });

    const response = await handleGetMarketingJobStatus(
      'missing-job',
      async () => ({
        userId: 'user_123',
        tenantId: 'tenant_real',
        tenantSlug: 'tenant-real',
        role: 'tenant_admin',
      }),
    );
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 404);
    assert.deepEqual(body, {
      error: 'Marketing job not found.',
      reason: 'marketing_job_not_found',
    });
    assert.equal('stageCards' in body, false);
    assert.equal(builderCalls, 0);
    assert.equal(getMarketingJobStatusCacheSizeForTests(), 0);
  });
});

test('cross-tenant job id returns the same opaque 404 body as an unknown id', async () => {
  await withRuntimeEnv(async (dataRoot) => {
    const jobId = 'job-cross-tenant';
    saveMarketingJobRuntime(jobId, buildRuntimeDoc(dataRoot, jobId, 'tenant_other'));

    let builderCalls = 0;
    overrideMarketingJobStatusBuilderForTests(async (tenantId, requestedJobId) => {
      builderCalls += 1;
      return buildPayload(requestedJobId, tenantId);
    });

    const response = await handleGetMarketingJobStatus(
      jobId,
      async () => ({
        userId: 'user_123',
        tenantId: 'tenant_real',
        tenantSlug: 'tenant-real',
        role: 'tenant_admin',
      }),
    );
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 404);
    assert.deepEqual(body, {
      error: 'Marketing job not found.',
      reason: 'marketing_job_not_found',
    });
    assert.equal(builderCalls, 0);
    assert.equal(getMarketingJobStatusCacheSizeForTests(), 0);
  });
});

test('tenant-matched job id still returns 200 on the happy path', async () => {
  await withRuntimeEnv(async (dataRoot) => {
    const jobId = 'job-happy-path';
    saveMarketingJobRuntime(jobId, buildRuntimeDoc(dataRoot, jobId, 'tenant_real'));

    let builderCalls = 0;
    overrideMarketingJobStatusBuilderForTests(async (tenantId, requestedJobId) => {
      builderCalls += 1;
      return buildPayload(requestedJobId, tenantId);
    });

    const response = await handleGetMarketingJobStatus(
      jobId,
      async () => ({
        userId: 'user_123',
        tenantId: 'tenant_real',
        tenantSlug: 'tenant-real',
        role: 'tenant_admin',
      }),
    );
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 200);
    assert.equal(body.jobId, jobId);
    assert.equal(body.tenantName, 'Brand Example');
    assert.equal(response.headers.get('x-cache'), 'miss');
    assert.equal(builderCalls, 1);
    assert.equal(getMarketingJobStatusCacheSizeForTests(), 1);
  });
});

test('unauthenticated path remains unchanged', async () => {
  await withRuntimeEnv(async () => {
    const response = await handleGetMarketingJobStatus('missing-job', async () => {
      throw new Error('Authentication required.');
    });
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 403);
    assert.equal(body.status, 'error');
    assert.equal(body.reason, 'tenant_context_required');
  });
});

test('pre-onboarding path remains unchanged', async () => {
  await withRuntimeEnv(async () => {
    const response = await handleGetMarketingJobStatus('missing-job', async () => {
      throw new TenantContextError(
        'tenant_membership_missing',
        'No tenant membership found for authenticated user.',
      );
    });
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 409);
    assert.equal(body.status, 'error');
    assert.equal(body.reason, 'onboarding_required');
    assert.equal(body.message, 'Complete tenant onboarding before viewing brand campaign status.');
  });
});

test('server-side logs distinguish runtime_doc_missing from tenant_mismatch while responses stay opaque', async () => {
  await withRuntimeEnv(async (dataRoot) => {
    const jobId = 'job-log-tenant-mismatch';
    saveMarketingJobRuntime(jobId, buildRuntimeDoc(dataRoot, jobId, 'tenant_other'));

    const warnings: WarnEntry[] = [];
    console.warn = (message?: unknown, details?: unknown) => {
      warnings.push({
        message: String(message ?? ''),
        details:
          details && typeof details === 'object' && !Array.isArray(details)
            ? (details as Record<string, unknown>)
            : undefined,
      });
    };

    const tenantLoader = async () => ({
      userId: 'user_123',
      tenantId: 'tenant_real',
      tenantSlug: 'tenant-real',
      role: 'tenant_admin' as const,
    });

    const missingResponse = await handleGetMarketingJobStatus('job-log-missing', tenantLoader);
    const crossTenantResponse = await handleGetMarketingJobStatus(jobId, tenantLoader);
    const missingBody = (await missingResponse.json()) as Record<string, unknown>;
    const crossTenantBody = (await crossTenantResponse.json()) as Record<string, unknown>;

    assert.deepEqual(missingBody, crossTenantBody);
    assert.equal(warnings.length, 2);
    assert.equal(warnings[0]?.message, '[marketing-job-not-found]');
    assert.equal(warnings[0]?.details?.cause, 'runtime_doc_missing');
    assert.equal(warnings[1]?.message, '[marketing-job-not-found]');
    assert.equal(warnings[1]?.details?.cause, 'tenant_mismatch');
  });
});
