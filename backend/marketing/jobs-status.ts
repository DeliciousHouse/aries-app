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
import { resolvePublishReviewBundle } from './publish-review';
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

export type MarketingArtifactCard = {
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

function buildSummary(
  state: ReturnType<typeof deriveState>
): MarketingSummary {
  if (state.status === 'completed') {
    return {
      headline: 'Campaign outputs are ready',
      subheadline: 'Launch packages, review artifacts, and delivery summaries are available for the current campaign.',
    };
  }

  if (state.status === 'awaiting_approval') {
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

function buildStageCards(
  runtimeDoc: MarketingJobRuntimeDocument,
  stageStatus: Record<string, string>
): MarketingStageCard[] {
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
          summary: stageRecord.summary?.summary || 'Campaign strategy is ready.',
          highlight: stageRecord.summary?.highlight || undefined,
        };
      case 'production':
        return {
          stage,
          label: STAGE_LABELS[stage],
          status: stageStatus[stage],
          summary: stageRecord.summary?.summary || 'Production assets are ready.',
          highlight: stageRecord.summary?.highlight || undefined,
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
  return {
    required: true,
    status: approval.status,
    approvalId: approval.approval_id ?? undefined,
    workflowStepId: approval.workflow_step_id ?? undefined,
    title: approval.title,
    message: approval.message,
    actionLabel: 'Open approval dashboard',
    actionHref: `/marketing/job-approve?jobId=${encodeURIComponent(jobId)}`,
  };
}

function withDetails(...details: Array<string | null | undefined>): string[] {
  return details.filter((detail): detail is string => typeof detail === 'string' && detail.trim().length > 0);
}

function buildArtifacts(
  runtimeDoc: MarketingJobRuntimeDocument,
  approval: MarketingApprovalSummary | null
): MarketingArtifactCard[] {
  return Object.values(runtimeDoc.stages)
    .flatMap((stageRecord) =>
      stageRecord.artifacts.map((entry) => ({
        id: entry.id,
        stage: entry.stage,
        title: entry.title,
        category: entry.category,
        status: entry.status,
        summary: entry.summary,
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
      }))
    );
}

function buildTimeline(
  runtimeDoc: MarketingJobRuntimeDocument,
  state: ReturnType<typeof deriveState>
): MarketingTimelineEntry[] {
  const timeline: MarketingTimelineEntry[] = [];

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
      timeline.push({
        id: `${stage}-approval`,
        at: runtimeDoc.approvals.current?.requested_at ?? record.started_at,
        tone: 'warning',
        label: `${STAGE_LABELS[stage]} approval requested`,
        description:
          runtimeDoc.approvals.current?.message ||
          `${STAGE_LABELS[stage]} is waiting on explicit approval.`,
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

function buildReviewBundle(runtimeDoc: MarketingJobRuntimeDocument): MarketingReviewBundle | null {
  const jobId = runtimeDoc.job_id;
  const resolvedReview = resolvePublishReviewBundle(runtimeDoc);
  const review = resolvedReview.reviewPayload;
  const reviewBundle = resolvedReview.reviewBundle;
  if (!reviewBundle) {
    return null;
  }

  const landingPage = recordValue(reviewBundle.landing_page_preview);
  const scriptPreview = recordValue(reviewBundle.script_preview);
  const reviewPacket = recordValue(reviewBundle.review_packet);
  const artifactPaths = recordValue(reviewBundle.artifact_paths);
  const assetLinks = buildMarketingAssetLinks(jobId, runtimeDoc);
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
      const platformSlug = stringValue(entry.platform_slug, `platform-${index + 1}`);
      const platformName = stringValue(entry.platform_name, `Platform ${index + 1}`);
      const directMediaAssets = stringArray(entry.media_paths)
        .map((_, mediaIndex) => linkById.get(`platform-preview-${platformSlug}-media-${mediaIndex + 1}`))
        .filter((asset): asset is MarketingAssetLink => !!asset);
      return {
        id: `platform-preview-${platformSlug}`,
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
        mediaAssets: directMediaAssets.length > 0 ? directMediaAssets : fallbackPlatformMediaAssets(assetLinks, platformSlug),
        assetLinks: [
          linkById.get(`platform-preview-${platformSlug}-asset-contract`),
          linkById.get(`platform-preview-${platformSlug}-asset-brief`),
          linkById.get(`platform-preview-${platformSlug}-asset-landing-page`),
        ].filter((asset): asset is MarketingAssetLink => !!asset),
      };
    }),
  };
}

function fallbackPlatformMediaAssets(assetLinks: MarketingAssetLink[], platformSlug: string): MarketingAssetLink[] {
  return assetLinks.filter((asset) => {
    if (!asset.contentType.startsWith('image/')) {
      return false;
    }
    return (
      asset.id.startsWith(`publish-image-${platformSlug}`) ||
      asset.id.startsWith(`publish-fallback-${platformSlug}`) ||
      asset.id.startsWith(`image-${platformSlug}`)
    );
  });
}

function rawPublishReviewBundle(runtimeDoc: MarketingJobRuntimeDocument): Record<string, unknown> | null {
  return resolvePublishReviewBundle(runtimeDoc).reviewBundle;
}

function publishReviewSource(runtimeDoc: MarketingJobRuntimeDocument): 'runtime' | 'merged_runtime_artifacts' | 'artifact_fallback' | 'none' {
  return resolvePublishReviewBundle(runtimeDoc).source;
}

function buildCampaignWindow(runtimeDoc: MarketingJobRuntimeDocument): MarketingCampaignWindow | null {
  const reviewBundle = rawPublishReviewBundle(runtimeDoc);
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

function buildCalendarEvents(runtimeDoc: MarketingJobRuntimeDocument): MarketingCalendarEvent[] {
  const reviewBundle = rawPublishReviewBundle(runtimeDoc);
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

function buildPostCounts(
  runtimeDoc: MarketingJobRuntimeDocument,
  reviewBundle: MarketingReviewBundle | null,
  calendarEvents: MarketingCalendarEvent[]
): { plannedPostCount: number | null; createdPostCount: number | null } {
  const rawBundle = rawPublishReviewBundle(runtimeDoc);
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

export function getMarketingJobStatus(jobId: string): MarketingJobStatusResponse {
  assertMarketingRuntimeSchemas();

  const runtimeDoc = loadMarketingJobRuntime(jobId);
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

  const stageStatus: Record<string, string> = {
    research: responseStageStatus(runtimeDoc.stages.research),
    strategy: responseStageStatus(runtimeDoc.stages.strategy),
    production: responseStageStatus(runtimeDoc.stages.production),
    publish: responseStageStatus(runtimeDoc.stages.publish),
  };
  const state = deriveState(runtimeDoc, stageStatus);
  const approval = buildApproval(jobId, runtimeDoc);
  const reviewBundle = buildReviewBundle(runtimeDoc);
  const campaignWindow = buildCampaignWindow(runtimeDoc);
  const durationDays = buildDurationDays(campaignWindow);
  const assetPreviewCards = buildAssetPreviewCards(jobId, reviewBundle);
  const calendarEvents = buildCalendarEvents(runtimeDoc);
  const postCounts = buildPostCounts(runtimeDoc, reviewBundle, calendarEvents);
  const validatedProfile = loadValidatedMarketingProfileSnapshot(runtimeDoc.tenant_id);
  console.info('[marketing-hydration]', {
    event: 'job-status',
    jobId,
    tenantId: runtimeDoc.tenant_id,
    reviewBundleSource: publishReviewSource(runtimeDoc),
    reviewBundleReason: reviewBundle ? 'hydrated' : 'no_real_publish_review_artifacts',
  });

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
    summary: buildSummary(state),
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
