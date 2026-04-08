import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { loadCampaignWorkspaceRecord } from '@/backend/marketing/workspace-store';
import { resolveDataPath } from '@/lib/runtime-paths';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

const MARKETING_ONBOARDING_REQUIRED = {
  status: 409,
  reason: 'onboarding_required',
  message: 'Complete tenant onboarding before viewing campaign workspace assets.',
} as const;

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function handleGetMarketingWorkspaceAsset(
  jobId: string,
  assetId: string,
  tenantContextLoader?: TenantContextLoader,
) {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader, {
    missingMembershipResponse: MARKETING_ONBOARDING_REQUIRED,
  });
  if ('response' in tenantResult) {
    return tenantResult.response;
  }

  const record = loadCampaignWorkspaceRecord(jobId);
  if (!record) {
    return new Response(JSON.stringify({ error: 'Marketing workspace not found.', reason: 'marketing_workspace_not_found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (record.tenant_id !== tenantResult.tenantContext.tenantId) {
    return new Response(JSON.stringify({ error: 'Marketing asset not found.', reason: 'marketing_asset_not_found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  const asset = record.brief.brandAssets.find((entry) => entry.id === assetId);
  if (!asset) {
    return new Response(JSON.stringify({ error: 'Marketing asset not found.', reason: 'marketing_asset_not_found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  const trustedRoot = await realpath(resolveDataPath('generated', 'draft', 'marketing-workspaces')).catch(() =>
    resolveDataPath('generated', 'draft', 'marketing-workspaces'),
  );
  const resolvedPath = await realpath(asset.filePath).catch(() => null);
  if (!resolvedPath || !isWithinRoot(trustedRoot, resolvedPath)) {
    return new Response(JSON.stringify({ error: 'Marketing asset not found.', reason: 'marketing_asset_not_found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  const buffer = await readFile(resolvedPath).catch(() => null);
  if (!buffer) {
    return new Response(JSON.stringify({ error: 'Marketing asset not found.', reason: 'marketing_asset_not_found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  return new Response(buffer, {
    status: 200,
    headers: {
      'content-type': asset.contentType || 'application/octet-stream',
      'cache-control': 'private, max-age=60',
    },
  });
}
