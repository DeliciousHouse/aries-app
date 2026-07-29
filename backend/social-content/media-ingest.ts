import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

import { resolveDraftRoot } from '@/lib/runtime-paths';

type UnknownRecord = Record<string, unknown>;

type MediaRewrite = {
  from: string;
  to: string;
};

export type SocialContentVideoIngestResult = {
  rewrites: MediaRewrite[];
  skipped: Array<{ path: string; reason: 'not_allowed' | 'missing' | 'invalid' }>;
  reportedCount: number;
  ingestedCount: number;
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

const MAX_SLUG_INPUT_LENGTH = 256;
// The asset handler caps route IDs at 200 bytes. Reserving `video-` and
// `-poster` leaves 187 bytes for the shared on-disk key while remaining well
// below the common 255-byte filesystem component limit.
const MAX_VIDEO_FILESYSTEM_KEY_LENGTH = 187;
const VIDEO_KEY_HASH_LENGTH = 32;

function slug(value: string, fallback: string): string {
  // Cap input length before regex to prevent ReDoS on pathological inputs.
  const capped = value.length > MAX_SLUG_INPUT_LENGTH ? value.slice(0, MAX_SLUG_INPUT_LENGTH) : value;
  const lowered = capped.toLowerCase();
  // Replace non-alphanumeric runs with a single dash, then strip leading/trailing
  // dashes with two anchored replacements that each scan at most once — avoiding
  // the ambiguous alternation /^-+|-+$/g which can cause polynomial backtracking.
  const dashed = lowered.replace(/[^a-z0-9]+/g, '-');
  const trimmedStart = dashed.replace(/^-+/, '');
  const normalized = trimmedStart.replace(/-+$/, '');
  return normalized || fallback;
}

/**
 * Build one portable filename key from the original artifact identity. The
 * readable stem is bounded ASCII; the 128-bit SHA-256 prefix keeps identities
 * that normalize to the same slug (for example `clip/a` and `clip-a`) distinct.
 * 187 bytes keeps both `video-${key}-poster` route IDs and generated filenames
 * within their respective 200-byte route and 255-byte filesystem limits.
 */
function videoFilesystemKey(
  identityParts: string[],
  fallback: string,
  collisionIdentityParts: string[] = identityParts,
): string {
  const identity = JSON.stringify(collisionIdentityParts.map((part) => stringValue(part)));
  const suffix = createHash('sha256').update(identity || fallback).digest('hex').slice(0, VIDEO_KEY_HASH_LENGTH);
  const maxStemLength = MAX_VIDEO_FILESYSTEM_KEY_LENGTH - VIDEO_KEY_HASH_LENGTH - 1;
  const readable = slug(identityParts.filter(Boolean).join('-'), fallback)
    .slice(0, maxStemLength)
    .replace(/-+$/, '') || fallback;
  return `${readable}-${suffix}`;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function expandHermesCacheRoots(root: string): string[] {
  const normalized = path.resolve(root);
  const baseName = path.basename(normalized).toLowerCase();
  if (baseName === 'videos' || baseName === 'images') {
    return [normalized];
  }
  if (baseName === 'cache') {
    return [
      path.join(normalized, 'videos'),
      path.join(normalized, 'images'),
    ];
  }

  return [
    path.join(normalized, 'cache', 'videos'),
    path.join(normalized, 'cache', 'images'),
    path.join(normalized, 'videos'),
    path.join(normalized, 'images'),
  ];
}

function sourceRoots(): string[] {
  const cacheRoots = [
    process.env.HERMES_MEDIA_CACHE_DIR,
    process.env.HERMES_CACHE_DIR,
    path.join(homedir(), '.hermes', 'cache'),
    path.join(tmpdir(), 'hermes', 'cache'),
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .flatMap((value) => expandHermesCacheRoots(value));

  const mountedVideoRoot = stringValue(process.env.HERMES_VIDEO_CACHE_MOUNT);
  const roots = mountedVideoRoot
    ? [path.resolve(mountedVideoRoot), ...cacheRoots]
    : cacheRoots;

  return Array.from(new Set(roots));
}

function remapHermesVideoCachePath(filePath: string): string {
  const mountedVideoRoot = stringValue(process.env.HERMES_VIDEO_CACHE_MOUNT);
  if (!mountedVideoRoot) return filePath;
  const normalized = filePath.replaceAll('\\', '/');
  const match = normalized.match(
    /^\/home\/node\/\.hermes\/(?:profiles\/[^/]+\/)?cache\/videos\/([^/]+)$/,
  );
  if (!match || match[1] === '.' || match[1] === '..') return filePath;
  return path.join(mountedVideoRoot, match[1]);
}

function resolveAllowedSource(
  filePath: string,
  exactAllowedDestinations: string[] = [],
): { ok: true; resolved: string } | { ok: false; reason: 'not_allowed' | 'missing' | 'invalid' } {
  const raw = stringValue(filePath);
  if (!raw || !path.isAbsolute(raw)) {
    return { ok: false, reason: 'invalid' };
  }

  const normalized = path.resolve(remapHermesVideoCachePath(raw));
  const exactAllowed = new Set(exactAllowedDestinations.map((candidate) => path.resolve(candidate)));
  if (exactAllowed.has(normalized)) {
    return existsSync(normalized)
      ? { ok: true, resolved: normalized }
      : { ok: false, reason: 'missing' };
  }

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

function servedAssetUrl(jobId: string, assetId: string): string {
  return `/api/marketing/jobs/${encodeURIComponent(jobId)}/assets/${encodeURIComponent(assetId)}`;
}

function exactAllowedVideoDestinations(jobId: string, ...baseNames: string[]): string[] {
  return baseNames.map((baseName) => videoDestination(jobId, baseName));
}

function exactAllowedPosterDestinations(jobId: string, ...baseNames: string[]): string[] {
  return baseNames.flatMap((baseName) => (
    ['.jpg', '.jpeg', '.png', '.webp'].map((ext) => posterDestination(jobId, baseName, ext))
  ));
}

function exactDestinationPath(resolvedPath: string, candidates: string[]): string | null {
  const normalized = path.resolve(resolvedPath);
  return candidates.find((candidate) => path.resolve(candidate) === normalized) ?? null;
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
  const rawPlatform =
    stringValue(contract.platform_slug) || stringValue(contract.canonical_platform_slug) || stringValue(contract.platform);
  const rawFamily = stringValue(variant.family_id) || stringValue(variant.family_name);
  const platformSlug = slug(
    rawPlatform,
    'platform',
  );
  const familyId = slug(rawFamily, 'variant');
  const legacyBaseName = `${platformSlug}-${familyId}`;
  const baseName = videoFilesystemKey([rawPlatform || platformSlug, rawFamily || familyId], `${platformSlug}-${familyId}`);

  const videoRef = firstDefinedPath(variant, [
    'video_path',
    'rendered_video_path',
    'video_file',
    'rendered_video_file',
  ]);
  if (videoRef) {
    result.reportedCount += 1;
    const allowedDestinations = exactAllowedVideoDestinations(jobId, baseName, legacyBaseName);
    const resolved = resolveAllowedSource(videoRef.value, allowedDestinations);
    if ('reason' in resolved) {
      result.skipped.push({ path: videoRef.value, reason: resolved.reason });
    } else if (path.extname(resolved.resolved).toLowerCase() === '.mp4') {
      const destination = copyDeterministic(
        resolved.resolved,
        exactDestinationPath(resolved.resolved, allowedDestinations) ?? videoDestination(jobId, baseName),
        result,
      );
      const servedBaseName = path.basename(destination, '.mp4');
      variant[videoRef.key] = destination;
      variant.video_url = servedAssetUrl(jobId, `video-${servedBaseName}`);
      result.ingestedCount += 1;
    } else {
      result.skipped.push({ path: videoRef.value, reason: 'invalid' });
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
    const allowedDestinations = exactAllowedPosterDestinations(jobId, baseName, legacyBaseName);
    const resolved = resolveAllowedSource(posterRef.value, allowedDestinations);
    const ext = 'resolved' in resolved ? path.extname(resolved.resolved).toLowerCase() : '';
    if ('resolved' in resolved && (ext === '.jpg' || ext === '.jpeg' || ext === '.png' || ext === '.webp')) {
      const destination = copyDeterministic(
        resolved.resolved,
        exactDestinationPath(resolved.resolved, allowedDestinations) ?? posterDestination(jobId, baseName, ext),
        result,
      );
      const servedBaseName = path.basename(destination, ext).replace(/-poster$/, '');
      variant[posterRef.key] = destination;
      if (posterRef.key.startsWith('thumbnail')) {
        variant.poster_path = destination;
      }
      variant.poster_url = servedAssetUrl(jobId, `video-${servedBaseName}-poster`);
    } else {
      result.skipped.push({ path: posterRef.value, reason: 'reason' in resolved ? resolved.reason : 'invalid' });
    }
  }
}

function ingestCanonicalArtifact(
  jobId: string,
  artifact: UnknownRecord,
  result: SocialContentVideoIngestResult,
): void {
  const mimeType = stringValue(artifact.mime_type || artifact.mimeType).toLowerCase();
  const sourcePath = stringValue(
    artifact.path
    || artifact.video_path
    || artifact.rendered_video_path
    || artifact.file
    || artifact.video_file,
  );
  const sourceLooksVideo = path.extname(sourcePath).toLowerCase() === '.mp4';
  if ((mimeType && mimeType !== 'video/mp4' && !sourceLooksVideo) || (!mimeType && !sourceLooksVideo)) {
    return;
  }

  result.reportedCount += 1;
  if (!sourcePath) {
    result.skipped.push({ path: '', reason: 'invalid' });
    return;
  }

  const rawPlatform = stringValue(artifact.platform_slug || artifact.canonical_platform_slug || artifact.platform);
  const rawArtifactId = stringValue(artifact.id);
  const rawFamily = stringValue(artifact.family_id || artifact.family_name || rawArtifactId);
  const platformSlug = slug(
    rawPlatform,
    'platform',
  );
  const familyId = slug(
    rawFamily,
    'variant',
  );
  const legacyBaseName = `${platformSlug}-${familyId}`;
  const readableIdentity = [rawPlatform || platformSlug, rawFamily || familyId];
  const previousCanonicalBaseName = videoFilesystemKey(readableIdentity, legacyBaseName);
  const baseName = rawArtifactId
    ? videoFilesystemKey(readableIdentity, legacyBaseName, [...readableIdentity, rawArtifactId])
    : previousCanonicalBaseName;
  const canonicalDestinations = exactAllowedVideoDestinations(jobId, baseName);
  const allowedDestinations = exactAllowedVideoDestinations(
    jobId,
    baseName,
    previousCanonicalBaseName,
    legacyBaseName,
  );
  const resolved = resolveAllowedSource(sourcePath, allowedDestinations);
  if ('reason' in resolved) {
    result.skipped.push({ path: sourcePath, reason: resolved.reason });
    return;
  }
  if (path.extname(resolved.resolved).toLowerCase() !== '.mp4') {
    result.skipped.push({ path: sourcePath, reason: 'invalid' });
    return;
  }

  const destination = copyDeterministic(
    resolved.resolved,
    exactDestinationPath(resolved.resolved, canonicalDestinations) ?? videoDestination(jobId, baseName),
    result,
  );
  const servedAssetId = `video-${path.basename(destination, '.mp4')}`;
  artifact.id = stringValue(artifact.id) || servedAssetId;
  artifact.path = destination;
  artifact.video_path = destination;
  artifact.url = servedAssetUrl(jobId, servedAssetId);
  artifact.mime_type = 'video/mp4';
  artifact.bytes = statSync(destination).size;
  artifact.platform_slug = platformSlug;
  artifact.family_id = familyId;
  result.ingestedCount += 1;
}

function ingestOutputRecord(jobId: string, output: UnknownRecord, result: SocialContentVideoIngestResult): void {
  for (const artifact of recordArray(output.artifacts)) {
    ingestCanonicalArtifact(jobId, artifact, result);
  }
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
    reportedCount: 0,
    ingestedCount: 0,
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
