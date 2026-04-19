import { findMarketingAsset } from '@/backend/marketing/asset-library';
import { readMarketingAssetWithinAllowedRoots } from '@/backend/marketing/asset-read';
import { loadMarketingJobRuntime } from '@/backend/marketing/runtime-state';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

const MARKETING_ONBOARDING_REQUIRED = {
  status: 409,
  reason: 'onboarding_required',
  message: 'Complete tenant onboarding before viewing brand campaign assets.',
} as const;

const ASSET_NOT_FOUND_BODY = JSON.stringify({
  error: 'Marketing asset not found.',
  reason: 'marketing_asset_not_found',
});

function assetNotFoundResponse(
  jobId: string,
  assetId: string,
  cause: 'tenant_mismatch' | 'asset_descriptor_missing' | 'asset_file_missing',
): Response {
  // Branch-distinguishing log so operators can tell which of the three 404
  // paths fired without leaking internal state to the client (the response
  // body intentionally stays an opaque `marketing_asset_not_found`).
  console.warn('[marketing-asset-not-found]', { jobId, assetId, cause });
  return new Response(ASSET_NOT_FOUND_BODY, {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });
}

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
    return assetNotFoundResponse(jobId, assetId, 'tenant_mismatch');
  }

  const asset = findMarketingAsset(jobId, runtimeDoc, assetId);
  if (!asset) {
    return assetNotFoundResponse(jobId, assetId, 'asset_descriptor_missing');
  }

  const buffer = await readMarketingAssetWithinAllowedRoots(asset.filePath);
  if (!buffer) {
    return assetNotFoundResponse(jobId, assetId, 'asset_file_missing');
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
