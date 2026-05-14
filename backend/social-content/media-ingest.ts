import { copyFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

import { resolveDataRoot, resolveDraftRoot } from '@/lib/runtime-paths';

type UnknownRecord = Record<string, unknown>;

type MediaRewrite = {
  from: string;
  to: string;
};

export type SocialContentVideoIngestResult = {
  rewrites: MediaRewrite[];
  skipped: Array<{ path: string; reason: 'not_allowed' | 'missing' | 'invalid' }>;
};

function recordValue(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function recordArray(value: unknown): UnknownRecord[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is UnknownRecord => !!entry && typeof entry === 'object' && !Array.isArray(entry))
    : [];
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function slug(value: string, fallback: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function sourceRoots(): string[] {
  const roots = [
    process.env.HERMES_MEDIA_CACHE_DIR,
    process.env.HERMES_CACHE_DIR,
    path.join(homedir(), '.hermes'),
    path.join(tmpdir(), 'hermes'),
    resolveDataRoot(),
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => path.resolve(value));

  return Array.from(new Set(roots));
}

function resolveAllowedSource(filePath: string): { ok: true; resolved: string } | { ok: false; reason: 'not_allowed' | 'missing' | 'invalid' } {
  const raw = stringValue(filePath);
  if (!raw || !path.isAbsolute(raw)) {
    return { ok: false, reason: 'invalid' };
  }

  const normalized = path.resolve(raw);
  let resolved: string;
  try {
    resolved = realpathSync(normalized);
  } catch {
    return existsSync(normalized)
      ? { ok: false, reason: 'not_allowed' }
      : { ok: false, reason: 'missing' };
  }

  for (const root of sourceRoots()) {
    let resolvedRoot = root;
    try {
      resolvedRoot = realpathSync(root);
    } catch {
      resolvedRoot = root;
    }
    if (isWithinRoot(resolvedRoot, resolved)) {
      return { ok: true, resolved };
    }
  }

  return { ok: false, reason: 'not_allowed' };
}

function videoDestination(jobId: string, baseName: string): string {
  return path.join(resolveDraftRoot(), 'jobs', jobId, 'videos', `${baseName}.mp4`);
}

function posterDestination(jobId: string, baseName: string, ext: string): string {
  return path.join(resolveDraftRoot(), 'jobs', jobId, 'videos', `${baseName}-poster${ext}`);
}

function copyDeterministic(source: string, destination: string, result: SocialContentVideoIngestResult): string {
  mkdirSync(path.dirname(destination), { recursive: true });
  if (path.resolve(source) !== path.resolve(destination)) {
    copyFileSync(source, destination);
  }
  result.rewrites.push({ from: source, to: destination });
  return destination;
}

function firstDefinedPath(record: UnknownRecord, keys: string[]): { key: string; value: string } | null {
  for (const key of keys) {
    const value = stringValue(record[key]);
    if (value) {
      return { key, value };
    }
  }
  return null;
}

function ingestVariantMedia(jobId: string, contract: UnknownRecord, variant: UnknownRecord, result: SocialContentVideoIngestResult): void {
  const platformSlug = slug(
    stringValue(contract.platform_slug) || stringValue(contract.canonical_platform_slug) || stringValue(contract.platform),
    'platform',
  );
  const familyId = slug(stringValue(variant.family_id) || stringValue(variant.family_name), 'variant');
  const baseName = `${platformSlug}-${familyId}`;

  const videoRef = firstDefinedPath(variant, [
    'video_path',
    'rendered_video_path',
    'video_file',
    'rendered_video_file',
  ]);
  if (videoRef) {
    const resolved = resolveAllowedSource(videoRef.value);
    if (resolved.ok && path.extname(resolved.resolved).toLowerCase() === '.mp4') {
      const destination = copyDeterministic(resolved.resolved, videoDestination(jobId, baseName), result);
      variant[videoRef.key] = destination;
    } else {
      result.skipped.push({ path: videoRef.value, reason: resolved.ok ? 'invalid' : resolved.reason });
    }
  }

  const posterRef = firstDefinedPath(variant, [
    'poster_path',
    'poster_file',
    'thumbnail_path',
    'thumbnail_file',
    'thumbnail_image_path',
  ]);
  if (posterRef) {
    const resolved = resolveAllowedSource(posterRef.value);
    const ext = resolved.ok ? path.extname(resolved.resolved).toLowerCase() : '';
    if (resolved.ok && (ext === '.jpg' || ext === '.jpeg' || ext === '.png' || ext === '.webp')) {
      const destination = copyDeterministic(resolved.resolved, posterDestination(jobId, baseName, ext), result);
      variant[posterRef.key] = destination;
      if (posterRef.key.startsWith('thumbnail')) {
        variant.poster_path = destination;
      }
    } else {
      result.skipped.push({ path: posterRef.value, reason: resolved.ok ? 'invalid' : resolved.reason });
    }
  }
}

function ingestOutputRecord(jobId: string, output: UnknownRecord, result: SocialContentVideoIngestResult): void {
  const videoAssets = recordValue(output.video_assets);
  const platformContracts = recordArray(videoAssets?.platform_contracts);
  for (const contract of platformContracts) {
    const variants = recordArray(contract.rendered_video_variants);
    for (const variant of variants) {
      ingestVariantMedia(jobId, contract, variant, result);
    }
  }
}

export function ingestSocialContentVideoRenderOutput(
  jobId: string,
  output: unknown,
): SocialContentVideoIngestResult {
  const result: SocialContentVideoIngestResult = {
    rewrites: [],
    skipped: [],
  };

  if (!jobId.trim()) {
    return result;
  }

  if (Array.isArray(output)) {
    for (const entry of output) {
      const record = recordValue(entry);
      if (record) {
        ingestOutputRecord(jobId, record, result);
      }
    }
    return result;
  }

  const record = recordValue(output);
  if (record) {
    ingestOutputRecord(jobId, record, result);
  }

  return result;
}
