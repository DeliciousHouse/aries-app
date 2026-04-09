import { readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { findMarketingAsset } from '@/backend/marketing/asset-library';
import { loadMarketingJobRuntime } from '@/backend/marketing/runtime-state';
import { resolveCodePath, resolveCodeRoot, resolveDataRoot } from '@/lib/runtime-paths';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

const MARKETING_ONBOARDING_REQUIRED = {
  status: 409,
  reason: 'onboarding_required',
  message: 'Complete tenant onboarding before viewing brand campaign assets.',
} as const;

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

function trustedRoots(): string[] {
  return Array.from(
    new Set(
      [
        resolveDataRoot(),
        resolveCodeRoot(),
        resolveCodePath('lobster'),
        process.env.OPENCLAW_LOCAL_LOBSTER_CWD?.trim(),
        process.env.OPENCLAW_LOBSTER_CWD?.trim(),
        process.env.LOBSTER_STAGE1_CACHE_DIR?.trim() || path.join(tmpdir(), 'lobster-stage1-cache'),
        process.env.LOBSTER_STAGE2_CACHE_DIR?.trim() || path.join(tmpdir(), 'lobster-stage2-cache'),
        process.env.LOBSTER_STAGE3_CACHE_DIR?.trim() || path.join(tmpdir(), 'lobster-stage3-cache'),
        process.env.LOBSTER_STAGE4_CACHE_DIR?.trim() || path.join(tmpdir(), 'lobster-stage4-cache'),
      ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    )
  );
}

function absoluteCompatibilityCandidates(filePath: string): string[] {
  const normalized = path.normalize(filePath);
  const candidates = new Set([normalized]);
  const codeRoot = path.normalize(resolveCodeRoot());
  const legacyCodeRoot = path.join(codeRoot, 'aries-app');

  if (normalized === legacyCodeRoot || normalized.startsWith(`${legacyCodeRoot}${path.sep}`)) {
    const suffix = normalized.slice(legacyCodeRoot.length);
    candidates.add(path.join(codeRoot, suffix));
  }

  return Array.from(candidates);
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
  const normalizedPath = normalizeAssetPath(filePath);
  if (!normalizedPath) {
    return null;
  }

  const roots = trustedRoots();
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
        return await readFile(resolvedCandidate);
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
