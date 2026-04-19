import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs';
import path from 'node:path';

import { resolveCodeRoot, resolveDataRoot } from '@/lib/runtime-paths';

import { listMarketingDashboardAssetsForJob } from './dashboard-content';
import { collectResearchStageArtifacts, collectStrategyReviewArtifacts } from './artifact-collector';
import {
  canonicalizePublishReviewPlatformSlug,
  legacyPublishReviewLinkedAssetId,
  legacyPublishReviewMediaAssetId,
  publishReviewLinkedAssetId,
  publishReviewMediaAssetId,
} from './publish-review-asset-ids';
import { extractPublishReviewBundle } from './publish-review';
import type { MarketingJobRuntimeDocument } from './runtime-state';
import { loadValidatedMarketingProfileDocs, loadValidatedMarketingProfileSnapshot } from './validated-profile-store';

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
  const codeRoot = path.normalize(resolveCodeRoot());
  const remapPrefixes = [
    '/home/node/workspace/aries-app',
    '/app/aries-app',
    path.join(codeRoot, 'aries-app'),
  ].map((prefix) => path.normalize(prefix));
  const candidates = new Set([normalizedPath]);

  for (const prefix of remapPrefixes) {
    if (normalizedPath !== prefix && !normalizedPath.startsWith(`${prefix}${path.sep}`)) {
      continue;
    }

    const suffix = normalizedPath.slice(prefix.length).replace(/^[\\/]+/, '');
    candidates.add(path.join(codeRoot, suffix));
  }

  for (const candidate of candidates) {
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

function outputRoots(): string[] {
  return Array.from(
    new Set(
      [
        process.env.OPENCLAW_LOCAL_LOBSTER_CWD?.trim()
          ? path.join(process.env.OPENCLAW_LOCAL_LOBSTER_CWD.trim(), 'output')
          : null,
        process.env.OPENCLAW_LOBSTER_CWD?.trim()
          ? path.join(process.env.OPENCLAW_LOBSTER_CWD.trim(), 'output')
          : null,
        path.join(resolveCodeRoot(), 'lobster', 'output'),
      ].filter((value): value is string => typeof value === 'string' && value.length > 0),
    ),
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

function slugify(value: string, fallback = ''): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.map((value) => stringValue(value)).filter(Boolean)));
}

function normalizePublishPreviewSlug(platform: Record<string, unknown>, previewIndex: number): string {
  return canonicalizePublishReviewPlatformSlug(platform.platform_slug, `platform-${previewIndex + 1}`);
}

function sniffMediaContentType(filePath: string): string | null {
  try {
    const fd = openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(12);
      const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
      const header = buffer.subarray(0, bytesRead);

      if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
        return 'image/jpeg';
      }
      if (
        header.length >= 8 &&
        header[0] === 0x89 &&
        header[1] === 0x50 &&
        header[2] === 0x4e &&
        header[3] === 0x47 &&
        header[4] === 0x0d &&
        header[5] === 0x0a &&
        header[6] === 0x1a &&
        header[7] === 0x0a
      ) {
        return 'image/png';
      }
      if (header.length >= 6) {
        const signature = header.subarray(0, 6).toString('utf8');
        if (signature === 'GIF87a' || signature === 'GIF89a') {
          return 'image/gif';
        }
      }
      if (
        header.length >= 12 &&
        header.subarray(0, 4).toString('ascii') === 'RIFF' &&
        header.subarray(8, 12).toString('ascii') === 'WEBP'
      ) {
        return 'image/webp';
      }
      // ISO Base Media File Format (mp4/mov/m4v/etc.) starts with a 4-byte
      // size followed by the 'ftyp' box type. Sniffing the ftyp box lets us
      // return the right video/mp4 content-type even when the extension is
      // missing or misleading.
      if (header.length >= 8 && header.subarray(4, 8).toString('ascii') === 'ftyp') {
        return 'video/mp4';
      }
    } finally {
      closeSync(fd);
    }
  } catch {}

  return null;
}

export function contentTypeForAsset(filePath: string): string {
  const sniffedMediaType = sniffMediaContentType(filePath);
  if (sniffedMediaType) {
    return sniffedMediaType;
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
    case '.mp4':
      return 'video/mp4';
    case '.m4v':
      return 'video/x-m4v';
    case '.mov':
      return 'video/quicktime';
    case '.webm':
      return 'video/webm';
    case '.ogv':
    case '.ogg':
      return 'video/ogg';
    case '.html':
      return 'text/html; charset=utf-8';
    case '.md':
      return 'text/markdown; charset=utf-8';
    case '.txt':
      return 'text/plain; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    default:
      // Binary assets that don't match the explicit map above should fall
      // back to application/octet-stream. The old default of text/plain
      // forced the browser to attempt inline-rendering of bytes like .mp4
      // that then broke because the response advertised itself as text.
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
        if (resolved) {
          return resolved;
        }
        continue;
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
    if (assetById.has(id)) {
      return;
    }
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

  const strategyOutputs = recordValue(runtimeDoc.stages.strategy.outputs);
  const researchFallback = collectResearchStageArtifacts(
    runtimeDoc.stages.research.primary_output || { run_id: runtimeDoc.stages.research.run_id },
  );
  const validatedProfileDocs = loadValidatedMarketingProfileDocs(runtimeDoc.tenant_id, {
    currentSourceUrl: runtimeDoc.inputs.brand_url || null,
  });
  const validatedProfile = loadValidatedMarketingProfileSnapshot(runtimeDoc.tenant_id, {
    currentSourceUrl: runtimeDoc.inputs.brand_url || null,
  });
  const strategyFallback = collectStrategyReviewArtifacts(
    runtimeDoc.stages.strategy.primary_output || { run_id: runtimeDoc.stages.strategy.run_id },
    runtimeDoc,
  );
  const researchSummaryPath =
    stringValue(researchFallback.outputs.compile_path) ||
    null;
  const websiteAnalysisPath =
    validatedProfileDocs.paths.websiteAnalysis ||
    stringValue(strategyOutputs?.validated_website_analysis_path) ||
    stringValue(strategyOutputs?.website_brand_analysis_path) ||
    stringValue(strategyFallback.outputs.website_brand_analysis_path) ||
    null;
  const plannerPath =
    stringValue(strategyOutputs?.campaign_planner_path) ||
    stringValue(strategyFallback.outputs.campaign_planner_path) ||
    null;
  const strategyReviewPath =
    stringValue(strategyOutputs?.strategy_review_path) ||
    stringValue(strategyFallback.outputs.strategy_review_path) ||
    null;
  let websiteAnalysis: Record<string, unknown> | null = null;
  if (websiteAnalysisPath) {
    try {
      const resolvedWebsiteAnalysisPath = resolveAssetPath(websiteAnalysisPath) || websiteAnalysisPath;
      websiteAnalysis = recordValue(JSON.parse(readFileSync(resolvedWebsiteAnalysisPath, 'utf8')));
    } catch {
      websiteAnalysis = null;
    }
  }
  websiteAnalysis ||= validatedProfileDocs.websiteAnalysis;
  websiteAnalysis ||= recordValue(strategyFallback.outputs.website);
  const brandArtifacts = recordValue(websiteAnalysis?.artifacts);
  const brandSlugCandidates = uniqueStrings([
    validatedProfile.brandSlug,
    stringValue(websiteAnalysis?.brand_slug),
    stringValue(recordValue(websiteAnalysis?.brand_analysis)?.brand_slug),
    slugify(stringValue(runtimeDoc.tenant_id)),
    slugify(stringValue(validatedProfile.brandName || runtimeDoc.brand_kit?.brand_name)),
    (() => {
      const candidateUrl = stringValue(validatedProfile.canonicalUrl || runtimeDoc.brand_kit?.canonical_url, stringValue(validatedProfile.websiteUrl || runtimeDoc.inputs.brand_url));
      if (!candidateUrl) {
        return '';
      }
      try {
        return slugify(new URL(candidateUrl).hostname.replace(/^www\./, ''));
      } catch {
        return '';
      }
    })(),
  ]);

  addAsset('research-summary', researchSummaryPath, 'Competitor research summary');
  addAsset('strategy-website-analysis', websiteAnalysisPath, 'Website brand analysis');
  addAsset(
    'brand-kit-json',
    runtimeDoc.brand_kit?.path || validatedProfileDocs.paths.brandKit,
    'Extracted brand kit',
    [validatedProfileDocs.paths.brandKit],
  );
  addAsset('strategy-campaign-planner', plannerPath, 'Campaign planner');
  addAsset('strategy-review-preview', strategyReviewPath, 'Strategy review preview');
  addAsset(
    'brand-bible-markdown',
    stringValue(brandArtifacts?.brand_bible_markdown_path) || null,
    'Brand bible',
    outputRoots().flatMap((outputRoot) => brandSlugCandidates.map((brandSlug) => path.join(outputRoot, `${brandSlug}-brand-bible.md`))),
  );
  addAsset(
    'brand-design-system',
    stringValue(brandArtifacts?.design_system_css_path) || null,
    'Design system',
    outputRoots().flatMap((outputRoot) => brandSlugCandidates.map((brandSlug) => path.join(outputRoot, `${brandSlug}-design-system.css`))),
  );

  if (brandSlugCandidates.length > 0) {
    addAsset(
      'strategy-proposal-markdown',
      null,
      'Campaign proposal',
      outputRoots().flatMap((outputRoot) => brandSlugCandidates.map((brandSlug) => path.join(outputRoot, `${brandSlug}-campaign-proposal.md`))),
    );
    addAsset(
      'strategy-proposal-html',
      null,
      'Campaign proposal preview',
      outputRoots().flatMap((outputRoot) => brandSlugCandidates.map((brandSlug) => path.join(outputRoot, `${brandSlug}-campaign-proposal.html`))),
    );
  }

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

    for (const [previewIndex, platform] of platformPreviews.entries()) {
      const slug = normalizePublishPreviewSlug(platform, previewIndex);
      const platformName = stringValue(platform.platform_name, slug);
      const assetPaths = recordValue(platform.asset_paths);

      stringArray(platform.media_paths).forEach((filePath, index) => {
        addAsset(
          publishReviewMediaAssetId({
            platformSlug: slug,
            previewIndex,
            explicitPreviewAssetId: platform.asset_preview_id,
            mediaIndex: index,
          }),
          filePath,
          `${platformName} media ${index + 1}`,
          previewFallbacksByPlatform.get(slug) || previewFallbacksByPlatform.get('landing-page') || []
        );
      });
      addAsset(
        publishReviewLinkedAssetId({
          platformSlug: slug,
          previewIndex,
          explicitPreviewAssetId: platform.asset_preview_id,
          suffix: 'contract',
        }),
        stringValue(assetPaths?.contract_path) || null,
        `${platformName} contract`,
      );
      addAsset(
        publishReviewLinkedAssetId({
          platformSlug: slug,
          previewIndex,
          explicitPreviewAssetId: platform.asset_preview_id,
          suffix: 'brief',
        }),
        stringValue(assetPaths?.brief_path) || null,
        `${platformName} brief`,
      );
      addAsset(
        publishReviewLinkedAssetId({
          platformSlug: slug,
          previewIndex,
          explicitPreviewAssetId: platform.asset_preview_id,
          suffix: 'landing-page',
        }),
        stringValue(assetPaths?.landing_page_path) || null,
        `${platformName} landing page`,
      );
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
  const assets = buildMarketingAssetLibrary(jobId, runtimeDoc);
  const directMatch = assets.find((asset) => asset.id === assetId);
  if (directMatch) {
    return directMatch;
  }

  const reviewBundle = extractPublishReviewBundle(runtimeDoc);
  const platformPreviews = recordArray(reviewBundle?.platform_previews);
  const legacyToCanonical = new Map<string, string>();

  for (const [previewIndex, platform] of platformPreviews.entries()) {
    const slug = normalizePublishPreviewSlug(platform, previewIndex);
    const explicitPreviewAssetId = platform.asset_preview_id;

    stringArray(platform.media_paths).forEach((_, mediaIndex) => {
      legacyToCanonical.set(
        legacyPublishReviewMediaAssetId(slug, mediaIndex),
        publishReviewMediaAssetId({
          platformSlug: slug,
          previewIndex,
          explicitPreviewAssetId,
          mediaIndex,
        }),
      );
    });

    for (const suffix of ['contract', 'brief', 'landing-page'] as const) {
      const assetPaths = recordValue(platform.asset_paths);
      const candidatePath =
        suffix === 'contract'
          ? stringValue(assetPaths?.contract_path)
          : suffix === 'brief'
            ? stringValue(assetPaths?.brief_path)
            : stringValue(assetPaths?.landing_page_path);
      if (!candidatePath) {
        continue;
      }
      legacyToCanonical.set(
        legacyPublishReviewLinkedAssetId(slug, suffix),
        publishReviewLinkedAssetId({
          platformSlug: slug,
          previewIndex,
          explicitPreviewAssetId,
          suffix,
        }),
      );
    }
  }

  const canonicalId = legacyToCanonical.get(assetId);
  if (!canonicalId) {
    return null;
  }

  return assets.find((asset) => asset.id === canonicalId) ?? null;
}
