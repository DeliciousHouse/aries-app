import { findMarketingAsset } from '@/backend/marketing/asset-library';
import { readMarketingAssetWithinAllowedRoots } from '@/backend/marketing/asset-read';
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
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader, {
    missingMembershipResponse: MARKETING_ONBOARDING_REQUIRED,
  });
  if ('response' in tenantResult) {
    return tenantResult.response;
  }

  const runtimeDoc = loadMarketingJobRuntime(jobId);
  if (!runtimeDoc) {
    return new Response(JSON.stringify({ error: 'Marketing job not found.', reason: 'marketing_job_not_found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (runtimeDoc.tenant_id !== tenantResult.tenantContext.tenantId) {
    return new Response(JSON.stringify({ error: 'Marketing asset not found.', reason: 'marketing_asset_not_found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  const asset = findMarketingAsset(jobId, runtimeDoc, assetId);
  if (!asset) {
    return new Response(JSON.stringify({ error: 'Marketing asset not found.', reason: 'marketing_asset_not_found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  const buffer = await readMarketingAssetWithinAllowedRoots(asset.filePath);
  if (!buffer) {
    return new Response(JSON.stringify({ error: 'Marketing asset not found.', reason: 'marketing_asset_not_found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  // `inline` (not `attachment`) keeps the browser from surprise-downloading
  // unknown or markdown-ish content when this route is hit directly. The
  // /materials/[jobId]/[assetId] viewer is the polished default for
  // document-kind attachments; this raw route remains available for image
  // rendering and for the "Download source" affordance in the viewer.
  return new Response(buffer, {
    status: 200,
    headers: {
      'content-type': asset.contentType,
      'content-disposition': 'inline',
      'cache-control': 'private, max-age=60',
    },
  });
}
