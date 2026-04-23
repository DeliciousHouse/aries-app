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

test('review route returns a recovery-oriented error when the review exists in another workspace', async () => {
  await withRuntimeEnv(async () => {
    const tenantId = 'tenant_expected';
    saveTenantBrandKit(tenantId, makeTenantBrandKit(tenantId));
    const runtimeDoc = createMarketingJobRuntimeDocument({
      jobId: 'mkt_review_wrong_workspace',
      tenantId,
      payload: {
        businessName: 'Brand Example',
        brandUrl: `https://${tenantId}.example.com`,
      },
      brandKit: {
        path: tenantBrandKitPath(tenantId),
        ...makeTenantBrandKit(tenantId),
      },
    });

    runtimeDoc.approvals.current = {
      stage: 'strategy',
      status: 'awaiting_approval',
      approval_id: 'mkta_wrong_workspace',
      title: 'Strategy approval required',
      message: 'Continue to strategy.',
      requested_at: '2026-04-23T00:00:00.000Z',
      action_label: 'Review strategy',
    };

    saveMarketingJobRuntime(runtimeDoc.job_id, runtimeDoc);

    const response = await handleGetMarketingReviewItem(
      'mkt_review_wrong_workspace%3A%3Aapproval',
      async () => ({
        userId: 'user_active',
        tenantId: 'tenant_active',
        tenantSlug: 'active',
        role: 'tenant_admin',
      }),
    );
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 409);
    assert.equal(body.error, 'review_not_in_current_workspace');
    assert.match(String(body.message), /different workspace/i);
  });
});
