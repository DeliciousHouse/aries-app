import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  getMarketingJobStatusCached,
  getMarketingJobStatusCacheSizeForTests,
  invalidateMarketingJobStatus,
  overrideMarketingJobStatusBuilderForTests,
  resetMarketingJobStatusCacheForTests,
  type MarketingJobStatusResponse,
} from '../backend/marketing/jobs-status';
import { handleGetMarketingJobStatus } from '../app/api/marketing/jobs/[jobId]/handler';
import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;

function buildPayload(jobId: string, tenantId: string, sequence: number): MarketingJobStatusResponse {
  return {
    jobId,
    tenantId,
    tenantName: `${tenantId}-name`,
    brandWebsiteUrl: null,
    campaignWindow: null,
    durationDays: null,
    plannedPostCount: null,
    createdPostCount: sequence,
    assetPreviewCards: [],
    calendarEvents: [],
    state: 'running',
    status: 'ok',
    currentStage: 'strategy',
    stageStatus: { research: 'completed', strategy: 'in_progress', production: 'not_started', publish: 'not_started' },
    updatedAt: null,
    approvalRequired: false,
    needsAttention: false,
    summary: {
      headline: `headline-${sequence}`,
      subheadline: `subheadline-${sequence}`,
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
    nextStep: 'wait_for_completion',
    repairStatus: 'not_required',
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function withRuntimeEnv<T>(run: () => Promise<T>): Promise<T> {
  const previousCodeRoot = process.env.CODE_ROOT;
  const previousDataRoot = process.env.DATA_ROOT;
  const previousOpenClawLobsterCwd = process.env.OPENCLAW_LOBSTER_CWD;
  const previousGatewayLobsterCwd = process.env.OPENCLAW_GATEWAY_LOBSTER_CWD;
  const previousStage1CacheDir = process.env.LOBSTER_STAGE1_CACHE_DIR;
  const previousStage2CacheDir = process.env.LOBSTER_STAGE2_CACHE_DIR;
  const previousStage3CacheDir = process.env.LOBSTER_STAGE3_CACHE_DIR;
  const previousStage4CacheDir = process.env.LOBSTER_STAGE4_CACHE_DIR;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-marketing-cache-'));

  process.env.CODE_ROOT = PROJECT_ROOT;
  process.env.DATA_ROOT = dataRoot;
  process.env.OPENCLAW_LOBSTER_CWD = path.join(PROJECT_ROOT, 'lobster');
  process.env.OPENCLAW_GATEWAY_LOBSTER_CWD = 'lobster';
  process.env.LOBSTER_STAGE1_CACHE_DIR = path.join(dataRoot, 'lobster-stage1-cache');
  process.env.LOBSTER_STAGE2_CACHE_DIR = path.join(dataRoot, 'lobster-stage2-cache');
  process.env.LOBSTER_STAGE3_CACHE_DIR = path.join(dataRoot, 'lobster-stage3-cache');
  process.env.LOBSTER_STAGE4_CACHE_DIR = path.join(dataRoot, 'lobster-stage4-cache');

  try {
    return await run();
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
  console.log = () => {};
  console.warn = () => {};
});

test.afterEach(() => {
  resetMarketingJobStatusCacheForTests();
  console.log = originalConsoleLog;
  console.warn = originalConsoleWarn;
});

test('cold read returns miss and populates cache', async () => {
  let calls = 0;
  overrideMarketingJobStatusBuilderForTests(async (tenantId, jobId) => {
    calls += 1;
    await delay(50);
    return buildPayload(jobId, tenantId, calls);
  });

  const result = await getMarketingJobStatusCached('tenant-a', 'job-1');

  assert.equal(result.cacheStatus, 'miss');
  assert.equal(result.payload.jobId, 'job-1');
  assert.equal(calls, 1);
});

test('warm read within TTL returns hit without rebuilding', async () => {
  let calls = 0;
  overrideMarketingJobStatusBuilderForTests(async (tenantId, jobId) => {
    calls += 1;
    await delay(50);
    return buildPayload(jobId, tenantId, calls);
  });

  const first = await getMarketingJobStatusCached('tenant-a', 'job-1', 1_000);
  const second = await getMarketingJobStatusCached('tenant-a', 'job-1', 1_500);

  assert.equal(first.cacheStatus, 'miss');
  assert.equal(second.cacheStatus, 'hit');
  assert.equal(second.payload.createdPostCount, 1);
  assert.equal(calls, 1);
});

test('single-flight collapses eight parallel cold reads for the same key', async () => {
  let calls = 0;
  overrideMarketingJobStatusBuilderForTests(async (tenantId, jobId) => {
    calls += 1;
    await delay(50);
    return buildPayload(jobId, tenantId, calls);
  });

  const results = await Promise.all(
    Array.from({ length: 8 }, () => getMarketingJobStatusCached('tenant-a', 'job-1')),
  );

  assert.equal(calls, 1);
  assert.equal(results.filter((entry) => entry.cacheStatus === 'miss').length, 1);
  assert.equal(results.filter((entry) => entry.cacheStatus === 'inflight').length, 7);
});

test('parallel different keys compute independently', async () => {
  let calls = 0;
  overrideMarketingJobStatusBuilderForTests(async (tenantId, jobId) => {
    calls += 1;
    await delay(50);
    return buildPayload(jobId, tenantId, calls);
  });

  const startedAt = performance.now();
  const results = await Promise.all([
    getMarketingJobStatusCached('tenant-a', 'job-a'),
    getMarketingJobStatusCached('tenant-a', 'job-b'),
    getMarketingJobStatusCached('tenant-a', 'job-c'),
  ]);
  const elapsedMs = performance.now() - startedAt;

  assert.equal(calls, 3);
  assert.deepEqual(
    results.map((entry) => entry.payload.jobId).sort(),
    ['job-a', 'job-b', 'job-c'],
  );
  assert.ok(elapsedMs < 140, `expected parallel execution under 140ms, got ${elapsedMs.toFixed(1)}ms`);
});

test('TTL expiry forces a rebuild', async () => {
  let calls = 0;
  overrideMarketingJobStatusBuilderForTests(async (tenantId, jobId) => {
    calls += 1;
    return buildPayload(jobId, tenantId, calls);
  });

  const first = await getMarketingJobStatusCached('tenant-a', 'job-1', 1_000);
  const second = await getMarketingJobStatusCached('tenant-a', 'job-1', 11_001);

  assert.equal(first.cacheStatus, 'miss');
  assert.equal(second.cacheStatus, 'miss');
  assert.equal(second.payload.createdPostCount, 2);
  assert.equal(calls, 2);
});

test('invalidation clears a cached entry and returns fresh data', async () => {
  let calls = 0;
  overrideMarketingJobStatusBuilderForTests(async (tenantId, jobId) => {
    calls += 1;
    return buildPayload(jobId, tenantId, calls);
  });

  const first = await getMarketingJobStatusCached('tenant-a', 'job-1');
  invalidateMarketingJobStatus('job-1');
  const second = await getMarketingJobStatusCached('tenant-a', 'job-1');

  assert.equal(first.cacheStatus, 'miss');
  assert.equal(second.cacheStatus, 'miss');
  assert.equal(second.payload.createdPostCount, 2);
  assert.equal(calls, 2);
});

test('tenant isolation keeps same job id separate and invalidation clears both tenants', async () => {
  let calls = 0;
  overrideMarketingJobStatusBuilderForTests(async (tenantId, jobId) => {
    calls += 1;
    return buildPayload(jobId, tenantId, calls);
  });

  const tenantAFirst = await getMarketingJobStatusCached('tenant-a', 'job-1');
  const tenantBFirst = await getMarketingJobStatusCached('tenant-b', 'job-1');
  const tenantAHit = await getMarketingJobStatusCached('tenant-a', 'job-1');
  const tenantBHit = await getMarketingJobStatusCached('tenant-b', 'job-1');

  invalidateMarketingJobStatus('job-1');

  const tenantASecond = await getMarketingJobStatusCached('tenant-a', 'job-1');
  const tenantBSecond = await getMarketingJobStatusCached('tenant-b', 'job-1');

  assert.equal(tenantAFirst.cacheStatus, 'miss');
  assert.equal(tenantBFirst.cacheStatus, 'miss');
  assert.equal(tenantAHit.cacheStatus, 'hit');
  assert.equal(tenantBHit.cacheStatus, 'hit');
  assert.equal(tenantASecond.cacheStatus, 'miss');
  assert.equal(tenantBSecond.cacheStatus, 'miss');
  assert.equal(calls, 4);
});

test('memory cap evicts the oldest cache entry', async () => {
  let calls = 0;
  overrideMarketingJobStatusBuilderForTests(async (tenantId, jobId) => {
    calls += 1;
    return buildPayload(jobId, tenantId, calls);
  });

  for (let index = 0; index < 1_001; index += 1) {
    await getMarketingJobStatusCached('tenant-a', `job-${index}`, 1_000);
  }

  assert.ok(getMarketingJobStatusCacheSizeForTests() <= 1_000);

  const newest = await getMarketingJobStatusCached('tenant-a', 'job-1000', 1_500);
  const oldest = await getMarketingJobStatusCached('tenant-a', 'job-0', 1_500);

  assert.equal(newest.cacheStatus, 'hit');
  assert.equal(oldest.cacheStatus, 'miss');
  assert.equal(calls, 1_002);
});

test('marketing job route does not cache unknown jobs and returns 404 for repeat requests', async () => {
  await withRuntimeEnv(async () => {
    let calls = 0;
    overrideMarketingJobStatusBuilderForTests(async (tenantId, jobId) => {
      calls += 1;
      return buildPayload(jobId, tenantId, calls);
    });

    const tenantContextLoader = async () => ({
      userId: 'user-cache-test',
      tenantId: 'tenant-cache-test',
      tenantSlug: 'tenant-cache-test',
      role: 'tenant_admin' as const,
    });

    const first = await handleGetMarketingJobStatus('missing-job', tenantContextLoader);
    const second = await handleGetMarketingJobStatus('missing-job', tenantContextLoader);

    assert.equal(first.status, 404);
    assert.equal(first.headers.get('x-cache'), null);
    assert.equal(second.status, 404);
    assert.equal(second.headers.get('x-cache'), null);
    assert.equal(calls, 0);
    assert.equal(getMarketingJobStatusCacheSizeForTests(), 0);
  });
});
