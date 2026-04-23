import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createMarketingJobRuntimeDocument, saveMarketingJobRuntime } from '../backend/marketing/runtime-state';
import { saveTenantBrandKit, tenantBrandKitPath, type TenantBrandKit } from '../backend/marketing/brand-kit';
import { handleGetMarketingReviewItem } from '../app/api/marketing/reviews/[reviewId]/route';
import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

async function withRuntimeEnv<T>(run: () => Promise<T>): Promise<T> {
  const previousCodeRoot = process.env.CODE_ROOT;
  const previousDataRoot = process.env.DATA_ROOT;
  const previousOpenClawLobsterCwd = process.env.OPENCLAW_LOBSTER_CWD;
  const previousStage1CacheDir = process.env.LOBSTER_STAGE1_CACHE_DIR;
  const previousStage2CacheDir = process.env.LOBSTER_STAGE2_CACHE_DIR;
  const previousStage3CacheDir = process.env.LOBSTER_STAGE3_CACHE_DIR;
  const previousStage4CacheDir = process.env.LOBSTER_STAGE4_CACHE_DIR;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-review-route-'));

  process.env.CODE_ROOT = PROJECT_ROOT;
  process.env.DATA_ROOT = dataRoot;
  process.env.OPENCLAW_LOBSTER_CWD = path.join(PROJECT_ROOT, 'lobster');
  process.env.LOBSTER_STAGE1_CACHE_DIR = path.join(dataRoot, 'lobster-stage1-cache');
  process.env.LOBSTER_STAGE2_CACHE_DIR = path.join(dataRoot, 'lobster-stage2-cache');
  process.env.LOBSTER_STAGE3_CACHE_DIR = path.join(dataRoot, 'lobster-stage3-cache');
  process.env.LOBSTER_STAGE4_CACHE_DIR = path.join(dataRoot, 'lobster-stage4-cache');

  try {
    return await run();
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

function makeTenantBrandKit(tenantId: string): TenantBrandKit {
  return {
    tenant_id: tenantId,
    source_url: `https://${tenantId}.example.com`,
    canonical_url: `https://${tenantId}.example.com`,
    brand_name: 'Brand Example',
    logo_urls: [`https://${tenantId}.example.com/logo.png`],
    colors: {
      primary: '#111111',
      secondary: '#f4f4f4',
      accent: '#c24d2c',
      palette: ['#111111', '#f4f4f4', '#c24d2c'],
    },
    font_families: ['Manrope'],
    external_links: [],
    extracted_at: '2026-04-23T00:00:00.000Z',
    brand_voice_summary: 'Direct and grounded.',
    offer_summary: 'Proof-led launch audit.',
  };
}

function saveApprovalReviewJob(jobId: string, tenantId: string): string {
  const brandKit = makeTenantBrandKit(tenantId);
  saveTenantBrandKit(tenantId, brandKit);

  const runtimeDoc = createMarketingJobRuntimeDocument({
    jobId,
    tenantId,
    payload: {
      businessName: 'Brand Example',
      brandUrl: brandKit.source_url,
    },
    brandKit: {
      path: tenantBrandKitPath(tenantId),
      ...brandKit,
    },
  });

  runtimeDoc.approvals.current = {
    stage: 'strategy',
    status: 'awaiting_approval',
    approval_id: `${jobId}_approval`,
    title: 'Strategy approval required',
    message: 'Continue to strategy.',
    requested_at: '2026-04-23T00:00:00.000Z',
    action_label: 'Review strategy',
  };

  saveMarketingJobRuntime(runtimeDoc.job_id, runtimeDoc);
  return `${jobId}::approval`;
}

function activeTenantContext(tenantId: string) {
  return async () => ({
    userId: 'user_active',
    tenantId,
    tenantSlug: tenantId,
    role: 'tenant_admin' as const,
  });
}

test('review route returns the review when it belongs to the active tenant', async () => {
  await withRuntimeEnv(async () => {
    const reviewId = saveApprovalReviewJob('mkt_review_current_tenant', 'tenant_current');

    const response = await handleGetMarketingReviewItem(
      encodeURIComponent(reviewId),
      activeTenantContext('tenant_current'),
    );
    const body = (await response.json()) as { review?: { id?: string } };

    assert.equal(response.status, 200);
    assert.equal(body.review?.id, reviewId);
  });
});

test('review route returns a recovery-oriented error when the review exists in another workspace', async () => {
  await withRuntimeEnv(async () => {
    const reviewId = saveApprovalReviewJob('mkt_review_wrong_workspace', 'tenant_expected');

    const response = await handleGetMarketingReviewItem(
      encodeURIComponent(reviewId),
      activeTenantContext('tenant_active'),
    );
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 409);
    assert.equal(body.error, 'review_not_in_current_workspace');
    assert.match(String(body.message), /different workspace/i);
  });
});

test('review route keeps unknown review ids on the 404 path even when another tenant owns unrelated runtime docs', async () => {
  await withRuntimeEnv(async () => {
    saveApprovalReviewJob('mkt_review_unrelated_other_tenant_job', 'tenant_expected');

    const response = await handleGetMarketingReviewItem(
      encodeURIComponent('mkt_review_unrelated_other_tenant_job::does-not-exist'),
      activeTenantContext('tenant_active'),
    );
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 404);
    assert.equal(body.error, 'review_not_found');
  });
});
