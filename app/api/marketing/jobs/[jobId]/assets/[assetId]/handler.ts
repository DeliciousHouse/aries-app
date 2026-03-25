import { readFile } from 'node:fs/promises';

import { findMarketingAsset } from '@/backend/marketing/asset-library';
import { loadMarketingJobRuntime } from '@/backend/marketing/runtime-state';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

const MARKETING_ONBOARDING_REQUIRED = {
  status: 409,
  reason: 'onboarding_required',
  message: 'Complete tenant onboarding before viewing brand campaign assets.',
} as const;

export async function handleGetMarketingJobAsset(
  jobId: string,
  assetId: string,
  tenantContextLoader?: TenantContextLoader
) {
  const statusPublic = process.env.MARKETING_STATUS_PUBLIC === '1' || process.env.MARKETING_STATUS_PUBLIC === 'true';

  if (!statusPublic) {
    const tenantResult = await loadTenantContextOrResponse(tenantContextLoader, {
      missingMembershipResponse: MARKETING_ONBOARDING_REQUIRED,
    });
    if ('response' in tenantResult) {
      return tenantResult.response;
    }
  }

  const runtimeDoc = loadMarketingJobRuntime(jobId);
  if (!runtimeDoc) {
    return new Response(JSON.stringify({ error: 'Marketing job not found.', reason: 'marketing_job_not_found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (!statusPublic) {
    const tenantResult = await loadTenantContextOrResponse(tenantContextLoader, {
      missingMembershipResponse: MARKETING_ONBOARDING_REQUIRED,
    });
    if (!('response' in tenantResult) && runtimeDoc.tenant_id !== tenantResult.tenantContext.tenantId) {
      return new Response(JSON.stringify({ error: 'Marketing asset not found.', reason: 'marketing_asset_not_found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
  }

  const asset = findMarketingAsset(jobId, runtimeDoc, assetId);
  if (!asset) {
    return new Response(JSON.stringify({ error: 'Marketing asset not found.', reason: 'marketing_asset_not_found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  const buffer = await readFile(asset.filePath);
  return new Response(buffer, {
    status: 200,
    headers: {
      'content-type': asset.contentType,
      'cache-control': 'private, max-age=60',
    },
  });
}
