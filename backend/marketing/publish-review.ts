import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { MarketingJobFacts } from './job-facts';
import type { MarketingJobRuntimeDocument, MarketingVideoStageArtifact } from './runtime-state';
import { readMarketingStageStepPayload } from './stage-artifact-resolution';
import {
  ARTIFACT_INCOMPLETE_TEXT,
  ARTIFACT_UNAVAILABLE_TEXT,
  inferBrandSlug,
  lobsterOutputRoots,
  normalizeArtifactText,
  readLandingPageArtifactDetails,
  readPublishCopyDetails,
  readScriptArtifactDetails,
  resolveMarketingArtifactPath,
} from './real-artifacts';
import { loadValidatedMarketingProfileSnapshot } from './validated-profile-store';

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function slugify(value: string, fallback: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.map((value) => stringValue(value)).filter(Boolean)));
}

async function readJsonIfExists(filePath: string | null | undefined): Promise<Record<string, unknown> | null> {
  if (!filePath) {
    return null;
  }

  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return null;
    }
    return null;
  }
}

function cacheRoot(envKey: string, fallbackFolder: string): string {
  return process.env[envKey]?.trim() || path.join(tmpdir(), fallbackFolder);
}

function competitorSlug(runtimeDoc: MarketingJobRuntimeDocument): string | null {
  const raw = stringValue(runtimeDoc.inputs.competitor_url || runtimeDoc.inputs.request?.competitorUrl);
  if (!raw) {
    return null;
  }

  try {
    return slugify(new URL(raw).hostname.replace(/^www\./, ''), 'campaign');
  } catch {
    return slugify(raw, 'campaign');
  }
}

function publishStageTimestamp(runtimeDoc: MarketingJobRuntimeDocument): number {
  const candidates = [
    runtimeDoc.stages.publish.completed_at,
    runtimeDoc.stages.publish.started_at,
    runtimeDoc.updated_at,
    runtimeDoc.created_at,
  ]
    .map((value) => Date.parse(stringValue(value)))
    .filter((value) => Number.isFinite(value));

  return candidates[0] ?? 0;
}

function runtimeBrandSlugCandidates(runtimeDoc: MarketingJobRuntimeDocument): string[] {
  const runtimeInputs = runtimeDoc.inputs as Record<string, unknown>;
  return uniqueStrings([
    stringValue(runtimeInputs.brand_slug || runtimeDoc.inputs.request?.brandSlug),
    stringValue(runtimeDoc.tenant_id),
  ]).map((value) => slugify(value, value));
}

type PublishStepPayloadCandidate = {
  runId: string;
  payload: Record<string, unknown>;
  mtimeMs: number;
};

async function readExactPublishStepPayload(runtimeDoc: MarketingJobRuntimeDocument, stepName: string, runId: string): Promise<PublishStepPayloadCandidate | null> {
  const cachePath = path.join(cacheRoot('LOBSTER_STAGE4_CACHE_DIR', 'lobster-stage4-cache'), runId, `${stepName}.json`);
  const cached = await readJsonIfExists(cachePath);
  if (cached) {
    try {
      return {
        runId,
        payload: cached,
        mtimeMs: (await stat(cachePath)).mtimeMs,
      };
    } catch {
      return {
        runId,
        payload: cached,
        mtimeMs: 0,
      };
    }
  }

  for (const outputRoot of lobsterOutputRoots()) {
    const logPath = path.join(outputRoot, 'logs', runId, 'stage-4-publish-optimize', `${stepName}.json`);
    const logged = await readJsonIfExists(logPath);
    if (logged) {
      try {
        return {
          runId,
          payload: logged,
          mtimeMs: (await stat(logPath)).mtimeMs,
        };
      } catch {
        return {
          runId,
          payload: logged,
          mtimeMs: 0,
        };
      }
    }
  }

  return null;
}

function scorePublishStepPayloadCandidate(
  runtimeDoc: MarketingJobRuntimeDocument,
  prefix: string,
  candidate: PublishStepPayloadCandidate
): { trust: number; distance: number } {
  const targetTime = publishStageTimestamp(runtimeDoc);
  const runtimeBrandSlugs = runtimeBrandSlugCandidates(runtimeDoc);
  const reviewBundle = recordValue(candidate.payload.review_bundle);
  const approvalPreview = recordValue(candidate.payload.approval_preview);
  const payloadBrandSlug = stringValue(candidate.payload.brand_slug || reviewBundle?.brand_slug);
  const normalizedPayloadBrandSlug = payloadBrandSlug ? slugify(payloadBrandSlug, payloadBrandSlug) : '';
  const platformPreviews = Array.isArray(reviewBundle?.platform_previews) ? reviewBundle.platform_previews : [];
  let trust = 0;

  if (new RegExp(`^${escapeRegExp(prefix)}-[a-f0-9]{8,}$`, 'i').test(candidate.runId)) {
    trust += 25;
  } else if (candidate.runId.startsWith(`${prefix}-`)) {
    trust += 5;
  }

  if (normalizedPayloadBrandSlug && runtimeBrandSlugs.includes(normalizedPayloadBrandSlug)) {
    trust += 80;
  } else if (normalizedPayloadBrandSlug) {
    trust -= 20;
  } else {
    trust += 5;
  }

  if (stringValue(candidate.payload.mode).toLowerCase() === 'compiled') {
    trust += 20;
  }
  if (stringValue(approvalPreview?.message)) {
    trust += 20;
  }
  if (recordValue(reviewBundle?.artifact_paths)) {
    trust += 30;
  }
  if (platformPreviews.length > 0) {
    trust += 10;
  }

  return {
    trust,
    distance: Math.abs(candidate.mtimeMs - targetTime),
  };
}

async function collectFallbackPublishStepPayloadCandidates(
  runtimeDoc: MarketingJobRuntimeDocument,
  stepName: string
): Promise<PublishStepPayloadCandidate[]> {
  const prefix = competitorSlug(runtimeDoc);
  if (!prefix) {
    return [];
  }

  const candidates: PublishStepPayloadCandidate[] = [];
  const seenPaths = new Set<string>();

  const cacheDir = cacheRoot('LOBSTER_STAGE4_CACHE_DIR', 'lobster-stage4-cache');
  if (existsSync(cacheDir)) {
    for (const entry of await readdir(cacheDir)) {
      if (!entry.startsWith(`${prefix}-`)) {
        continue;
      }
      const candidatePath = path.join(cacheDir, entry, `${stepName}.json`);
      if (seenPaths.has(candidatePath)) {
        continue;
      }
      const payload = await readJsonIfExists(candidatePath);
      if (!payload) {
        continue;
      }
      seenPaths.add(candidatePath);
      try {
        candidates.push({ runId: entry, payload, mtimeMs: (await stat(candidatePath)).mtimeMs });
      } catch {
        candidates.push({ runId: entry, payload, mtimeMs: 0 });
      }
    }
  }

  for (const outputRoot of lobsterOutputRoots()) {
    const logsRoot = path.join(outputRoot, 'logs');
    if (!existsSync(logsRoot)) {
      continue;
    }
    for (const entry of await readdir(logsRoot)) {
      if (!entry.startsWith(`${prefix}-`)) {
        continue;
      }
      const candidatePath = path.join(logsRoot, entry, 'stage-4-publish-optimize', `${stepName}.json`);
      if (seenPaths.has(candidatePath)) {
        continue;
      }
      const payload = await readJsonIfExists(candidatePath);
      if (!payload) {
        continue;
      }
      seenPaths.add(candidatePath);
      try {
        candidates.push({ runId: entry, payload, mtimeMs: (await stat(candidatePath)).mtimeMs });
      } catch {
        candidates.push({ runId: entry, payload, mtimeMs: 0 });
      }
    }
  }

  return candidates.sort((left, right) => {
    const leftScore = scorePublishStepPayloadCandidate(runtimeDoc, prefix, left);
    const rightScore = scorePublishStepPayloadCandidate(runtimeDoc, prefix, right);
    return (
      rightScore.trust - leftScore.trust ||
      leftScore.distance - rightScore.distance ||
      right.mtimeMs - left.mtimeMs
    );
  });
}

async function readPublishStepPayload(runtimeDoc: MarketingJobRuntimeDocument, stepName: string): Promise<Record<string, unknown> | null> {
  const explicitRunId = stringValue(runtimeDoc.stages.publish.run_id);
  if (explicitRunId) {
    const explicit = await readExactPublishStepPayload(runtimeDoc, stepName, explicitRunId);
    if (explicit) {
      return explicit.payload;
    }
  }

  for (const candidate of await collectFallbackPublishStepPayloadCandidates(runtimeDoc, stepName)) {
    return candidate.payload;
  }

  return null;
}

function publishStageHasRuntimeContext(runtimeDoc: MarketingJobRuntimeDocument): boolean {
  const publishStage = runtimeDoc.stages.publish;
  const publishOutputs = recordValue(publishStage.outputs);
  const approvalStepId = stringValue(
    runtimeDoc.approvals.current?.workflow_step_id || publishOutputs?.workflow_step_id
  );

  if (approvalStepId === 'approve_stage_4_publish') {
    return true;
  }
  if (
    publishStage.status === 'in_progress' ||
    publishStage.status === 'completed' ||
    publishStage.status === 'failed'
  ) {
    return true;
  }
  if (!!recordValue(publishOutputs?.review) || !!recordValue(recordValue(publishStage.primary_output)?.launch_review)) {
    return true;
  }
  if (publishOutputs && Object.keys(publishOutputs).length > 0 && approvalStepId === 'approve_stage_4_publish') {
    return true;
  }
  if (recordValue(publishStage.primary_output) && approvalStepId === 'approve_stage_4_publish') {
    return true;
  }

  return false;
}

export type PublishReviewBundleSource =
  | 'runtime'
  | 'merged_runtime_artifacts'
  | 'artifact_fallback'
  | 'none';

export type PublishReviewBundleResolution = {
  reviewPayload: Record<string, unknown> | null;
  reviewBundle: Record<string, unknown> | null;
  source: PublishReviewBundleSource;
};

function normalizeAssetPaths(value: unknown): Record<string, unknown> | null {
  const record = recordValue(value);
  if (!record) {
    return null;
  }

  return {
    ...record,
    preview_path: resolveMarketingArtifactPath(stringValue(record.preview_path)) || stringValue(record.preview_path) || undefined,
    contract_path: resolveMarketingArtifactPath(stringValue(record.contract_path)) || stringValue(record.contract_path) || undefined,
    brief_path: resolveMarketingArtifactPath(stringValue(record.brief_path)) || stringValue(record.brief_path) || undefined,
    landing_page_path:
      resolveMarketingArtifactPath(stringValue(record.landing_page_path)) || stringValue(record.landing_page_path) || undefined,
    copy_path: resolveMarketingArtifactPath(stringValue(record.copy_path)) || stringValue(record.copy_path) || undefined,
    image_path: resolveMarketingArtifactPath(stringValue(record.image_path)) || stringValue(record.image_path) || undefined,
    poster_image_path:
      resolveMarketingArtifactPath(stringValue(record.poster_image_path)) || stringValue(record.poster_image_path) || undefined,
  };
}

function normalizeReviewPacket(value: unknown): Record<string, unknown> | null {
  const record = recordValue(value);
  if (!record) {
    return null;
  }

  return {
    ...record,
    production_review_preview_path:
      resolveMarketingArtifactPath(stringValue(record.production_review_preview_path)) ||
      stringValue(record.production_review_preview_path) ||
      undefined,
    canonical_review_packet_path:
      resolveMarketingArtifactPath(stringValue(record.canonical_review_packet_path)) ||
      stringValue(record.canonical_review_packet_path) ||
      undefined,
  };
}

function normalizePlatformPreview(value: Record<string, unknown>): Record<string, unknown> {
  return {
    ...value,
    media_paths: stringArray(value.media_paths)
      .map((filePath) => resolveMarketingArtifactPath(filePath) || filePath)
      .filter(Boolean),
    asset_paths: normalizeAssetPaths(value.asset_paths),
  };
}

function isVideoStageArtifact(
  artifact: MarketingJobRuntimeDocument['stages']['production']['artifacts'][number],
): artifact is MarketingVideoStageArtifact {
  return 'type' in artifact && artifact.type === 'video';
}

function firstRenderedVideoAssetIdForPlatform(
  runtimeDoc: MarketingJobRuntimeDocument,
  platformSlugValue: string,
): string | undefined {
  const match = runtimeDoc.stages.production.artifacts.find((artifact) => (
    isVideoStageArtifact(artifact) && artifact.platformSlug === platformSlugValue
  ));

  return match?.id;
}

function normalizeLandingPagePreview(value: unknown): Record<string, unknown> | null {
  const record = recordValue(value);
  if (!record) {
    return null;
  }
  return {
    ...record,
    landing_page_path:
      resolveMarketingArtifactPath(stringValue(record.landing_page_path)) || stringValue(record.landing_page_path) || undefined,
  };
}

function normalizeScriptPreview(value: unknown): Record<string, unknown> | null {
  const record = recordValue(value);
  if (!record) {
    return null;
  }
  return {
    ...record,
    meta_script_path:
      resolveMarketingArtifactPath(stringValue(record.meta_script_path)) || stringValue(record.meta_script_path) || undefined,
    short_video_script_path:
      resolveMarketingArtifactPath(stringValue(record.short_video_script_path)) ||
      stringValue(record.short_video_script_path) ||
      undefined,
  };
}

function normalizeReviewBundle(bundle: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!bundle) {
    return null;
  }

  return {
    ...bundle,
    artifact_paths: normalizeAssetPaths(bundle.artifact_paths),
    landing_page_preview: normalizeLandingPagePreview(bundle.landing_page_preview),
    script_preview: normalizeScriptPreview(bundle.script_preview),
    review_packet: normalizeReviewPacket(bundle.review_packet),
    platform_previews: recordArray(bundle.platform_previews).map(normalizePlatformPreview),
  };
}

function platformSlug(value: string | null | undefined): string {
  return slugify(stringValue(value), 'platform');
}

function platformNameFromSlug(slug: string): string {
  switch (slug) {
    case 'meta-ads':
      return 'Meta Ads';
    case 'tiktok':
      return 'TikTok';
    case 'youtube':
      return 'YouTube';
    case 'linkedin':
      return 'LinkedIn';
    case 'instagram':
      return 'Instagram';
    case 'reddit':
      return 'Reddit';
    case 'x':
      return 'X';
    default:
      return slug.replace(/-/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
  }
}

function channelTypeForPlatform(slug: string): string {
  if (slug === 'youtube' || slug === 'tiktok') {
    return 'video';
  }
  if (slug === 'landing-page') {
    return 'web';
  }
  return 'paid-social';
}

function preferredText(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const normalized = normalizeArtifactText(value);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function mergeText(primary: unknown, fallback: unknown): string | undefined {
  return preferredText(stringValue(primary), stringValue(fallback)) || undefined;
}

function mergeStringArray(primary: unknown, fallback: unknown): string[] {
  const primaryValues = stringArray(primary).map((entry) => normalizeArtifactText(entry) || '').filter(Boolean);
  if (primaryValues.length > 0) {
    return primaryValues;
  }
  return stringArray(fallback).map((entry) => normalizeArtifactText(entry) || '').filter(Boolean);
}

function mergeRecord(primary: unknown, fallback: unknown): Record<string, unknown> | null {
  const primaryRecord = recordValue(primary);
  const fallbackRecord = recordValue(fallback);
  if (!primaryRecord && !fallbackRecord) {
    return null;
  }
  return {
    ...(fallbackRecord || {}),
    ...(primaryRecord || {}),
  };
}

function mergeSummary(primary: unknown, fallback: unknown): Record<string, unknown> | null {
  const primaryRecord = recordValue(primary);
  const fallbackRecord = recordValue(fallback);
  if (!primaryRecord && !fallbackRecord) {
    return null;
  }
  return {
    ...(fallbackRecord || {}),
    ...(primaryRecord || {}),
    core_message:
      mergeText(primaryRecord?.core_message, fallbackRecord?.core_message) ||
      ARTIFACT_INCOMPLETE_TEXT,
    offer_summary: mergeText(primaryRecord?.offer_summary, fallbackRecord?.offer_summary),
    planned_posts: primaryRecord?.planned_posts ?? fallbackRecord?.planned_posts,
    created_posts: primaryRecord?.created_posts ?? fallbackRecord?.created_posts,
    campaign_window: mergeRecord(primaryRecord?.campaign_window, fallbackRecord?.campaign_window),
  };
}

function mergeLandingPreview(primary: unknown, fallback: unknown): Record<string, unknown> | null {
  const primaryRecord = normalizeLandingPagePreview(primary);
  const fallbackRecord = normalizeLandingPagePreview(fallback);
  if (!primaryRecord && !fallbackRecord) {
    return null;
  }
  return {
    ...(fallbackRecord || {}),
    ...(primaryRecord || {}),
    headline: mergeText(primaryRecord?.headline, fallbackRecord?.headline),
    subheadline: mergeText(primaryRecord?.subheadline, fallbackRecord?.subheadline),
    cta: mergeText(primaryRecord?.cta, fallbackRecord?.cta),
    slug: mergeText(primaryRecord?.slug, fallbackRecord?.slug),
    sections: mergeStringArray(primaryRecord?.sections, fallbackRecord?.sections),
    landing_page_path: mergeText(primaryRecord?.landing_page_path, fallbackRecord?.landing_page_path),
  };
}

function mergeScriptPreview(primary: unknown, fallback: unknown): Record<string, unknown> | null {
  const primaryRecord = normalizeScriptPreview(primary);
  const fallbackRecord = normalizeScriptPreview(fallback);
  if (!primaryRecord && !fallbackRecord) {
    return null;
  }
  return {
    ...(fallbackRecord || {}),
    ...(primaryRecord || {}),
    meta_ad_hook: mergeText(primaryRecord?.meta_ad_hook, fallbackRecord?.meta_ad_hook),
    meta_ad_body: mergeStringArray(primaryRecord?.meta_ad_body, fallbackRecord?.meta_ad_body),
    short_video_opening_line: mergeText(
      primaryRecord?.short_video_opening_line,
      fallbackRecord?.short_video_opening_line,
    ),
    short_video_beats: mergeStringArray(primaryRecord?.short_video_beats, fallbackRecord?.short_video_beats),
    meta_script_path: mergeText(primaryRecord?.meta_script_path, fallbackRecord?.meta_script_path),
    short_video_script_path: mergeText(primaryRecord?.short_video_script_path, fallbackRecord?.short_video_script_path),
  };
}

function mergePlatformPreview(
  primary: Record<string, unknown> | null,
  fallback: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const primaryRecord = primary ? normalizePlatformPreview(primary) : null;
  const fallbackRecord = fallback ? normalizePlatformPreview(fallback) : null;
  if (!primaryRecord && !fallbackRecord) {
    return null;
  }
  const resolvedSlug = platformSlug(stringValue(primaryRecord?.platform_slug || fallbackRecord?.platform_slug));
  return {
    ...(fallbackRecord || {}),
    ...(primaryRecord || {}),
    platform_slug: resolvedSlug,
    platform_name: mergeText(primaryRecord?.platform_name, fallbackRecord?.platform_name) || platformNameFromSlug(resolvedSlug),
    channel_type: mergeText(primaryRecord?.channel_type, fallbackRecord?.channel_type) || channelTypeForPlatform(resolvedSlug),
    summary:
      mergeText(primaryRecord?.summary, fallbackRecord?.summary) ||
      ARTIFACT_UNAVAILABLE_TEXT,
    headline: mergeText(primaryRecord?.headline, fallbackRecord?.headline),
    hook: mergeText(primaryRecord?.hook, fallbackRecord?.hook),
    caption_text: mergeText(primaryRecord?.caption_text, fallbackRecord?.caption_text),
    cta: mergeText(primaryRecord?.cta, fallbackRecord?.cta),
    proof_points: mergeStringArray(primaryRecord?.proof_points, fallbackRecord?.proof_points),
    media_paths: (() => {
      const primaryPaths = stringArray(primaryRecord?.media_paths).map((filePath) => resolveMarketingArtifactPath(filePath) || filePath).filter(Boolean);
      if (primaryPaths.length > 0) {
        return primaryPaths;
      }
      return stringArray(fallbackRecord?.media_paths).map((filePath) => resolveMarketingArtifactPath(filePath) || filePath).filter(Boolean);
    })(),
    asset_paths: normalizeAssetPaths(mergeRecord(primaryRecord?.asset_paths, fallbackRecord?.asset_paths)),
  };
}

function mergePlatformPreviews(primary: unknown, fallback: unknown): Record<string, unknown>[] {
  const mergedBySlug = new Map<string, Record<string, unknown>>();
  const fallbackBySlug = new Map(
    recordArray(fallback).map((entry) => [platformSlug(stringValue(entry.platform_slug || entry.platform_name)), entry] as const),
  );
  for (const entry of recordArray(primary)) {
    const slug = platformSlug(stringValue(entry.platform_slug || entry.platform_name));
    const merged = mergePlatformPreview(entry, fallbackBySlug.get(slug) || null);
    if (merged) {
      mergedBySlug.set(slug, merged);
    }
    fallbackBySlug.delete(slug);
  }
  for (const [slug, entry] of fallbackBySlug.entries()) {
    const merged = mergePlatformPreview(null, entry);
    if (merged) {
      mergedBySlug.set(slug, merged);
    }
  }
  return Array.from(mergedBySlug.values());
}

function buildPublisherStepNames(): string[] {
  return [
    'meta_ads_publisher',
    'instagram_publisher',
    'x_publisher',
    'tiktok_publisher',
    'youtube_publisher',
    'linkedin_publisher',
    'reddit_publisher',
  ];
}

async function collectPublisherPayloads(runtimeDoc: MarketingJobRuntimeDocument): Promise<Array<Record<string, unknown>>> {
  const payloads: Array<Record<string, unknown>> = [];
  for (const stepName of buildPublisherStepNames()) {
    const payload = await readPublishStepPayload(runtimeDoc, stepName);
    if (payload) {
      payloads.push(payload);
    }
  }
  return payloads;
}

async function reviewPackageCandidatePaths(runtimeDoc: MarketingJobRuntimeDocument, campaignName: string | null): Promise<string[]> {
  const brandSlug = inferBrandSlug(runtimeDoc);
  const normalizedCampaignName = stringValue(campaignName);
  const candidates = new Set<string>();

  for (const outputRoot of lobsterOutputRoots()) {
    if (!normalizedCampaignName) {
      continue;
    }
    for (const tenantCandidate of uniqueStrings([runtimeDoc.tenant_id, brandSlug])) {
      const reviewRoot = path.join(outputRoot, 'aries-review', tenantCandidate, normalizedCampaignName);
      if (!existsSync(reviewRoot)) {
        continue;
      }
      for (const platformEntry of await readdir(reviewRoot)) {
        const filePath = path.join(reviewRoot, platformEntry, 'review-package.json');
        if (existsSync(filePath)) {
          candidates.add(filePath);
        }
      }
    }
  }

  return Array.from(candidates);
}

function campaignNameBrandSlugCandidates(campaignName: string | null | undefined): string[] {
  const normalizedCampaignName = stringValue(campaignName);
  if (!normalizedCampaignName) {
    return [];
  }

  const normalizedSlug = slugify(normalizedCampaignName, '');
  if (!normalizedSlug) {
    return [];
  }

  const candidates = new Set<string>([normalizedSlug]);
  const suffixPatterns = [
    /-stage-?4(?:-[a-z0-9-]+)?$/i,
    /-stage-?3(?:-[a-z0-9-]+)?$/i,
    /-stage-?2(?:-plan)?$/i,
    /-stage-?1(?:-[a-z0-9-]+)?$/i,
    /-plan$/i,
    /-campaign$/i,
  ];

  for (const pattern of suffixPatterns) {
    const stripped = normalizedSlug.replace(pattern, '');
    if (stripped && stripped !== normalizedSlug) {
      candidates.add(stripped);
    }
  }

  return Array.from(candidates);
}

function resolvePublishArtifactBrandSlug(
  runtimeDoc: MarketingJobRuntimeDocument,
  campaignName: string | null,
): string | null {
  const candidates = uniqueStrings([
    ...campaignNameBrandSlugCandidates(campaignName),
    inferBrandSlug(runtimeDoc),
  ]);

  for (const candidate of candidates) {
    for (const outputRoot of lobsterOutputRoots()) {
      if (existsSync(path.join(outputRoot, `${candidate}-campaign`))) {
        return candidate;
      }
    }
  }

  return candidates[0] || null;
}

async function buildFallbackPublishReviewBundle(
  runtimeDoc: MarketingJobRuntimeDocument,
  reviewPayload: Record<string, unknown> | null,
  facts?: MarketingJobFacts,
): Promise<Record<string, unknown> | null> {
  const preflight = await readPublishStepPayload(runtimeDoc, 'performance_marketer_preflight');
  const productionHandoff = recordValue(preflight?.production_handoff);
  const productionBrief = recordValue(productionHandoff?.production_brief);
  const reviewBundle = recordValue(reviewPayload?.review_bundle);
  const publisherPayloads = await collectPublisherPayloads(runtimeDoc);
  const reviewPackagePaths = new Set<string>();

  for (const payload of publisherPayloads) {
    const publishPackage = recordValue(payload.publish_package);
    const reviewPackagePath = resolveMarketingArtifactPath(stringValue(publishPackage?.review_package_path));
    if (reviewPackagePath) {
      reviewPackagePaths.add(reviewPackagePath);
    }
  }

  const campaignName =
    stringValue(reviewBundle?.campaign_name) ||
    stringValue(reviewPayload?.campaign_name) ||
    stringValue(preflight?.campaign_name);
  const artifactBrandSlug = resolvePublishArtifactBrandSlug(runtimeDoc, campaignName || null);
  for (const candidatePath of await reviewPackageCandidatePaths(runtimeDoc, campaignName || null)) {
    const resolved = resolveMarketingArtifactPath(candidatePath);
    if (resolved) {
      reviewPackagePaths.add(resolved);
    }
  }

  const landingDetails = await readLandingPageArtifactDetails({
    path: stringValue(recordValue(reviewBundle?.landing_page_preview)?.landing_page_path) || null,
    runtimeDoc,
    brandSlug: artifactBrandSlug,
  });
  const runtimeScriptPreview = recordValue(reviewBundle?.script_preview);
  const scriptDetails = await readScriptArtifactDetails({
    metaScriptPath: stringValue(runtimeScriptPreview?.meta_script_path) || null,
    shortVideoScriptPath: stringValue(runtimeScriptPreview?.short_video_script_path) || null,
    runtimeDoc,
    brandSlug: artifactBrandSlug,
  });
  const productionReview = facts
    ? await facts.stagePayload('production', 'production_review_preview')
    : (await readMarketingStageStepPayload(runtimeDoc, 3, 'production_review_preview')).payload;
  const productionReviewPath =
    stringValue(recordValue(runtimeDoc.stages.production.outputs)?.production_review_path) ||
    null;
  const platformPreviews: Record<string, unknown>[] = [];
  for (const reviewPackagePath of reviewPackagePaths) {
    const reviewPackage = await readJsonIfExists(reviewPackagePath);
    if (!reviewPackage) {
      continue;
    }
    const packageRecord = reviewPackage;
    const rawPlatformSlug = stringValue(packageRecord.platform || path.basename(path.dirname(reviewPackagePath)));
    const slug = platformSlug(rawPlatformSlug);
    const publisherPayload = publisherPayloads.find((payload) =>
      platformSlug(stringValue(payload.platform || payload.type)) === slug,
    ) || null;
    const publishPackage = recordValue(publisherPayload?.publish_package);
    const packageAssetPaths = normalizeAssetPaths(packageRecord.asset_paths);
    const copyDetails = await readPublishCopyDetails(
      stringValue(packageAssetPaths?.copy_path) ||
        stringValue(publishPackage?.copy_path),
    );
    const mediaPaths = uniqueStrings([
      resolveMarketingArtifactPath(stringValue(packageAssetPaths?.image_path)),
      resolveMarketingArtifactPath(stringValue(packageAssetPaths?.poster_image_path)),
      resolveMarketingArtifactPath(stringValue(publishPackage?.image_path)),
      resolveMarketingArtifactPath(stringValue(publishPackage?.fallback_svg_path)),
    ]);
    platformPreviews.push({
      platform_slug: slug,
      platform_name: platformNameFromSlug(slug),
      channel_type: channelTypeForPlatform(slug),
      rendered_video_asset_id: firstRenderedVideoAssetIdForPlatform(runtimeDoc, slug),
      summary:
        preferredText(copyDetails.bodyLines[0], copyDetails.headline, stringValue(packageRecord.summary)) ||
        ARTIFACT_UNAVAILABLE_TEXT,
      headline: preferredText(copyDetails.headline),
      hook:
        slug === 'meta-ads'
          ? preferredText(scriptDetails.metaAdHook, copyDetails.headline)
          : slug === 'tiktok' || slug === 'youtube'
            ? preferredText(scriptDetails.shortVideoOpeningLine, copyDetails.headline)
            : preferredText(copyDetails.headline),
      caption_text: preferredText(copyDetails.bodyLines[0]),
      cta: preferredText(copyDetails.cta, landingDetails.cta),
      media_paths: mediaPaths,
      asset_paths: {
        contract_path:
          resolveMarketingArtifactPath(stringValue(packageRecord.contract_path)) ||
          resolveMarketingArtifactPath(stringValue(publisherPayload?.contract_path)) ||
          undefined,
        brief_path: resolveMarketingArtifactPath(reviewPackagePath) || undefined,
        landing_page_path: landingDetails.path || undefined,
        copy_path: copyDetails.path || undefined,
        image_path: mediaPaths[0] || undefined,
      },
    } satisfies Record<string, unknown>);
  }

  const previewPath =
    resolveMarketingArtifactPath(stringValue(recordValue(reviewPayload?.artifacts)?.preview_path)) ||
    resolveMarketingArtifactPath(stringValue(recordValue(reviewPayload?.artifact_paths)?.preview_path)) ||
    stringArray(platformPreviews[0]?.media_paths)[0] ||
    null;
  const runtimeSourceUrl =
    stringValue(runtimeDoc.inputs.request?.websiteUrl) ||
    stringValue(runtimeDoc.inputs.request?.brandUrl) ||
    stringValue(runtimeDoc.inputs.brand_url) ||
    '';
  const validatedProfile = await loadValidatedMarketingProfileSnapshot(runtimeDoc.tenant_id, {
    currentSourceUrl: runtimeSourceUrl || null,
  });
  const validatedLandingHooks = recordValue(validatedProfile.hooks)?.['landing-page'];
  const validatedLandingHook =
    Array.isArray(validatedLandingHooks)
      ? validatedLandingHooks.find((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0) || null
      : null;

  const fallbackBundle = {
    campaign_name: campaignName || runtimeDoc.job_id,
    approval_message:
      preferredText(stringValue(recordValue(reviewPayload?.approval_preview)?.message)) || ARTIFACT_UNAVAILABLE_TEXT,
    summary: {
      core_message:
        preferredText(
          validatedLandingHook,
          stringValue(recordValue(reviewBundle?.summary)?.core_message),
          stringValue(productionBrief?.core_message),
          stringValue(productionHandoff?.core_message),
          stringValue(platformPreviews[0]?.summary),
          stringValue(platformPreviews[0]?.headline),
        ) || ARTIFACT_INCOMPLETE_TEXT,
      offer_summary:
        preferredText(
          validatedProfile.offer,
          stringValue(productionHandoff?.offer_summary),
        ) || undefined,
    },
    artifact_paths: {
      preview_path: previewPath || undefined,
    },
    landing_page_preview: landingDetails.path
      ? {
          landing_page_path: landingDetails.path,
          headline: landingDetails.headline || ARTIFACT_UNAVAILABLE_TEXT,
          subheadline: landingDetails.subheadline || ARTIFACT_UNAVAILABLE_TEXT,
          cta: landingDetails.cta || ARTIFACT_UNAVAILABLE_TEXT,
          slug: landingDetails.slug || undefined,
          sections: landingDetails.sections,
        }
      : null,
    script_preview:
      scriptDetails.metaScriptPath || scriptDetails.shortVideoScriptPath
        ? {
            meta_ad_hook: scriptDetails.metaAdHook || ARTIFACT_UNAVAILABLE_TEXT,
            meta_ad_body: scriptDetails.metaAdBody,
            short_video_opening_line: scriptDetails.shortVideoOpeningLine || ARTIFACT_UNAVAILABLE_TEXT,
            short_video_beats: scriptDetails.shortVideoBeats,
            meta_script_path: scriptDetails.metaScriptPath || undefined,
            short_video_script_path: scriptDetails.shortVideoScriptPath || undefined,
          }
        : null,
    review_packet: productionReviewPath
      ? {
          production_review_preview_path: resolveMarketingArtifactPath(productionReviewPath) || productionReviewPath,
        }
      : null,
    platform_previews: platformPreviews,
  } satisfies Record<string, unknown>;

  if (
    !previewPath &&
    !landingDetails.path &&
    !scriptDetails.metaScriptPath &&
    !scriptDetails.shortVideoScriptPath &&
    platformPreviews.length === 0
  ) {
    return null;
  }

  return normalizeReviewBundle(fallbackBundle);
}

function mergePublishReviewBundle(
  primary: Record<string, unknown> | null,
  fallback: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const primaryBundle = normalizeReviewBundle(primary);
  const fallbackBundle = normalizeReviewBundle(fallback);
  if (!primaryBundle && !fallbackBundle) {
    return null;
  }
  if (!primaryBundle) {
    return fallbackBundle;
  }
  if (!fallbackBundle) {
    return primaryBundle;
  }

  return {
    ...fallbackBundle,
    ...primaryBundle,
    campaign_name: mergeText(primaryBundle.campaign_name, fallbackBundle.campaign_name) || runtimeDocFallbackCampaignName(primaryBundle, fallbackBundle),
    approval_message:
      mergeText(primaryBundle.approval_message, fallbackBundle.approval_message) ||
      ARTIFACT_UNAVAILABLE_TEXT,
    summary: mergeSummary(primaryBundle.summary, fallbackBundle.summary),
    artifact_paths: normalizeAssetPaths(mergeRecord(primaryBundle.artifact_paths, fallbackBundle.artifact_paths)),
    landing_page_preview: mergeLandingPreview(primaryBundle.landing_page_preview, fallbackBundle.landing_page_preview),
    script_preview: mergeScriptPreview(primaryBundle.script_preview, fallbackBundle.script_preview),
    review_packet: normalizeReviewPacket(mergeRecord(primaryBundle.review_packet, fallbackBundle.review_packet)),
    platform_previews: mergePlatformPreviews(primaryBundle.platform_previews, fallbackBundle.platform_previews),
  };
}

function runtimeDocFallbackCampaignName(
  primaryBundle: Record<string, unknown>,
  fallbackBundle: Record<string, unknown>,
): string {
  return stringValue(primaryBundle.campaign_name || fallbackBundle.campaign_name, 'Campaign');
}

export async function resolvePublishReviewBundle(
  runtimeDoc: MarketingJobRuntimeDocument,
  facts?: MarketingJobFacts,
): Promise<PublishReviewBundleResolution> {
  const reviewPayload = await extractPublishReviewPayload(runtimeDoc, facts);
  const runtimeBundle = normalizeReviewBundle(recordValue(reviewPayload?.review_bundle));
  const fallbackBundle =
    publishStageHasRuntimeContext(runtimeDoc) || runtimeBundle
      ? await buildFallbackPublishReviewBundle(runtimeDoc, reviewPayload, facts)
      : null;

  if (runtimeBundle && !fallbackBundle) {
    return {
      reviewPayload,
      reviewBundle: runtimeBundle,
      source: 'runtime',
    };
  }

  if (!runtimeBundle && fallbackBundle) {
    return {
      reviewPayload,
      reviewBundle: fallbackBundle,
      source: 'artifact_fallback',
    };
  }

  if (runtimeBundle && fallbackBundle) {
    const merged = mergePublishReviewBundle(runtimeBundle, fallbackBundle);
    return {
      reviewPayload,
      reviewBundle: merged,
      source: JSON.stringify(merged) === JSON.stringify(runtimeBundle) ? 'runtime' : 'merged_runtime_artifacts',
    };
  }

  return {
    reviewPayload,
    reviewBundle: null,
    source: 'none',
  };
}

export async function extractPublishReviewPayload(
  runtimeDoc: MarketingJobRuntimeDocument,
  facts?: MarketingJobFacts,
): Promise<Record<string, unknown> | null> {
  const publishStage = runtimeDoc.stages.publish;
  const reviewOutput = recordValue(publishStage.outputs.review);
  if (reviewOutput) {
    return reviewOutput;
  }

  const primaryOutput = recordValue(publishStage.primary_output);
  const launchReview = recordValue(primaryOutput?.launch_review);
  if (launchReview) {
    return launchReview;
  }

  const loggedReview = publishStageHasRuntimeContext(runtimeDoc)
    ? facts
      ? await facts.stagePayload('publish', 'launch_review_preview')
      : await readPublishStepPayload(runtimeDoc, 'launch_review_preview')
    : null;
  if (loggedReview) {
    return loggedReview;
  }

  return primaryOutput;
}

export async function extractPublishReviewBundle(
  runtimeDoc: MarketingJobRuntimeDocument,
  facts?: MarketingJobFacts,
): Promise<Record<string, unknown> | null> {
  return (await resolvePublishReviewBundle(runtimeDoc, facts)).reviewBundle;
}
