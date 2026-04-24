import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveCodePath } from '@/lib/runtime-paths';

import {
  assertMarketingRuntimeSchemas,
  loadMarketingJobRuntime,
  responseStageStatus,
  type MarketingJobRuntimeDocument,
  type MarketingStage,
} from './runtime-state';
import { buildMarketingAssetLinks, marketingAssetUrl, type MarketingAssetLink } from './asset-library';
import { createMarketingJobFacts, type MarketingJobFacts } from './job-facts';
import { resolvePublishReviewBundle } from './publish-review';
import {
  canonicalizePublishReviewPlatformSlug,
  publishReviewLinkedAssetId,
  publishReviewMediaAssetId,
  publishReviewPreviewAssetPrefix,
} from './publish-review-asset-ids';
import {
  ARTIFACT_INCOMPLETE_TEXT,
  ARTIFACT_UNAVAILABLE_TEXT,
  explicitArtifactValue,
  normalizeArtifactText,
} from './real-artifacts';
import { loadValidatedMarketingProfileSnapshot } from './validated-profile-store';

type TimelineTone = 'info' | 'success' | 'warning' | 'danger';

export type MarketingStageCard = {
  stage: MarketingStage;
  label: string;
  status: string;
  summary: string;
  highlight?: string;
};

type MarketingArtifactCardBase = {
  id: string;
  stage: MarketingStage;
  title: string;
  category: string;
  status: string;
  summary: string;
  details: string[];
  preview?: string;
  actionLabel?: string;
  actionHref?: string;
};

export type MarketingVideoArtifactCard = MarketingArtifactCardBase & {
  type: 'video';
  contentType: 'video/mp4';
  url: string;
  posterUrl: string;
  platformSlug: string;
  familyId: string;
  durationSeconds: number;
  aspectRatio: string;
};

export type MarketingArtifactCard = MarketingArtifactCardBase | MarketingVideoArtifactCard;

export type MarketingTimelineEntry = {
  id: string;
  at: string | null;
  tone: TimelineTone;
  label: string;
  description: string;
};

export type MarketingApprovalSummary = {
  required: boolean;
  status: string;
  approvalId?: string;
  workflowStepId?: string;
  title: string;
  message: string;
  actionLabel?: string;
  actionHref?: string;
};

export type MarketingReviewPreviewCard = {
  id: string;
  platformSlug: string;
  platformName: string;
  channelType: string;
  displayTitle?: string;
  summary: string;
  headline?: string;
  hook?: string;
  caption?: string;
  cta?: string;
  details: string[];
  mediaAssets: MarketingAssetLink[];
  assetLinks: MarketingAssetLink[];
};

export type MarketingReviewBundle = {
  stage: MarketingStage;
  title: string;
  campaignName: string;
  generatedAt: string | null;
  approvalMessage: string;
  summary: string;
  previewAsset?: MarketingAssetLink;
  reviewPacketAssets: MarketingAssetLink[];
  landingPage?: {
    headline: string;
    subheadline: string;
    cta: string;
    slug?: string;
    sections: string[];
    asset?: MarketingAssetLink;
  } | null;
  scriptPreview?: {
    metaAdHook?: string;
    metaAdBody: string[];
    shortVideoOpeningLine?: string;
    shortVideoBeats: string[];
    assets: MarketingAssetLink[];
  } | null;
  platformPreviews: MarketingReviewPreviewCard[];
};

export type MarketingSummary = {
  headline: string;
  subheadline: string;
};

export type MarketingCampaignWindow = {
  start: string | null;
  end: string | null;
};

export type MarketingAssetPreviewCard = {
  id: string;
  platformSlug: string;
  platformName: string;
  channelType: string;
  title: string;
  summary: string;
  mediaCount: number;
  assetCount: number;
  previewHref: string;
};

export type MarketingCalendarEvent = {
  id: string;
  startsAt: string;
  endsAt: string | null;
  platform: string;
  title: string;
  status: string;
  assetPreviewId: string | null;
};

export type MarketingJobStatusResponse = {
  jobId: string;
  tenantId: string | null;
  tenantName: string | null;
  brandWebsiteUrl: string | null;
  campaignWindow: MarketingCampaignWindow | null;
  durationDays: number | null;
  plannedPostCount: number | null;
  createdPostCount: number | null;
  assetPreviewCards: MarketingAssetPreviewCard[];
  calendarEvents: MarketingCalendarEvent[];
  state: string;
  status: string;
  currentStage: string | null;
  stageStatus: Record<string, string>;
  updatedAt: string | null;
  approvalRequired: boolean;
  needsAttention: boolean;
  summary: MarketingSummary;
  stageCards: MarketingStageCard[];
  artifacts: MarketingArtifactCard[];
  timeline: MarketingTimelineEntry[];
  approval: MarketingApprovalSummary | null;
  reviewBundle: MarketingReviewBundle | null;
  publishConfig: {
    platforms: string[];
    livePublishPlatforms: string[];
    videoRenderPlatforms: string[];
  };
  nextStep: string;
  repairStatus: string;
};

type CacheEntry = {
  payload: MarketingJobStatusResponse;
  expiresAt: number;
};

type MarketingJobStatusBuilder = (
  tenantId: string,
  jobId: string,
  facts?: MarketingJobFacts,
) => MarketingJobStatusResponse | Promise<MarketingJobStatusResponse>;

export type MarketingJobStatusCacheState = 'hit' | 'miss' | 'inflight';

const STATUS_CACHE_TTL_MS = 10_000;
const STATUS_CACHE_MAX = 1_000;
const statusCache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<MarketingJobStatusResponse>>();

let marketingJobStatusBuilder: MarketingJobStatusBuilder = (_tenantId, jobId, facts) =>
  buildMarketingJobStatus(jobId, facts);

function statusCacheKey(tenantId: string, jobId: string): string {
  return `${tenantId}:${jobId}`;
}

export async function getMarketingJobStatusCached(
  tenantId: string,
  jobId: string,
  now: number = Date.now(),
  facts?: MarketingJobFacts,
): Promise<{ payload: MarketingJobStatusResponse; cacheStatus: MarketingJobStatusCacheState }> {
  const key = statusCacheKey(tenantId, jobId);
  const cached = statusCache.get(key);
  if (cached && cached.expiresAt > now) {
    return { payload: cached.payload, cacheStatus: 'hit' };
  }

  const pending = inflight.get(key);
  if (pending) {
    return { payload: await pending, cacheStatus: 'inflight' };
  }

  const startedAt = Date.now();
  const promise = new Promise<MarketingJobStatusResponse>((resolve, reject) => {
    setImmediate(() => {
      Promise.resolve(marketingJobStatusBuilder(tenantId, jobId, facts))
        .then((payload) => {
          statusCache.set(key, { payload, expiresAt: now + STATUS_CACHE_TTL_MS });
          if (statusCache.size > STATUS_CACHE_MAX) {
            evictOldest();
          }
          inflight.delete(key);
          console.log('[jobs-cache] miss key=%s cold_ms=%d', key, Date.now() - startedAt);
          resolve(payload);
        })
        .catch((error: unknown) => {
          inflight.delete(key);
          reject(error);
        });
    });
  });

  inflight.set(key, promise);
  return { payload: await promise, cacheStatus: 'miss' };
}

export function invalidateMarketingJobStatus(jobId: string): void {
  for (const key of statusCache.keys()) {
    if (key.endsWith(`:${jobId}`)) {
      statusCache.delete(key);
    }
  }
}

export function evictOldest(): void {
  const oldest = statusCache.keys().next().value;
  if (oldest) {
    statusCache.delete(oldest);
  }
}

export function resetMarketingJobStatusCacheForTests(): void {
  statusCache.clear();
  inflight.clear();
  marketingJobStatusBuilder = (_tenantId, jobId, facts) => buildMarketingJobStatus(jobId, facts);
}

export function overrideMarketingJobStatusBuilderForTests(builder: MarketingJobStatusBuilder): void {
  marketingJobStatusBuilder = builder;
}

export function getMarketingJobStatusCacheSizeForTests(): number {
  return statusCache.size;
}

function shouldLogMarketingJobStatus(): boolean {
  const raw = process.env.MARKETING_DEBUG_LOG_JOBS_STATUS?.trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

const STAGE_LABELS: Record<MarketingStage, string> = {
  research: 'Research',
  strategy: 'Strategy',
  production: 'Production',
  publish: 'Publish',
};

const PUBLISHER_STEPS = [
  'meta_ads_publisher',
  'instagram_publisher',
  'x_publisher',
  'tiktok_publisher',
  'youtube_publisher',
  'linkedin_publisher',
  'reddit_publisher',
] as const;

function cacheRoot(envKey: string, fallbackFolder: string): string {
  return process.env[envKey]?.trim() || path.join(tmpdir(), fallbackFolder);
}

function stageLogRoot(stage: 1 | 2 | 3 | 4): string {
  const stageFolder =
    stage === 1
      ? 'stage-1-research'
      : stage === 2
        ? 'stage-2-strategy'
        : stage === 3
          ? 'stage-3-production'
          : 'stage-4-publish-optimize';
  return resolveCodePath('lobster', 'output', 'logs', '{runId}', stageFolder);
}

function stepPayloadPath(stage: 1 | 2 | 3 | 4, runId: string, stepName: string): string {
  const root =
    stage === 1
      ? cacheRoot('LOBSTER_STAGE1_CACHE_DIR', 'lobster-stage1-cache')
      : stage === 2
        ? cacheRoot('LOBSTER_STAGE2_CACHE_DIR', 'lobster-stage2-cache')
        : stage === 3
          ? cacheRoot('LOBSTER_STAGE3_CACHE_DIR', 'lobster-stage3-cache')
          : cacheRoot('LOBSTER_STAGE4_CACHE_DIR', 'lobster-stage4-cache');
  const primary = path.join(root, runId, `${stepName}.json`);
  if (existsSync(primary)) {
    return primary;
  }
  return stageLogRoot(stage).replace('{runId}', runId) + `/${stepName}.json`;
}

function readJsonIfExists(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readTextPreview(filePath: string | null, maxChars = 420): string | null {
  if (!filePath || !existsSync(filePath)) {
    return null;
  }

  try {
    const text = readFileSync(filePath, 'utf8').trim();
    if (!text) {
      return null;
    }
    return text.length > maxChars ? `${text.slice(0, maxChars).trimEnd()}...` : text;
  } catch {
    return null;
  }
}

function stringValue(value: unknown, fallback = ''): string {
  if (typeof value === 'string' && value.trim()) {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((entry) => stringValue(entry))
        .filter((entry) => entry.length > 0)
    : [];
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
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

function lowSignalReviewText(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    !normalized ||
    normalized.startsWith('based on the brand identity') ||
    normalized.startsWith('based on the provided brand') ||
    normalized.startsWith('here is the brand strategy analysis') ||
    normalized.includes('here is a concise strategy analysis') ||
    normalized.includes('here is the concise brand strategy')
  );
}

function reviewPreviewDisplayTitle(platformName: string, preview: Record<string, unknown>): string {
  const headline = stringValue(preview.headline || preview.hook);
  return headline && !lowSignalReviewText(headline) ? headline : platformName;
}

function deriveState(
  runtimeDoc: MarketingJobRuntimeDocument,
  stageStatus: Record<string, string>
): { state: string; status: string; currentStage: string | null; nextStep: string; repairStatus: string; needsAttention: boolean } {
  if (runtimeDoc.status === 'completed' || stageStatus.publish === 'completed') {
    return {
      state: 'completed',
      status: 'completed',
      currentStage: 'publish',
      nextStep: 'none',
      repairStatus: 'not_required',
      needsAttention: false,
    };
  }

  if (runtimeDoc.status === 'awaiting_approval' && runtimeDoc.approvals.current) {
    return {
      state: 'approval_required',
      status: 'awaiting_approval',
      currentStage: runtimeDoc.approvals.current.stage,
      nextStep: 'submit_approval',
      repairStatus: 'not_required',
      needsAttention: true,
    };
  }

  if (runtimeDoc.status === 'failed' || runtimeDoc.state === 'failed') {
    return {
      state: runtimeDoc.state,
      status: runtimeDoc.status,
      currentStage: runtimeDoc.current_stage,
      nextStep: 'invoke_marketing_repair',
      repairStatus: 'required',
      needsAttention: true,
    };
  }

  return {
    state: runtimeDoc.state,
    status: runtimeDoc.status,
    currentStage: runtimeDoc.current_stage,
    nextStep: 'wait_for_completion',
    repairStatus: 'not_required',
    needsAttention: false,
  };
}

function isApproveStage2Checkpoint(runtimeDoc: MarketingJobRuntimeDocument): boolean {
  return runtimeDoc.approvals.current?.workflow_step_id === 'approve_stage_2';
}

function firstBrandAnalysisCheckpointCopy() {
  return {
    title: 'Research complete',
    message: 'Research is complete. Continue to brand analysis.',
    actionLabel: 'Continue to brand analysis',
    artifactTitle: 'Brand analysis checkpoint',
  };
}

function approvalReviewHref(jobId: string): string {
  return `/review/${encodeURIComponent(`${jobId}::approval`)}`;
}

function buildSummary(
  runtimeDoc: MarketingJobRuntimeDocument,
  state: ReturnType<typeof deriveState>
): MarketingSummary {
  if (state.status === 'completed') {
    return {
      headline: 'Campaign outputs are ready',
      subheadline: 'Launch packages, review artifacts, and delivery summaries are available for the current campaign.',
    };
  }

  if (state.status === 'awaiting_approval') {
    if (isApproveStage2Checkpoint(runtimeDoc)) {
      return {
        headline: 'Research complete',
        subheadline: 'Research is complete. Continue to brand analysis.',
      };
    }
    const stageLabel = state.currentStage ? STAGE_LABELS[state.currentStage as MarketingStage] : 'Current';
    return {
      headline: `${stageLabel} stage is ready for approval`,
      subheadline: 'Review the latest stage outputs and approve the checkpoint to move the real job forward.',
    };
  }

  if (state.needsAttention) {
    return {
      headline: 'Campaign needs operator attention',
      subheadline: 'The pipeline reported a failure or blocked state. Review the latest artifacts and next action before retrying.',
    };
  }

  return {
    headline: 'Campaign is in progress',
    subheadline: 'Aries is still collecting workflow signals from the marketing pipeline. Refresh to see the latest stage progress.',
  };
}

function buildProductionContractHighlightFallback(
  runtimeDoc: MarketingJobRuntimeDocument,
  productionStageStatus: string,
): string | undefined {
  if (productionStageStatus !== 'in_progress' && productionStageStatus !== 'awaiting_approval') {
    return undefined;
  }
  const videoPlatforms = runtimeDoc.publish_config?.video_render_platforms || [];
  const allPlatforms = runtimeDoc.publish_config?.platforms || [];
  const videoSet = new Set(videoPlatforms.map((slug) => slug.toLowerCase()));
  const staticCount = allPlatforms.filter((slug) => !videoSet.has(slug.toLowerCase())).length;
  const videoCount = videoPlatforms.length;
  if (staticCount === 0 && videoCount === 0) {
    return undefined;
  }
  return `Static contracts: ${staticCount}, Video contracts: ${videoCount}`;
}

function buildStageCards(
  runtimeDoc: MarketingJobRuntimeDocument,
  stageStatus: Record<string, string>
): MarketingStageCard[] {
  const firstBrandAnalysisGate = isApproveStage2Checkpoint(runtimeDoc);
  const firstCheckpointCopy = firstBrandAnalysisCheckpointCopy();
  return (['research', 'strategy', 'production', 'publish'] as MarketingStage[]).map((stage) => {
    const stageRecord = runtimeDoc.stages[stage];
    switch (stage) {
      case 'research':
        return {
          stage,
          label: STAGE_LABELS[stage],
          status: stageStatus[stage],
          summary: stageRecord.summary?.summary || 'Competitive research completed.',
          highlight: stageRecord.summary?.highlight || undefined,
        };
      case 'strategy':
        return {
          stage,
          label: STAGE_LABELS[stage],
          status: stageStatus[stage],
          summary:
            firstBrandAnalysisGate && runtimeDoc.approvals.current?.stage === 'strategy'
              ? firstCheckpointCopy.message
              : stageRecord.summary?.summary || 'Campaign strategy is ready.',
          highlight: stageRecord.summary?.highlight || undefined,
        };
      case 'production':
        return {
          stage,
          label: STAGE_LABELS[stage],
          status: stageStatus[stage],
          summary: stageRecord.summary?.summary || 'Production assets are ready.',
          highlight:
            stageRecord.summary?.highlight ||
            buildProductionContractHighlightFallback(runtimeDoc, stageStatus[stage]) ||
            undefined,
        };
      case 'publish':
        return {
          stage,
          label: STAGE_LABELS[stage],
          status: stageStatus[stage],
          summary: stageRecord.summary?.summary || 'Launch review and publishing happen in the final stage.',
          highlight: stageRecord.summary?.highlight || undefined,
        };
    }
  });
}

function buildApproval(
  jobId: string,
  runtimeDoc: MarketingJobRuntimeDocument
): MarketingApprovalSummary | null {
  const approval = runtimeDoc.approvals.current;
  if (!approval) {
    return null;
  }
  const firstCheckpointCopy = firstBrandAnalysisCheckpointCopy();
  const firstBrandAnalysisGate = approval.workflow_step_id === 'approve_stage_2';
  return {
    required: true,
    status: approval.status,
    approvalId: approval.approval_id ?? undefined,
    workflowStepId: approval.workflow_step_id ?? undefined,
    title: firstBrandAnalysisGate ? firstCheckpointCopy.title : approval.title,
    message: firstBrandAnalysisGate ? firstCheckpointCopy.message : approval.message,
    actionLabel:
      firstBrandAnalysisGate
        ? firstCheckpointCopy.actionLabel
        : (approval.action_label ?? 'Open approval dashboard'),
    actionHref: approvalReviewHref(jobId),
  };
}

function withDetails(...details: Array<string | null | undefined>): string[] {
  return details.filter((detail): detail is string => typeof detail === 'string' && detail.trim().length > 0);
}

function buildArtifacts(
  runtimeDoc: MarketingJobRuntimeDocument,
  approval: MarketingApprovalSummary | null
): MarketingArtifactCard[] {
  const firstCheckpointCopy = firstBrandAnalysisCheckpointCopy();
  const isVideoArtifact = (
    entry: MarketingJobRuntimeDocument['stages'][MarketingStage]['artifacts'][number],
  ): entry is Extract<typeof entry, { type: 'video' }> => 'type' in entry && entry.type === 'video';

  return Object.values(runtimeDoc.stages)
    .flatMap((stageRecord) =>
      stageRecord.artifacts.map((entry) => ({
        id: entry.id,
        stage: entry.stage,
        title:
          approval?.workflowStepId === 'approve_stage_2' &&
          entry.stage === 'strategy' &&
          entry.category === 'approval'
            ? firstCheckpointCopy.artifactTitle
            : entry.title,
        category: entry.category,
        status: entry.status,
        summary:
          approval?.workflowStepId === 'approve_stage_2' &&
          entry.stage === 'strategy' &&
          entry.category === 'approval'
            ? firstCheckpointCopy.message
            : entry.summary,
        details: entry.details,
        preview: readTextPreview(entry.preview_path ?? null) || undefined,
        actionLabel:
          entry.id === 'launch-review' && approval?.required
            ? approval.actionLabel
            : entry.action_label ?? undefined,
        actionHref:
          entry.id === 'launch-review' && approval?.required
            ? approval.actionHref
            : entry.action_href ?? undefined,
        ...(isVideoArtifact(entry)
          ? {
              type: 'video' as const,
              contentType: entry.contentType,
              url: entry.url,
              posterUrl: entry.posterUrl,
              platformSlug: entry.platformSlug,
              familyId: entry.familyId,
              durationSeconds: entry.durationSeconds,
              aspectRatio: entry.aspectRatio,
            }
          : {}),
      }))
    );
}

function buildTimeline(
  runtimeDoc: MarketingJobRuntimeDocument,
  state: ReturnType<typeof deriveState>
): MarketingTimelineEntry[] {
  const timeline: MarketingTimelineEntry[] = [];
  const firstCheckpointCopy = firstBrandAnalysisCheckpointCopy();

  if (runtimeDoc.created_at) {
    timeline.push({
      id: 'accepted',
      at: runtimeDoc.created_at,
      tone: 'info',
      label: 'Campaign accepted',
      description: 'Aries created the marketing job and started the direct Lobster pipeline.',
    });
  }

  for (const stage of ['research', 'strategy', 'production', 'publish'] as MarketingStage[]) {
    const record = runtimeDoc.stages[stage];
    if (record.completed_at) {
      timeline.push({
        id: `${stage}-completed`,
        at: record.completed_at,
        tone: 'success',
        label: `${STAGE_LABELS[stage]} completed`,
        description: record.summary?.summary || `${STAGE_LABELS[stage]} completed successfully.`,
      });
    } else if (record.status === 'awaiting_approval') {
      const firstBrandAnalysisGate = stage === 'strategy' && isApproveStage2Checkpoint(runtimeDoc);
      timeline.push({
        id: `${stage}-approval`,
        at: runtimeDoc.approvals.current?.requested_at ?? record.started_at,
        tone: 'warning',
        label: firstBrandAnalysisGate ? 'Brand analysis checkpoint requested' : `${STAGE_LABELS[stage]} approval requested`,
        description:
          (firstBrandAnalysisGate
            ? firstCheckpointCopy.message
            : runtimeDoc.approvals.current?.message ||
              `${STAGE_LABELS[stage]} is waiting on explicit approval.`),
      });
    } else if (record.failed_at) {
      timeline.push({
        id: `${stage}-failed`,
        at: record.failed_at,
        tone: 'danger',
        label: `${STAGE_LABELS[stage]} failed`,
        description: record.errors[record.errors.length - 1]?.message || `${STAGE_LABELS[stage]} failed.`,
      });
    } else if (record.started_at && record.status === 'in_progress') {
      timeline.push({
        id: `${stage}-running`,
        at: record.started_at,
        tone: 'info',
        label: `${STAGE_LABELS[stage]} running`,
        description: `${STAGE_LABELS[stage]} is actively executing.`,
      });
    }
  }

  if (runtimeDoc.status === 'completed') {
    timeline.push({
      id: 'publish-packages',
      at: runtimeDoc.updated_at,
      tone: 'success',
      label: 'Publish packages generated',
      description: 'Selected platform packages and review outputs were generated.',
    });
  }

  if (state.needsAttention && state.status !== 'awaiting_approval' && runtimeDoc.updated_at) {
    timeline.push({
      id: 'attention',
      at: runtimeDoc.updated_at,
      tone: 'danger',
      label: 'Operator attention required',
      description: 'A failure was recorded in the marketing runtime.',
    });
  }

  return timeline.sort((left, right) => {
    if (!left.at && !right.at) return 0;
    if (!left.at) return 1;
    if (!right.at) return -1;
    return left.at.localeCompare(right.at);
  });
}

async function buildReviewBundle(
  runtimeDoc: MarketingJobRuntimeDocument,
  facts: MarketingJobFacts,
): Promise<MarketingReviewBundle | null> {
  const jobId = runtimeDoc.job_id;
  const resolvedReview = await resolvePublishReviewBundle(runtimeDoc, facts);
  const review = resolvedReview.reviewPayload;
  const reviewBundle = resolvedReview.reviewBundle;
  if (!reviewBundle) {
    return null;
  }

  const landingPage = recordValue(reviewBundle.landing_page_preview);
  const scriptPreview = recordValue(reviewBundle.script_preview);
  const reviewPacket = recordValue(reviewBundle.review_packet);
  const artifactPaths = recordValue(reviewBundle.artifact_paths);
  const assetLinks = await buildMarketingAssetLinks(jobId, runtimeDoc, facts);
  const linkById = new Map(assetLinks.map((asset) => [asset.id, asset] as const));

  return {
    stage: 'publish',
    title: 'Pre-approval launch review',
    campaignName: stringValue(reviewBundle.campaign_name, stringValue(review?.campaign_name)),
    generatedAt: stringValue(review?.generated_at) || null,
    approvalMessage:
      normalizeArtifactText(stringValue(reviewBundle.approval_message)) ||
      normalizeArtifactText(stringValue(recordValue(review?.approval_preview)?.message)) ||
      ARTIFACT_UNAVAILABLE_TEXT,
    summary: (() => {
      const summaryCandidate =
        normalizeArtifactText(stringValue(recordValue(reviewBundle.summary)?.core_message)) ||
        normalizeArtifactText(stringValue(recordValue(reviewBundle.summary)?.offer_summary));
      return summaryCandidate || ARTIFACT_INCOMPLETE_TEXT;
    })(),
    previewAsset: linkById.get('launch-review-preview'),
    reviewPacketAssets: [
      linkById.get('review-packet-production'),
      linkById.get('review-packet-canonical'),
    ].filter((asset): asset is MarketingAssetLink => !!asset),
    landingPage: landingPage
      ? {
          headline: explicitArtifactValue(stringValue(landingPage.headline)),
          subheadline: explicitArtifactValue(stringValue(landingPage.subheadline)),
          cta: explicitArtifactValue(stringValue(landingPage.cta)),
          slug: stringValue(landingPage.slug) || undefined,
          sections: stringArray(landingPage.sections),
          asset: linkById.get('landing-page-path'),
        }
      : null,
    scriptPreview: scriptPreview
      ? {
          metaAdHook: explicitArtifactValue(stringValue(scriptPreview.meta_ad_hook)) || undefined,
          metaAdBody: stringArray(scriptPreview.meta_ad_body),
          shortVideoOpeningLine: explicitArtifactValue(stringValue(scriptPreview.short_video_opening_line)) || undefined,
          shortVideoBeats: stringArray(scriptPreview.short_video_beats),
          assets: [
            linkById.get('script-meta'),
            linkById.get('script-video'),
          ].filter((asset): asset is MarketingAssetLink => !!asset),
        }
      : null,
    platformPreviews: recordArray(reviewBundle.platform_previews).map((entry, index) => {
      const platformSlug = canonicalizePublishReviewPlatformSlug(
        entry.platform_slug,
        `platform-${index + 1}`,
      );
      const platformName = stringValue(entry.platform_name, `Platform ${index + 1}`);
      const directMediaAssets = stringArray(entry.media_paths)
        .map((_, mediaIndex) =>
          linkById.get(
            publishReviewMediaAssetId({
              platformSlug,
              previewIndex: index,
              explicitPreviewAssetId: entry.asset_preview_id,
              mediaIndex,
            }),
          ),
        )
        .filter((asset): asset is MarketingAssetLink => !!asset);
      const renderedVideoAsset = resolveRenderedVideoAssetLink(
        runtimeDoc,
        platformSlug,
        stringValue(entry.rendered_video_asset_id) || null,
        platformName,
      );
      const previewId = publishReviewPreviewAssetPrefix({
        platformSlug,
        previewIndex: index,
        explicitPreviewAssetId: entry.asset_preview_id,
      });
      return {
        id: previewId,
        platformSlug,
        platformName,
        channelType: stringValue(entry.channel_type, 'draft'),
        displayTitle: reviewPreviewDisplayTitle(platformName, entry),
        summary:
          normalizeArtifactText(stringValue(entry.summary)) ||
          normalizeArtifactText(stringValue(entry.headline)) ||
          ARTIFACT_UNAVAILABLE_TEXT,
        headline: stringValue(entry.headline) || undefined,
        hook: stringValue(entry.hook) || undefined,
        caption: stringValue(entry.caption_text) || undefined,
        cta: stringValue(entry.cta) || undefined,
        details: [
          ...stringArray(entry.proof_points),
          ...stringArray(recordValue(entry.format) ? Object.values(recordValue(entry.format) as Record<string, unknown>) : []),
        ],
        mediaAssets: mergePreviewMediaAssets(
          directMediaAssets.length > 0 ? directMediaAssets : fallbackPlatformMediaAssets(assetLinks, platformSlug),
          renderedVideoAsset,
        ),
        assetLinks: [
          linkById.get(
            publishReviewLinkedAssetId({
              platformSlug,
              previewIndex: index,
              explicitPreviewAssetId: entry.asset_preview_id,
              suffix: 'contract',
            }),
          ),
          linkById.get(
            publishReviewLinkedAssetId({
              platformSlug,
              previewIndex: index,
              explicitPreviewAssetId: entry.asset_preview_id,
              suffix: 'brief',
            }),
          ),
          linkById.get(
            publishReviewLinkedAssetId({
              platformSlug,
              previewIndex: index,
              explicitPreviewAssetId: entry.asset_preview_id,
              suffix: 'landing-page',
            }),
          ),
        ].filter((asset): asset is MarketingAssetLink => !!asset),
      };
    }),
  };
}

function isVideoArtifact(
  artifact: MarketingJobRuntimeDocument['stages'][MarketingStage]['artifacts'][number],
): artifact is Extract<MarketingJobRuntimeDocument['stages'][MarketingStage]['artifacts'][number], { type: 'video' }> {
  return 'type' in artifact && artifact.type === 'video';
}

function renderedVideoLabel(
  platformName: string,
  artifact: Extract<MarketingJobRuntimeDocument['stages'][MarketingStage]['artifacts'][number], { type: 'video' }>,
): string {
  const [, familyDisplay = artifact.familyId] = artifact.title.split(' — ');
  return `${platformName} video — ${familyDisplay}`;
}

function resolveRenderedVideoAssetLink(
  runtimeDoc: MarketingJobRuntimeDocument,
  platformSlug: string,
  explicitAssetId: string | null,
  platformName: string,
): MarketingAssetLink | null {
  let matchingArtifact: Extract<MarketingJobRuntimeDocument['stages'][MarketingStage]['artifacts'][number], { type: 'video' }> | null = null;
  for (const artifact of runtimeDoc.stages.production.artifacts) {
    if (!isVideoArtifact(artifact)) {
      continue;
    }
    if (artifact.id === explicitAssetId || (!explicitAssetId && artifact.platformSlug === platformSlug)) {
      matchingArtifact = artifact;
      break;
    }
  }

  if (!matchingArtifact) {
    return null;
  }

  return {
    id: matchingArtifact.id,
    label: renderedVideoLabel(platformName, matchingArtifact),
    url: matchingArtifact.url,
    contentType: matchingArtifact.contentType,
    posterUrl: matchingArtifact.posterUrl,
  };
}

function mergePreviewMediaAssets(
  assets: MarketingAssetLink[],
  renderedVideoAsset: MarketingAssetLink | null,
): MarketingAssetLink[] {
  if (!renderedVideoAsset) {
    return assets;
  }

  return [renderedVideoAsset, ...assets.filter((asset) => asset.id !== renderedVideoAsset.id)];
}

function fallbackPlatformMediaAssets(assetLinks: MarketingAssetLink[], platformSlug: string): MarketingAssetLink[] {
  return assetLinks.filter((asset) => {
    if (!/^(image|video)\//.test(asset.contentType)) {
      return false;
    }
    return (
      asset.id.startsWith(`publish-image-${platformSlug}`) ||
      asset.id.startsWith(`publish-fallback-${platformSlug}`) ||
      asset.id.startsWith(`publish-video-${platformSlug}`) ||
      asset.id.startsWith(`review-video-${platformSlug}`) ||
      asset.id.startsWith(`image-${platformSlug}`) ||
      asset.id.startsWith(`video-${platformSlug}`)
    );
  });
}

async function rawPublishReviewBundle(
  runtimeDoc: MarketingJobRuntimeDocument,
  facts: MarketingJobFacts,
): Promise<Record<string, unknown> | null> {
  return (await resolvePublishReviewBundle(runtimeDoc, facts)).reviewBundle;
}

async function publishReviewSource(
  runtimeDoc: MarketingJobRuntimeDocument,
  facts: MarketingJobFacts,
): Promise<'runtime' | 'merged_runtime_artifacts' | 'artifact_fallback' | 'none'> {
  return (await resolvePublishReviewBundle(runtimeDoc, facts)).source;
}

async function buildCampaignWindow(
  runtimeDoc: MarketingJobRuntimeDocument,
  facts: MarketingJobFacts,
): Promise<MarketingCampaignWindow | null> {
  const reviewBundle = await rawPublishReviewBundle(runtimeDoc, facts);
  const summary = recordValue(reviewBundle?.summary);
  const campaignWindow = recordValue(summary?.campaign_window);

  const start = stringValue(campaignWindow?.start) || null;
  const end = stringValue(campaignWindow?.end) || null;
  if (!start && !end) {
    return null;
  }

  return { start, end };
}

function buildDurationDays(window: MarketingCampaignWindow | null): number | null {
  if (!window?.start || !window.end) {
    return null;
  }

  const start = Date.parse(window.start);
  const end = Date.parse(window.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return null;
  }

  return Math.floor((end - start) / (24 * 60 * 60 * 1000)) + 1;
}

function buildAssetPreviewCards(jobId: string, reviewBundle: MarketingReviewBundle | null): MarketingAssetPreviewCard[] {
  if (!reviewBundle) {
    return [];
  }

  return reviewBundle.platformPreviews.map((preview) => ({
    id: preview.id,
    platformSlug: preview.platformSlug,
    platformName: preview.platformName,
    channelType: preview.channelType,
    title: preview.displayTitle || preview.platformName,
    summary: preview.summary,
    mediaCount: preview.mediaAssets.length,
    assetCount: preview.assetLinks.length,
    previewHref: `/marketing/job-approve?jobId=${encodeURIComponent(jobId)}&preview=${encodeURIComponent(preview.id)}`,
  }));
}

async function buildCalendarEvents(
  runtimeDoc: MarketingJobRuntimeDocument,
  facts: MarketingJobFacts,
): Promise<MarketingCalendarEvent[]> {
  const reviewBundle = await rawPublishReviewBundle(runtimeDoc, facts);
  const contentCalendar = recordValue(reviewBundle?.content_calendar);
  const events = recordArray(contentCalendar?.events);

  return events
    .map((event, index) => {
      const startsAt = stringValue(event.starts_at);
      if (!startsAt) {
        return null;
      }

      return {
        id: stringValue(event.id, `calendar-event-${index + 1}`),
        startsAt,
        endsAt: stringValue(event.ends_at) || null,
        platform: stringValue(event.platform, 'unknown'),
        title: stringValue(event.title, 'Scheduled campaign event'),
        status: stringValue(event.status, 'planned'),
        assetPreviewId: stringValue(event.asset_preview_id) || null,
      };
    })
    .filter((event): event is MarketingCalendarEvent => !!event);
}

async function buildPostCounts(
  runtimeDoc: MarketingJobRuntimeDocument,
  facts: MarketingJobFacts,
  reviewBundle: MarketingReviewBundle | null,
  calendarEvents: MarketingCalendarEvent[]
): Promise<{ plannedPostCount: number | null; createdPostCount: number | null }> {
  const rawBundle = await rawPublishReviewBundle(runtimeDoc, facts);
  const summary = recordValue(rawBundle?.summary);
  const explicitPlanned = numberValue(summary?.planned_posts);
  const explicitCreated = numberValue(summary?.created_posts);

  const fallbackPlanned = calendarEvents.length > 0
    ? calendarEvents.length
    : reviewBundle?.platformPreviews.length ?? 0;
  const fallbackCreated = calendarEvents.filter((event) => event.status === 'created' || event.status === 'published').length > 0
    ? calendarEvents.filter((event) => event.status === 'created' || event.status === 'published').length
    : reviewBundle?.platformPreviews.filter((preview) => preview.mediaAssets.length > 0).length ?? 0;

  return {
    plannedPostCount: explicitPlanned ?? (fallbackPlanned > 0 ? fallbackPlanned : null),
    createdPostCount: explicitCreated ?? (fallbackCreated > 0 ? fallbackCreated : null),
  };
}

async function buildMarketingJobStatus(
  jobId: string,
  facts?: MarketingJobFacts,
): Promise<MarketingJobStatusResponse> {
  await assertMarketingRuntimeSchemas();

  const runtimeDoc = facts?.runtimeDoc ?? await loadMarketingJobRuntime(jobId);
  if (!runtimeDoc) {
    return {
      jobId,
      tenantId: null,
      tenantName: null,
      brandWebsiteUrl: null,
      campaignWindow: null,
      durationDays: null,
      plannedPostCount: null,
      createdPostCount: null,
      assetPreviewCards: [],
      calendarEvents: [],
      state: 'not_found',
      status: 'error',
      currentStage: null,
      stageStatus: {},
      updatedAt: null,
      approvalRequired: false,
      needsAttention: false,
      summary: {
        headline: 'Campaign not found',
        subheadline: 'No local marketing runtime exists for this job yet.',
      },
      stageCards: [],
      artifacts: [],
      timeline: [],
      approval: null,
      reviewBundle: null,
      publishConfig: {
        platforms: [],
        livePublishPlatforms: [],
        videoRenderPlatforms: [],
      },
      nextStep: 'none',
      repairStatus: 'not_required',
    };
  }

  const resolvedFacts = facts ?? createMarketingJobFacts(runtimeDoc, null);
  const stageStatus: Record<string, string> = {
    research: responseStageStatus(runtimeDoc.stages.research),
    strategy: responseStageStatus(runtimeDoc.stages.strategy),
    production: responseStageStatus(runtimeDoc.stages.production),
    publish: responseStageStatus(runtimeDoc.stages.publish),
  };
  const state = deriveState(runtimeDoc, stageStatus);
  const approval = buildApproval(jobId, runtimeDoc);
  const reviewBundle = await buildReviewBundle(runtimeDoc, resolvedFacts);
  const campaignWindow = await buildCampaignWindow(runtimeDoc, resolvedFacts);
  const durationDays = buildDurationDays(campaignWindow);
  const assetPreviewCards = buildAssetPreviewCards(jobId, reviewBundle);
  const calendarEvents = await buildCalendarEvents(runtimeDoc, resolvedFacts);
  const postCounts = await buildPostCounts(runtimeDoc, resolvedFacts, reviewBundle, calendarEvents);
  const validatedProfile = await loadValidatedMarketingProfileSnapshot(runtimeDoc.tenant_id, {
    currentSourceUrl: runtimeDoc.inputs.brand_url || null,
  });
  if (shouldLogMarketingJobStatus()) {
    console.info('[marketing-hydration]', {
      event: 'job-status',
      jobId,
      tenantId: runtimeDoc.tenant_id,
      reviewBundleSource: await publishReviewSource(runtimeDoc, resolvedFacts),
      reviewBundleReason: reviewBundle ? 'hydrated' : 'no_real_publish_review_artifacts',
    });
  }

  return {
    jobId,
    tenantId: runtimeDoc.tenant_id,
    tenantName: validatedProfile.brandName || runtimeDoc.brand_kit?.brand_name || null,
    brandWebsiteUrl: validatedProfile.websiteUrl || runtimeDoc.brand_kit?.source_url || runtimeDoc.inputs.brand_url || null,
    campaignWindow,
    durationDays,
    plannedPostCount: postCounts.plannedPostCount,
    createdPostCount: postCounts.createdPostCount,
    assetPreviewCards,
    calendarEvents,
    state: state.state,
    status: state.status,
    currentStage: state.currentStage,
    stageStatus,
    updatedAt: runtimeDoc.updated_at,
    approvalRequired: !!runtimeDoc.approvals.current,
    needsAttention: state.needsAttention,
    summary: buildSummary(runtimeDoc, state),
    stageCards: buildStageCards(runtimeDoc, stageStatus),
    artifacts: buildArtifacts(runtimeDoc, approval),
    timeline: buildTimeline(runtimeDoc, state),
    approval,
    reviewBundle,
    publishConfig: {
      platforms: runtimeDoc.publish_config.platforms,
      livePublishPlatforms: runtimeDoc.publish_config.live_publish_platforms,
      videoRenderPlatforms: runtimeDoc.publish_config.video_render_platforms,
    },
    nextStep: state.nextStep,
    repairStatus: state.repairStatus,
  };
}

export async function getMarketingJobStatus(jobId: string): Promise<MarketingJobStatusResponse> {
  return buildMarketingJobStatus(jobId);
}
