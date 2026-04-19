import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { loadCampaignWorkspaceRecord } from '@/backend/marketing/workspace-store';
import { resolveCodeRoot, resolveDataPath } from '@/lib/runtime-paths';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

const MARKETING_ONBOARDING_REQUIRED = {
  status: 409,
  reason: 'onboarding_required',
  message: 'Complete tenant onboarding before viewing campaign workspace assets.',
} as const;

const ASSET_NOT_FOUND_BODY = JSON.stringify({
  error: 'Marketing asset not found.',
  reason: 'marketing_asset_not_found',
});

function assetNotFoundResponse(
  jobId: string,
  assetId: string,
  cause:
    | 'tenant_mismatch'
    | 'asset_descriptor_missing'
    | 'asset_file_outside_allowed_root'
    | 'asset_file_read_failed',
): Response {
  console.warn('[marketing-workspace-asset-not-found]', { jobId, assetId, cause });
  return new Response(ASSET_NOT_FOUND_BODY, {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

type NormalizedAssetPath =
  | { kind: 'relative'; path: string }
  | { kind: 'absolute'; path: string };

function normalizeAssetPath(filePath: string): NormalizedAssetPath | null {
  const trimmed = filePath.trim();
  if (!trimmed) {
    return null;
  }

  if (path.isAbsolute(trimmed)) {
    return {
      kind: 'absolute',
      path: path.normalize(trimmed),
    };
  }

  const segments = trimmed.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')) {
    return null;
  }

  return {
    kind: 'relative',
    path: path.join(...segments),
  };
}

function trustedWorkspaceRoots(): string[] {
  const codeRoot = path.normalize(resolveCodeRoot());
  return Array.from(
    new Set([
      resolveDataPath('generated', 'draft', 'marketing-workspaces'),
      path.join(codeRoot, 'generated', 'draft', 'marketing-workspaces'),
      path.join(codeRoot, 'aries-app', 'generated', 'draft', 'marketing-workspaces'),
    ]),
  );
}

function absoluteCompatibilityCandidates(filePath: string): string[] {
  const normalized = path.normalize(filePath);
  const candidates = new Set([normalized]);
  const codeRoot = path.normalize(resolveCodeRoot());
  const remapPrefixes = [
    '/home/node/workspace/aries-app',
    '/app/aries-app',
    path.join(codeRoot, 'aries-app'),
  ].map((prefix) => path.normalize(prefix));

  for (const prefix of remapPrefixes) {
    if (normalized !== prefix && !normalized.startsWith(`${prefix}${path.sep}`)) {
      continue;
    }

    const suffix = normalized.slice(prefix.length).replace(/^[\\/]+/, '');
    candidates.add(path.join(codeRoot, suffix));
  }

  return Array.from(candidates);
}

async function resolveWorkspaceAssetPath(filePath: string): Promise<string | null> {
  const normalizedPath = normalizeAssetPath(filePath);
  if (!normalizedPath) {
    return null;
  }

  const roots = trustedWorkspaceRoots();
  const candidates =
    normalizedPath.kind === 'absolute'
      ? absoluteCompatibilityCandidates(normalizedPath.path)
      : roots.map((root) => path.resolve(root, normalizedPath.path));

  for (const candidate of candidates) {
    for (const root of roots) {
      if (!isWithinRoot(root, candidate)) {
        continue;
      }
      try {
        const [resolvedRoot, resolvedCandidate] = await Promise.all([
          realpath(root).catch(() => root),
          realpath(candidate),
        ]);
        if (!isWithinRoot(resolvedRoot, resolvedCandidate)) {
          continue;
        }
        return resolvedCandidate;
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
  }

  return null;
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
    return assetNotFoundResponse(jobId, assetId, 'tenant_mismatch');
  }

  const asset = record.brief.brandAssets.find((entry) => entry.id === assetId);
  if (!asset) {
    return assetNotFoundResponse(jobId, assetId, 'asset_descriptor_missing');
  }

  const resolvedPath = await resolveWorkspaceAssetPath(asset.filePath);
  if (!resolvedPath) {
    return assetNotFoundResponse(jobId, assetId, 'asset_file_outside_allowed_root');
  }

  const buffer = await readFile(resolvedPath).catch(() => null);
  if (!buffer) {
    return assetNotFoundResponse(jobId, assetId, 'asset_file_read_failed');
  }

  return new Response(buffer, {
    status: 200,
    headers: {
      'content-type': asset.contentType || 'application/octet-stream',
      'cache-control': 'private, max-age=60',
    },
  });
}
