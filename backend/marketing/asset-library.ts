import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { resolveCodeRoot, resolveDataRoot } from '@/lib/runtime-paths';

import { listMarketingDashboardAssetsForJob } from './dashboard-content';
import { extractPublishReviewBundle } from './publish-review';
import type { MarketingJobRuntimeDocument } from './runtime-state';

export type MarketingAssetDescriptor = {
  id: string;
  filePath: string;
  label: string;
  contentType: string;
};

export type MarketingAssetLink = {
  id: string;
  url: string;
  label: string;
  contentType: string;
};

function resolveExistingAbsoluteAssetPath(filePath: string): string | null {
  const normalizedPath = path.normalize(filePath);
  if (existsSync(normalizedPath)) {
    return normalizedPath;
  }

  const codeRoot = path.normalize(resolveCodeRoot());
  const legacyCodeRoot = path.join(codeRoot, 'aries-app');
  if (normalizedPath === legacyCodeRoot || normalizedPath.startsWith(`${legacyCodeRoot}${path.sep}`)) {
    const suffix = normalizedPath.slice(legacyCodeRoot.length + 1);
    const candidate = path.join(codeRoot, suffix);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function assetRoots(): string[] {
  return Array.from(
    new Set(
      [
        resolveDataRoot(),
        resolveCodeRoot(),
        process.env.OPENCLAW_LOCAL_LOBSTER_CWD?.trim(),
        process.env.OPENCLAW_LOBSTER_CWD?.trim(),
        process.env.LOBSTER_STAGE1_CACHE_DIR?.trim(),
        process.env.LOBSTER_STAGE2_CACHE_DIR?.trim(),
        process.env.LOBSTER_STAGE3_CACHE_DIR?.trim(),
        process.env.LOBSTER_STAGE4_CACHE_DIR?.trim(),
      ].filter((value): value is string => typeof value === 'string' && value.length > 0)
    )
  );
}

function resolveExistingRelativeAssetPath(filePath: string): string | null {
  for (const root of assetRoots()) {
    const candidate = path.resolve(root, filePath);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function stringValue(value: unknown, fallback = ''): string {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return fallback;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry))
    : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => stringValue(entry)).filter(Boolean)
    : [];
}

function sniffImageContentType(filePath: string): string | null {
  try {
    const buffer = readFileSync(filePath);
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return 'image/jpeg';
    }
    if (
      buffer.length >= 8 &&
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a
    ) {
      return 'image/png';
    }
    if (buffer.length >= 6) {
      const signature = buffer.subarray(0, 6).toString('utf8');
      if (signature === 'GIF87a' || signature === 'GIF89a') {
        return 'image/gif';
      }
    }
    if (
      buffer.length >= 12 &&
      buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'WEBP'
    ) {
      return 'image/webp';
    }
  } catch {}

  return null;
}

function contentTypeForAsset(filePath: string): string {
  const sniffedImageType = sniffImageContentType(filePath);
  if (sniffedImageType) {
    return sniffedImageType;
  }

  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.svg':
      return 'image/svg+xml';
    case '.html':
      return 'text/html; charset=utf-8';
    case '.md':
    case '.txt':
      return 'text/plain; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

export function marketingAssetUrl(jobId: string, assetId: string): string {
  return `/api/marketing/jobs/${encodeURIComponent(jobId)}/assets/${encodeURIComponent(assetId)}`;
}

export function buildMarketingAssetLibrary(jobId: string, runtimeDoc: MarketingJobRuntimeDocument): MarketingAssetDescriptor[] {
  const assets: MarketingAssetDescriptor[] = [];
  const assetById = new Map<string, MarketingAssetDescriptor>();
  const resolveAssetPath = (
    filePath: string | null | undefined,
    fallbackPaths: Array<string | null | undefined> = []
  ): string | null => {
    const candidates = [filePath, ...fallbackPaths]
      .map((value) => stringValue(value))
      .filter(Boolean);

    for (const candidate of candidates) {
      if (!path.isAbsolute(candidate)) {
        const resolved = resolveExistingRelativeAssetPath(candidate);
        return resolved || candidate;
      }
      const resolved = resolveExistingAbsoluteAssetPath(candidate);
      if (resolved) {
        return resolved;
      }
    }

    return null;
  };

  const addAsset = (
    id: string,
    filePath: string | null | undefined,
    label: string,
    fallbackPaths: Array<string | null | undefined> = []
  ) => {
    const resolvedPath = resolveAssetPath(filePath, fallbackPaths);
    if (!resolvedPath) {
      return;
    }
    assetById.set(id, {
      id,
      filePath: resolvedPath,
      label,
      contentType: contentTypeForAsset(resolvedPath),
    });
  };

  const dashboardAssets = listMarketingDashboardAssetsForJob(jobId);
  const previewFallbacksByPlatform = new Map<string, string[]>();
  const rememberPreviewFallback = (platform: string, filePath: string) => {
    previewFallbacksByPlatform.set(platform, [
      ...(previewFallbacksByPlatform.get(platform) || []),
      filePath,
    ]);
  };

  for (const asset of dashboardAssets) {
    if (!asset.filePath || !asset.contentType?.startsWith('image/')) {
      continue;
    }
    if (
      !asset.id.startsWith('publish-image-') &&
      !asset.id.startsWith('publish-fallback-') &&
      !asset.id.startsWith('image-')
    ) {
      continue;
    }
    rememberPreviewFallback(asset.platform, asset.filePath);
  }

  const reviewBundle = extractPublishReviewBundle(runtimeDoc);
  if (reviewBundle) {
    const artifactPaths = recordValue(reviewBundle.artifact_paths);
    const landingPage = recordValue(reviewBundle.landing_page_preview);
    const scriptPreview = recordValue(reviewBundle.script_preview);
    const reviewPacket = recordValue(reviewBundle.review_packet);
    const platformPreviews = recordArray(reviewBundle.platform_previews);

    addAsset('launch-review-preview', stringValue(artifactPaths?.preview_path) || null, 'Launch review preview');
    addAsset('landing-page-path', stringValue(landingPage?.landing_page_path) || null, 'Landing page');
    addAsset('script-meta', stringValue(scriptPreview?.meta_script_path) || null, 'Meta script');
    addAsset('script-video', stringValue(scriptPreview?.short_video_script_path) || null, 'Short video script');
    addAsset('review-packet-production', stringValue(reviewPacket?.production_review_preview_path) || null, 'Production review preview');
    addAsset('review-packet-canonical', stringValue(reviewPacket?.canonical_review_packet_path) || null, 'Canonical review packet');

    for (const platform of platformPreviews) {
      const slug = stringValue(platform.platform_slug, 'platform');
      const platformName = stringValue(platform.platform_name, slug);
      const assetPaths = recordValue(platform.asset_paths);

      stringArray(platform.media_paths).forEach((filePath, index) => {
        addAsset(
          `platform-preview-${slug}-media-${index + 1}`,
          filePath,
          `${platformName} media ${index + 1}`,
          previewFallbacksByPlatform.get(slug) || previewFallbacksByPlatform.get('landing-page') || []
        );
      });
      addAsset(`platform-preview-${slug}-asset-contract`, stringValue(assetPaths?.contract_path) || null, `${platformName} contract`);
      addAsset(`platform-preview-${slug}-asset-brief`, stringValue(assetPaths?.brief_path) || null, `${platformName} brief`);
      addAsset(`platform-preview-${slug}-asset-landing-page`, stringValue(assetPaths?.landing_page_path) || null, `${platformName} landing page`);
    }
  }

  for (const asset of dashboardAssets) {
    if (!asset.filePath) {
      continue;
    }
    addAsset(asset.id, asset.filePath, asset.title);
  }

  assets.push(...assetById.values());
  return assets;
}

export function buildMarketingAssetLinks(jobId: string, runtimeDoc: MarketingJobRuntimeDocument): MarketingAssetLink[] {
  return buildMarketingAssetLibrary(jobId, runtimeDoc).map((asset) => ({
    id: asset.id,
    url: marketingAssetUrl(jobId, asset.id),
    label: asset.label,
    contentType: asset.contentType,
  }));
}

export function findMarketingAsset(
  jobId: string,
  runtimeDoc: MarketingJobRuntimeDocument,
  assetId: string
): MarketingAssetDescriptor | null {
  return buildMarketingAssetLibrary(jobId, runtimeDoc).find((asset) => asset.id === assetId) ?? null;
}
