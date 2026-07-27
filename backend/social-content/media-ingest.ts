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
};

export type SocialContentStageMediaIngestReport = {
  requested: number;
  ingested: number;
  skipped: number;
  rewrites: MediaRewrite[];
  skipDetails: SocialContentVideoIngestResult['skipped'];
};

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
const VIDEO_EXTENSIONS = new Set(['mp4']);
const HERMES_IMAGE_PREFIXES = ['openai_codex_', 'openai_gpt_', 'gpt-image-', 'image_render_'] as const;

function mediaPathParts(value: unknown): { pathPart: string; basename: string; extension: string } | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, 1024);
  if (!trimmed || /(^|[\\/])\.\.([\\/]|$)/.test(trimmed)) return null;
  const queryIndex = trimmed.indexOf('?');
  const fragmentIndex = trimmed.indexOf('#');
  const cutAt = queryIndex === -1
    ? fragmentIndex
    : fragmentIndex === -1
      ? queryIndex
      : Math.min(queryIndex, fragmentIndex);
  const pathPart = cutAt === -1 ? trimmed : trimmed.slice(0, cutAt);
  const lastSlash = Math.max(pathPart.lastIndexOf('/'), pathPart.lastIndexOf('\\'));
  const basename = lastSlash === -1 ? pathPart : pathPart.slice(lastSlash + 1);
  const dot = basename.lastIndexOf('.');
  if (!basename || dot === -1) return null;
  return { pathPart, basename, extension: basename.slice(dot + 1).toLowerCase() };
}

export function isHermesCacheImagePath(value: unknown): boolean {
  const parts = mediaPathParts(value);
  if (!parts || !IMAGE_EXTENSIONS.has(parts.extension)) return false;
  const lowerPath = parts.pathPart.toLowerCase();
  const lowerBasename = parts.basename.toLowerCase();
  return (
    lowerPath.includes('cache/images')
    || lowerPath.includes('cache\\images')
    || lowerPath.includes('hermes-media')
    || HERMES_IMAGE_PREFIXES.some((prefix) => lowerBasename.startsWith(prefix))
  );
}

export function isHermesCacheVideoPath(value: unknown): boolean {
  const parts = mediaPathParts(value);
  if (!parts || !VIDEO_EXTENSIONS.has(parts.extension)) return false;
  const lowerPath = parts.pathPart.toLowerCase();
  return (
    lowerPath.includes('cache/videos')
    || lowerPath.includes('cache\\videos')
    || lowerPath.includes('hermes-media')
    || parts.basename.toLowerCase().startsWith('video_render_')
  );
}

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
  const roots = [
    process.env.HERMES_MEDIA_CACHE_DIR,
    process.env.HERMES_CACHE_DIR,
    path.join(homedir(), '.hermes', 'cache'),
    path.join(tmpdir(), 'hermes', 'cache'),
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .flatMap((value) => expandHermesCacheRoots(value));

  return Array.from(new Set(roots));
}

function resolveAllowedSource(
  filePath: string,
  exactAllowedDestinations: string[] = [],
): { ok: true; resolved: string } | { ok: false; reason: 'not_allowed' | 'missing' | 'invalid' } {
  const raw = stringValue(filePath);
  if (!raw || !path.isAbsolute(raw)) {
    return { ok: false, reason: 'invalid' };
  }

  const normalized = path.resolve(raw);
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

function exactAllowedVideoDestinations(jobId: string, baseName: string): string[] {
  return [videoDestination(jobId, baseName)];
}

function exactAllowedPosterDestinations(jobId: string, baseName: string): string[] {
  return ['.jpg', '.jpeg', '.png', '.webp'].map((ext) => posterDestination(jobId, baseName, ext));
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
    const resolved = resolveAllowedSource(videoRef.value, exactAllowedVideoDestinations(jobId, baseName));
    if ('reason' in resolved) {
      result.skipped.push({ path: videoRef.value, reason: resolved.reason });
    } else if (path.extname(resolved.resolved).toLowerCase() === '.mp4') {
      const destination = copyDeterministic(resolved.resolved, videoDestination(jobId, baseName), result);
      variant[videoRef.key] = destination;
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
    const resolved = resolveAllowedSource(posterRef.value, exactAllowedPosterDestinations(jobId, baseName));
    const ext = 'resolved' in resolved ? path.extname(resolved.resolved).toLowerCase() : '';
    if ('resolved' in resolved && (ext === '.jpg' || ext === '.jpeg' || ext === '.png' || ext === '.webp')) {
      const destination = copyDeterministic(resolved.resolved, posterDestination(jobId, baseName, ext), result);
      variant[posterRef.key] = destination;
      if (posterRef.key.startsWith('thumbnail')) {
        variant.poster_path = destination;
      }
    } else {
      result.skipped.push({ path: posterRef.value, reason: 'reason' in resolved ? resolved.reason : 'invalid' });
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

function ingestCanonicalArtifacts(
  jobId: string,
  output: unknown,
  result: SocialContentVideoIngestResult,
): { requested: number; ingested: number } {
  let requested = 0;
  let ingested = 0;
  const singleRecord = recordValue(output);
  const records = Array.isArray(output)
    ? recordArray(output)
    : singleRecord
      ? [singleRecord]
      : [];

  for (const record of records) {
    for (const artifact of recordArray(record.artifacts)) {
      const sourcePath = stringValue(artifact.path);
      const mimeType = stringValue(artifact.mime_type).toLowerCase();
      if (!sourcePath || (mimeType !== 'video/mp4' && path.extname(sourcePath).toLowerCase() !== '.mp4')) {
        continue;
      }
      requested += 1;
      const platformSlug = slug(stringValue(artifact.platform_slug), 'platform');
      const familyId = slug(stringValue(artifact.family_id) || stringValue(artifact.id), 'variant');
      const baseName = `${platformSlug}-${familyId}`;
      const resolved = resolveAllowedSource(sourcePath, exactAllowedVideoDestinations(jobId, baseName));
      if ('reason' in resolved) {
        result.skipped.push({ path: sourcePath, reason: resolved.reason });
        continue;
      }
      if (path.extname(resolved.resolved).toLowerCase() !== '.mp4') {
        result.skipped.push({ path: sourcePath, reason: 'invalid' });
        continue;
      }
      const destination = copyDeterministic(resolved.resolved, videoDestination(jobId, baseName), result);
      artifact.path = destination;
      artifact.url = `/api/marketing/jobs/${encodeURIComponent(jobId)}/assets/video-${platformSlug}-${familyId}`;
      artifact.mime_type = 'video/mp4';
      artifact.bytes = statSync(destination).size;
      ingested += 1;
    }
  }
  return { requested, ingested };
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

export async function ingestSocialContentStageMedia(input: {
  jobId: string;
  stage: string | null | undefined;
  output: unknown;
}): Promise<SocialContentStageMediaIngestReport> {
  if (input.stage !== 'video_render' || !input.jobId.trim()) {
    return { requested: 0, ingested: 0, skipped: 0, rewrites: [], skipDetails: [] };
  }

  const result = ingestSocialContentVideoRenderOutput(input.jobId, input.output);
  const legacyVideosIngested = result.rewrites.filter((rewrite) => path.extname(rewrite.to).toLowerCase() === '.mp4').length;
  const canonical = ingestCanonicalArtifacts(input.jobId, input.output, result);
  return {
    requested: canonical.requested,
    ingested: canonical.ingested + legacyVideosIngested,
    skipped: result.skipped.length,
    rewrites: result.rewrites,
    skipDetails: result.skipped,
  };
}
