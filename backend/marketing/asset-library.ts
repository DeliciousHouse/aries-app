import path from 'node:path';

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

function contentTypeForAsset(filePath: string): string {
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

function publishReviewBundle(runtimeDoc: MarketingJobRuntimeDocument): Record<string, unknown> | null {
  const publishStage = runtimeDoc.stages.publish;
  const review = recordValue(publishStage.outputs.review) ?? recordValue(publishStage.primary_output);
  return recordValue(review?.review_bundle);
}

export function marketingAssetUrl(jobId: string, assetId: string): string {
  return `/api/marketing/jobs/${encodeURIComponent(jobId)}/assets/${encodeURIComponent(assetId)}`;
}

export function buildMarketingAssetLibrary(jobId: string, runtimeDoc: MarketingJobRuntimeDocument): MarketingAssetDescriptor[] {
  const reviewBundle = publishReviewBundle(runtimeDoc);
  if (!reviewBundle) {
    return [];
  }

  const assets: MarketingAssetDescriptor[] = [];
  const addAsset = (id: string, filePath: string | null | undefined, label: string) => {
    const normalizedPath = stringValue(filePath);
    if (!normalizedPath) {
      return;
    }
    assets.push({
      id,
      filePath: normalizedPath,
      label,
      contentType: contentTypeForAsset(normalizedPath),
    });
  };

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
        `${platformName} media ${index + 1}`
      );
    });
    addAsset(`platform-preview-${slug}-asset-contract`, stringValue(assetPaths?.contract_path) || null, `${platformName} contract`);
    addAsset(`platform-preview-${slug}-asset-brief`, stringValue(assetPaths?.brief_path) || null, `${platformName} brief`);
    addAsset(`platform-preview-${slug}-asset-landing-page`, stringValue(assetPaths?.landing_page_path) || null, `${platformName} landing page`);
  }

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
