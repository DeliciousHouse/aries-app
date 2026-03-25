import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { findMarketingAsset } from '@/backend/marketing/asset-library';
import { loadMarketingJobRuntime } from '@/backend/marketing/runtime-state';
import { resolveCodePath, resolveDataRoot } from '@/lib/runtime-paths';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

const MARKETING_ONBOARDING_REQUIRED = {
  status: 409,
  reason: 'onboarding_required',
  message: 'Complete tenant onboarding before viewing brand campaign assets.',
} as const;

/**
 * Normalizes a runtime-derived asset path into a safe relative path.
 * Rejects empty input, absolute paths, and any "." / ".." segments so the
 * handler never resolves a path that can escape the trusted asset roots.
 */
function normalizeRelativeAssetPath(filePath: string): string | null {
  const trimmed = filePath.trim();
  if (!trimmed || path.isAbsolute(trimmed)) {
    return null;
  }

  const segments = trimmed.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')) {
    return null;
  }

  return path.join(...segments);
}

/**
 * Returns true only when the resolved candidate stays within the provided
 * root directory. Paths that escape upward or resolve to another absolute
 * location are rejected.
 */
function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function readAssetWithinAllowedRoots(filePath: string): Promise<Buffer | null> {
  const relativePath = normalizeRelativeAssetPath(filePath);
  if (!relativePath) {
    return null;
  }

  const roots = [resolveDataRoot(), resolveCodePath('lobster')];
  for (const root of roots) {
    const candidate = path.resolve(root, relativePath);
    if (!isWithinRoot(root, candidate)) {
      continue;
    }
    try {
      return await readFile(candidate);
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR')
      ) {
        continue;
      }
      throw error;
    }
  }

  return null;
}

export async function handleGetMarketingJobAsset(
  jobId: string,
  assetId: string,
  tenantContextLoader?: TenantContextLoader
) {
  const statusPublic = process.env.MARKETING_STATUS_PUBLIC === '1' || process.env.MARKETING_STATUS_PUBLIC === 'true';
  const tenantResult = statusPublic
    ? null
    : await loadTenantContextOrResponse(tenantContextLoader, {
        missingMembershipResponse: MARKETING_ONBOARDING_REQUIRED,
      });

  if (tenantResult) {
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

  if (tenantResult && runtimeDoc.tenant_id !== tenantResult.tenantContext.tenantId) {
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

  const buffer = await readAssetWithinAllowedRoots(asset.filePath);
  if (!buffer) {
    return new Response(JSON.stringify({ error: 'Marketing asset not found.', reason: 'marketing_asset_not_found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  return new Response(buffer, {
    status: 200,
    headers: {
      'content-type': asset.contentType,
      'cache-control': 'private, max-age=60',
    },
  });
}
