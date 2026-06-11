import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { resolveCodeRoot, resolveDataRoot } from '@/lib/runtime-paths';

import { remapHostOutputToMount } from './host-output-path';

export type MarketingArtifactStageNumber = 1 | 2 | 3 | 4;

const DEFAULT_HOST_OUTPUT_MOUNT = '/hermes-output';

const STAGE_CACHE_DEFAULTS: Record<MarketingArtifactStageNumber, { envKey: string; folder: string }> = {
  1: { envKey: 'ARTIFACT_STAGE1_CACHE_DIR', folder: 'hermes-stage1-cache' },
  2: { envKey: 'ARTIFACT_STAGE2_CACHE_DIR', folder: 'hermes-stage2-cache' },
  3: { envKey: 'ARTIFACT_STAGE3_CACHE_DIR', folder: 'hermes-stage3-cache' },
  4: { envKey: 'ARTIFACT_STAGE4_CACHE_DIR', folder: 'hermes-stage4-cache' },
};

function stringValue(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.map((value) => stringValue(value)).filter(Boolean)));
}

/**
 * Returns the base directory that holds stage cache runs for a given stage,
 * before tenant scoping. Prefer `stageCacheRootForTenant` at call sites that
 * have a tenant in scope; this raw root remains exported for inference
 * fallbacks that scan the directory tree (the inference layer applies the
 * tenant filter itself).
 */
export function stageCacheRoot(stage: MarketingArtifactStageNumber): string {
  const config = STAGE_CACHE_DEFAULTS[stage];
  return stringValue(process.env[config.envKey]) || path.join(tmpdir(), config.folder);
}

/**
 * Tenant-scoped stage cache root: `<cacheRoot>/<tenantId>`.
 *
 * Two tenants targeting the same competitor (e.g. nike.com) used to collide
 * on `<cacheRoot>/<runId>/<step>.json` because runId derives from a slug of
 * the competitor URL. Inserting `<tenantId>` as a path segment makes the
 * filesystem layout itself tenant-isolated, complementing the runId
 * inference check in stage-artifact-resolution.ts.
 *
 * Fails closed when tenantId is empty/whitespace — background workers that
 * cannot resolve a tenant must not silently fall back to a shared root.
 */
export function stageCacheRootForTenant(
  stage: MarketingArtifactStageNumber,
  tenantId: string,
): string {
  const normalized = stringValue(tenantId);
  if (!normalized) {
    throw new Error(
      `stageCacheRootForTenant requires a non-empty tenantId (stage=${stage})`,
    );
  }
  return path.join(stageCacheRoot(stage), normalized);
}

export function hostOutputMount(): string {
  return path.normalize(stringValue(process.env.ARIES_HOST_ARTIFACT_OUTPUT_MOUNT) || DEFAULT_HOST_OUTPUT_MOUNT);
}

export function artifactRoots(): string[] {
  return uniqueStrings([
    process.env.ARTIFACT_PIPELINE_LOCAL_CWD,
    process.env.ARTIFACT_PIPELINE_CWD,
  ]).map((root) => path.resolve(root));
}

export function artifactOutputRoots(): string[] {
  return uniqueStrings([
    ...artifactRoots().map((root) => path.join(root, 'output')),
    hostOutputMount(),
  ]);
}

export function marketingAssetRoots(): string[] {
  return uniqueStrings([
    resolveDataRoot(),
    resolveCodeRoot(),
    process.env.ARTIFACT_PIPELINE_LOCAL_CWD,
    process.env.ARTIFACT_PIPELINE_CWD,
    hostOutputMount(),
    stageCacheRoot(1),
    stageCacheRoot(2),
    stageCacheRoot(3),
    stageCacheRoot(4),
  ]).map((root) => path.normalize(root));
}

function absoluteCompatibilityCandidates(filePath: string): string[] {
  const normalized = path.normalize(filePath);
  const codeRoot = path.normalize(resolveCodeRoot());
  const candidates = new Set([normalized]);
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

  const hostMountCandidate = remapHostOutputToMount(normalized);
  if (hostMountCandidate) {
    candidates.add(hostMountCandidate);
  }

  return Array.from(candidates);
}

function relativeGeneratedAssetPath(filePath: string): string | null {
  const segments = filePath.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) {
    return null;
  }
  if (segments.some((segment) => segment === '.' || segment === '..' || segment.includes('\0'))) {
    return null;
  }
  return path.join(...segments);
}

export function generatedAssetCandidates(filePath: string): string[] {
  const raw = stringValue(filePath);
  if (!raw) {
    return [];
  }

  const normalized = path.normalize(raw);
  if (path.isAbsolute(normalized)) {
    return absoluteCompatibilityCandidates(normalized);
  }

  const relativePath = relativeGeneratedAssetPath(raw);
  if (!relativePath) {
    return [];
  }

  return marketingAssetRoots().map((root) => path.resolve(root, relativePath));
}

function resolvedPath(filePath: string): string | null {
  try {
    return realpathSync(filePath);
  } catch {
    return existsSync(filePath) ? path.resolve(filePath) : null;
  }
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isTrustedGeneratedAssetPath(candidate: string): boolean {
  const resolvedCandidate = resolvedPath(candidate);
  if (!resolvedCandidate) {
    return false;
  }

  for (const root of marketingAssetRoots()) {
    const resolvedRoot = resolvedPath(root) || path.resolve(root);
    if (isWithinRoot(resolvedRoot, resolvedCandidate)) {
      return true;
    }
  }

  return false;
}

export function resolveGeneratedAsset(filePath: string | null | undefined): string | null {
  const raw = stringValue(filePath);
  if (!raw) {
    return null;
  }

  for (const candidate of generatedAssetCandidates(raw)) {
    if (existsSync(candidate) && isTrustedGeneratedAssetPath(candidate)) {
      return candidate;
    }
  }

  return null;
}
