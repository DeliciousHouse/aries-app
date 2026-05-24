import { requestJson, type ApiClientOptions } from './http';
import type { ApprovalDenialReasonCode } from '@/lib/marketing/approval-denial-reason-codes';

export type MarketingJobType = 'weekly_social_content' | 'one_off_campaign';

/**
 * One-off campaign metadata. Present only when jobType === 'one_off_campaign'.
 * Presence of this object is the discriminator -- weekly campaigns leave it
 * undefined and downstream code branches on `payload.oneOff != null`.
 *
 * Fits any time-bound campaign shape: hackathons, product launches, sales,
 * webinars, fundraisers. The only structurally required dates are the campaign
 * end (drives the worker auto-stop) and the CTA destination; an optional
 * `milestoneDate` + `milestoneLabel` lets the operator capture one additional
 * date with whatever name fits the campaign ("Registration deadline" for a
 * hackathon, "Doors open" for a webinar, "Sale ends" for a flash sale, "Launch
 * day" for a product launch).
 *
 * Dates are submitted by the form as YYYY-MM-DD calendar dates. The submit
 * handler converts them to tenant-local end-of-day UTC instants (via
 * wallTimeToUtc + business_profiles.timezone) before they hit the wire or the
 * scheduled_posts.campaign_end_date column.
 */
export interface OneOffCampaignBrief {
  name: string;
  campaignEndDate: string;
  cta: string;
  milestoneDate?: string;
  milestoneLabel?: string;
}
export type MarketingStage = 'research' | 'strategy' | 'production' | 'publish';
export type MarketingWorkflowState =
  | 'draft'
  | 'brand_review_required'
  | 'strategy_review_required'
  | 'creative_review_required'
  | 'revisions_requested'
  | 'approved'
  | 'ready_to_publish'
  | 'published';
export type MarketingReviewType = 'brand' | 'strategy' | 'creative' | 'workflow_approval';
export type MarketingReviewDecisionStatus =
  | 'not_ready'
  | 'pending_review'
  | 'approved'
  | 'changes_requested'
  | 'rejected';

export interface MarketingBriefAssetUploadMetadata {
  name: string;
  contentType: string;
  size: number;
}

export interface BrandCampaignPayload {
  brandUrl: string;
  competitorUrl?: string;
  competitorBrand?: string;
  facebookPageUrl?: string;
  adLibraryUrl?: string;
  metaPageId?: string;
  competitorFacebookUrl?: string;
  businessName?: string;
  businessType?: string;
  approverName?: string;
  /** Optional intake fields stored on the runtime job `inputs.request` record */
  websiteUrl?: string;
  brandVoice?: string;
  styleVibe?: string;
  visualReferences?: string[];
  mustUseCopy?: string;
  mustAvoidAesthetics?: string;
  notes?: string;
  brandAssetsMetadata?: MarketingBriefAssetUploadMetadata[];
  primaryGoal?: string;
  goal?: string;
  launchApproverName?: string;
  offer?: string;
  audience?: string;
  channels?: string[];
  mode?: string;
  forbiddenVisualPatterns?: string[];
  staticPostsCount?: number | string;
  imageCreativesCount?: number | string;
  videoScriptsCount?: number | string;
  renderVideoAfterApproval?: boolean | string;
  /**
   * One-off campaign metadata. Present only when the parent
   * PostMarketingJobsRequest.jobType === 'one_off_campaign'. Weekly campaigns
   * leave this undefined.
   */
  oneOff?: OneOffCampaignBrief;
}

export interface PostMarketingJobsRequest {
  jobType: MarketingJobType;
  payload: BrandCampaignPayload;
}

export interface StartJobAccepted {
  marketing_job_status: 'accepted' | 'needs_connection';
  jobId: string;
  jobType: MarketingJobType;
  marketing_stage: MarketingStage;
  approvalRequired: boolean;
  approval?: MarketingApprovalSummary | null;
  reason?: string;
  message?: string;
  jobStatusUrl: string;
}

export interface MarketingStageCard {
  stage: MarketingStage;
  label: string;
  status: string;
  summary: string;
  highlight?: string;
}

interface MarketingArtifactCardBase {
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
}

export interface MarketingVideoArtifactCard extends MarketingArtifactCardBase {
  type: 'video';
  contentType: 'video/mp4';
  url: string;
  posterUrl: string;
  platformSlug: string;
  familyId: string;
  durationSeconds: number;
  aspectRatio: string;
}

export type MarketingArtifactCard = MarketingArtifactCardBase | MarketingVideoArtifactCard;

export interface MarketingTimelineEntry {
  id: string;
  at: string | null;
  tone: 'info' | 'success' | 'warning' | 'danger';
  label: string;
  description: string;
}

export interface MarketingCampaignWindow {
  start: string | null;
  end: string | null;
}

export interface MarketingAssetPreviewCard {
  id: string;
  platformSlug: string;
  platformName: string;
  channelType: string;
  title: string;
  summary: string;
  mediaCount: number;
  assetCount: number;
  previewHref: string;
}

export interface MarketingCalendarEvent {
  id: string;
  startsAt: string;
  endsAt: string | null;
  platform: string;
  title: string;
  status: string;
  assetPreviewId: string | null;
}

export interface SocialContentCalendarEvent {
  id: string;
  jobId: string;
  dayIndex: number;
  startsAt: string;
  endsAt: string | null;
  platform: string;
  platformLabel: string;
  title: string;
  postType: 'static' | 'image' | 'video_script' | 'video_render' | 'publish';
  status: 'draft' | 'needs_review' | 'approved' | 'scheduled' | 'published';
  assetPreviewId: string | null;
}

export interface MarketingAssetLink {
  id: string;
  url: string;
  label: string;
  contentType: string;
  posterUrl?: string | null;
}

export interface MarketingApprovalSummary {
  required: boolean;
  status: string;
  approvalId?: string;
  workflowStepId?: string;
  title: string;
  message: string;
  actionLabel?: string;
  actionHref?: string;
}

export interface MarketingBrandIdentity {
  summary: string | null;
  positioning: string | null;
  audience: string | null;
  offer: string | null;
  promise: string | null;
  toneOfVoice: string | null;
  styleVibe: string | null;
  ctaStyle: string | null;
  proofStyle: string | null;
  provenance: {
    source_url: string | null;
    canonical_url: string | null;
    source_fingerprint: string | null;
  };
}

export interface MarketingReviewPreviewCard {
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
}

export interface MarketingReviewBundle {
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
}

export interface MarketingCampaignBriefAsset {
  id: string;
  name: string;
  fileName: string;
  contentType: string;
  size: number;
  uploadedAt: string;
  url: string;
}

export interface MarketingCampaignBrief {
  websiteUrl: string;
  businessName: string;
  businessType: string;
  approverName: string;
  goal: string;
  offer: string;
  competitorUrl: string;
  channels: string[];
  brandVoice: string;
  styleVibe: string;
  visualReferences: string[];
  mustUseCopy: string;
  mustAvoidAesthetics: string;
  notes: string;
  brandAssets: MarketingCampaignBriefAsset[];
}

export interface MarketingCampaignStatusHistoryEntry {
  id: string;
  at: string;
  actor: string;
  type: 'state_changed' | 'stage_review' | 'creative_asset_review' | 'comment';
  workflowState: MarketingWorkflowState;
  stage?: 'brand' | 'strategy' | 'creative';
  assetId?: string;
  action?: 'approve' | 'changes_requested' | 'reject';
  note?: string | null;
  status?: MarketingReviewDecisionStatus;
}

export interface MarketingReviewSection {
  id: string;
  title: string;
  body: string;
  brandKitVisuals?: {
    logos: string[];
    colors: Array<{
      label: string;
      hex: string;
    }>;
    fonts: Array<{
      label: string;
      family: string;
      sampleText: string;
    }>;
  };
}

export interface MarketingReviewAttachment {
  id: string;
  label: string;
  url: string;
  contentType: string;
  kind: 'brand_asset' | 'document' | 'preview' | 'artifact';
  posterUrl?: string | null;
}

export interface MarketingStageReviewPayload {
  reviewId: string;
  reviewType: Extract<MarketingReviewType, 'brand' | 'strategy'>;
  status: MarketingReviewDecisionStatus;
  title: string;
  summary: string;
  notePlaceholder: string;
  brandIdentity?: MarketingBrandIdentity | null;
  sections: MarketingReviewSection[];
  attachments: MarketingReviewAttachment[];
  history: MarketingCampaignStatusHistoryEntry[];
  latestNote: string | null;
}

export interface MarketingCreativeAssetReviewPayload {
  reviewId: string;
  reviewType: 'creative';
  assetId: string;
  title: string;
  summary: string;
  platformLabel: string;
  status: MarketingReviewDecisionStatus;
  contentType: string | null;
  previewUrl: string | null;
  fullPreviewUrl: string | null;
  destinationUrl: string | null;
  notes: string[];
  latestNote: string | null;
  history: MarketingCampaignStatusHistoryEntry[];
}

export interface MarketingCreativeReviewPayload {
  status: MarketingReviewDecisionStatus;
  title: string;
  summary: string;
  latestNote: string | null;
  approvalComplete: boolean;
  approvedCount: number;
  pendingCount: number;
  rejectedCount: number;
  publishBlockedReason: string | null;
  assets: MarketingCreativeAssetReviewPayload[];
  history: MarketingCampaignStatusHistoryEntry[];
}

export type MarketingDashboardItemStatus =
  | 'draft'
  | 'in_review'
  | 'ready'
  | 'ready_to_publish'
  | 'published_to_meta_paused'
  | 'scheduled'
  | 'live';

export type MarketingDashboardSourceKind =
  | 'live_platform'
  | 'live_publish_result'
  | 'publish_review'
  | 'creative_output'
  | 'proposal';

export interface MarketingDashboardProvenance {
  sourceKind: MarketingDashboardSourceKind;
  sourceStage: MarketingStage | 'runtime';
  sourceRunId: string | null;
  isDerivedSchedule: boolean;
  isPlatformNative: boolean;
}

export type MarketingDashboardAssetType =
  | 'landing_page'
  | 'image_ad'
  | 'video_ad'
  | 'script'
  | 'copy'
  | 'contract'
  | 'proposal_document'
  | 'review_package'
  | 'publish_package';

export type MarketingDashboardPostType =
  | 'platform_post'
  | 'meta_ad'
  | 'pre_publish_ad'
  | 'creative_output'
  | 'proposal_concept';

export type MarketingDashboardPublishItemType =
  | 'pre_publish_review'
  | 'publish_package'
  | 'meta_paused_ad'
  | 'scheduled_post'
  | 'live_post';

export type MarketingDashboardCampaignCompatibilityStatus =
  | 'draft'
  | 'in_review'
  | 'approved'
  | 'scheduled'
  | 'live'
  | 'changes_requested';

export interface MarketingDashboardAsset {
  id: string;
  campaignId: string;
  jobId: string;
  type: MarketingDashboardAssetType;
  title: string;
  summary: string;
  platform: string;
  platformLabel: string;
  campaignName: string;
  funnelStage: string | null;
  objective: string;
  destinationUrl: string | null;
  previewUrl: string | null;
  thumbnailUrl: string | null;
  contentType: string | null;
  status: MarketingDashboardItemStatus;
  createdAt: string | null;
  relatedPostIds: string[];
  relatedPublishItemIds: string[];
  provenance: MarketingDashboardProvenance;
}

export interface MarketingDashboardPost {
  id: string;
  campaignId: string;
  jobId: string;
  type: MarketingDashboardPostType;
  title: string;
  summary: string;
  caption: string | null;
  hashtags: string[];
  cta: string | null;
  copyWarnings: string[];
  platform: string;
  platformLabel: string;
  campaignName: string;
  funnelStage: string | null;
  objective: string;
  destinationUrl: string | null;
  previewAssetId: string | null;
  status: MarketingDashboardItemStatus;
  createdAt: string | null;
  conceptId: string | null;
  relatedAssetIds: string[];
  relatedPublishItemIds: string[];
  provenance: MarketingDashboardProvenance;
}

export interface MarketingDashboardPublishItem {
  id: string;
  campaignId: string;
  jobId: string;
  type: MarketingDashboardPublishItemType;
  title: string;
  summary: string;
  platform: string;
  platformLabel: string;
  campaignName: string;
  funnelStage: string | null;
  objective: string;
  destinationUrl: string | null;
  previewAssetId: string | null;
  status: MarketingDashboardItemStatus;
  createdAt: string | null;
  relatedAssetIds: string[];
  relatedPostIds: string[];
  provenance: MarketingDashboardProvenance;
}

export interface MarketingDashboardCalendarEvent {
  id: string;
  campaignId: string;
  jobId: string;
  title: string;
  platform: string;
  platformLabel: string;
  startsAt: string;
  endsAt: string | null;
  status: MarketingDashboardItemStatus;
  statusLabel: string;
  campaignName: string;
  funnelStage: string | null;
  objective: string;
  destinationUrl: string | null;
  previewAssetId: string | null;
  sourcePostId: string | null;
  sourcePublishItemId: string | null;
  provenance: MarketingDashboardProvenance;
}

export interface MarketingDashboardStatusSummary {
  countsByStatus: Record<MarketingDashboardItemStatus, number>;
}

export interface MarketingDashboardCampaign {
  id: string;
  jobId: string;
  externalCampaignId: string;
  name: string;
  objective: string;
  funnelStage: string | null;
  summary: string;
  stageLabel: string;
  status: MarketingDashboardItemStatus;
  compatibilityStatus: MarketingDashboardCampaignCompatibilityStatus;
  campaignWindow: MarketingCampaignWindow | null;
  updatedAt: string | null;
  approvalRequired: boolean;
  approvalActionHref?: string;
  previewPostIds: string[];
  previewAssetIds: string[];
  postIds: string[];
  assetIds: string[];
  publishItemIds: string[];
  calendarEventIds: string[];
  counts: {
    posts: number;
    landingPages: number;
    imageAds: number;
    videoAds: number;
    scripts: number;
    publishItems: number;
    proposalConcepts: number;
    ready: number;
    readyToPublish: number;
    pausedMetaAds: number;
    scheduled: number;
    live: number;
  };
  provenance: MarketingDashboardProvenance;
}

export interface MarketingDashboardContent {
  campaigns: MarketingDashboardCampaign[];
  posts: MarketingDashboardPost[];
  assets: MarketingDashboardAsset[];
  publishItems: MarketingDashboardPublishItem[];
  calendarEvents: MarketingDashboardCalendarEvent[];
  statuses: MarketingDashboardStatusSummary;
}

export interface MarketingDashboardCampaignContent {
  campaign: MarketingDashboardCampaign | null;
  posts: MarketingDashboardPost[];
  assets: MarketingDashboardAsset[];
  publishItems: MarketingDashboardPublishItem[];
  calendarEvents: MarketingDashboardCalendarEvent[];
  statuses: MarketingDashboardStatusSummary;
}

export interface GetMarketingJobStatusResponse {
  jobId: string;
  tenantName: string | null;
  brandWebsiteUrl: string | null;
  campaignWindow: MarketingCampaignWindow | null;
  durationDays: number | null;
  plannedPostCount: number | null;
  createdPostCount: number | null;
  assetPreviewCards: MarketingAssetPreviewCard[];
  calendarEvents: Array<MarketingCalendarEvent | SocialContentCalendarEvent>;
  marketing_job_state: string;
  marketing_job_status: string;
  marketing_stage: string | null;
  marketing_stage_status: Record<string, string>;
  updatedAt: string | null;
  needs_attention: boolean;
  approvalRequired: boolean;
  summary: {
    headline: string;
    subheadline: string;
  };
  stageCards: MarketingStageCard[];
  artifacts: MarketingArtifactCard[];
  timeline: MarketingTimelineEntry[];
  approval: MarketingApprovalSummary | null;
  reviewBundle: MarketingReviewBundle | null;
  campaignBrief: MarketingCampaignBrief | null;
  workflowState: MarketingWorkflowState;
  statusHistory: MarketingCampaignStatusHistoryEntry[];
  brandReview: MarketingStageReviewPayload | null;
  strategyReview: MarketingStageReviewPayload | null;
  creativeReview: MarketingCreativeReviewPayload | null;
  publishConfig: {
    platforms: string[];
    livePublishPlatforms: string[];
    videoRenderPlatforms: string[];
  };
  nextStep: string;
  repairStatus: string;
  dashboard: MarketingDashboardCampaignContent;
}

export type GetMarketingPostsResponse = MarketingDashboardContent;

export interface PostMarketingJobApproveRequest {
  approvedBy: string;
  approved?: boolean;
  approvalStep?:
    | 'approve_weekly_plan'
    | 'approve_post_copy'
    | 'approve_image_creatives'
    | 'approve_video_script'
    | 'approve_video_render'
    | 'approve_publish';
  approvedStages?: MarketingStage[];
  approvalId?: string;
  resumePublishIfNeeded?: boolean;
  publishConfig?: {
    platforms?: string[];
    livePublishPlatforms?: string[];
    videoRenderPlatforms?: string[];
  };
  /** Structured denial reason for Honcho mirror; optional free-text goes in denialNote only (Aries DB). */
  denialReasonCode?: ApprovalDenialReasonCode;
  denialNote?: string;
}

export interface ApproveJobResult {
  approval_status: 'submitted' | 'resumed' | 'already_resolved' | 'denied' | 'error';
  jobId: string;
  resumedStage: string | null;
  completed: boolean;
  approvalId?: string | null;
  reason?: string;
  jobStatusUrl?: string;
}

export interface MarketingApiError {
  error: string;
  reason?: string;
  message?: string;
  [key: string]: unknown;
}

export type MarketingResult<TData> = TData | MarketingApiError;

export interface MarketingApiClientOptions extends ApiClientOptions {
  jobStatusPath?: string;
  jobApprovePath?: string;
}

export function createMarketingApi(options: MarketingApiClientOptions = {}) {
  const jobStatusPath = options.jobStatusPath ?? '/api/marketing/jobs';
  const jobApprovePath = options.jobApprovePath ?? '/api/marketing/jobs';

  return {
    createJob(body: PostMarketingJobsRequest | FormData) {
      return requestJson<MarketingResult<StartJobAccepted>>(
        '/api/marketing/jobs',
        {
          method: 'POST',
          body: body instanceof FormData ? body : JSON.stringify(body),
        },
        options
      );
    },

    getJob(jobId: string) {
      return requestJson<MarketingResult<GetMarketingJobStatusResponse>>(
        `${jobStatusPath}/${encodeURIComponent(jobId)}`,
        { method: 'GET' },
        options
      );
    },

    getLatestJob() {
      return requestJson<MarketingResult<GetMarketingJobStatusResponse>>(
        '/api/marketing/jobs/latest',
        { method: 'GET' },
        options
      );
    },

    getPosts() {
      return requestJson<MarketingResult<GetMarketingPostsResponse>>(
        '/api/marketing/posts',
        { method: 'GET' },
        options
      );
    },

    approveJob(jobId: string, body: PostMarketingJobApproveRequest) {
      return requestJson<MarketingResult<ApproveJobResult>>(
        `${jobApprovePath}/${encodeURIComponent(jobId)}/approve`,
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
        options
      );
    },
  };
}

export function isMarketingErrorResult<TData>(
  value: MarketingResult<TData>
): value is MarketingApiError {
  return typeof (value as MarketingApiError)?.error === 'string';
}

/** Map backend field names to the camelCase field names used by the new-job form. */
const MARKETING_FIELD_ALIAS: Record<string, string> = {
  website_url: 'websiteUrl',
  brand_url: 'websiteUrl',
  websiteurl: 'websiteUrl',
  brandurl: 'websiteUrl',
  competitor_url: 'competitorUrl',
  competitorurl: 'competitorUrl',
  brand_voice: 'brandVoice',
  style_vibe: 'styleVibe',
};

function normalizeFieldName(raw: string): string {
  const lower = raw.toLowerCase();
  if (MARKETING_FIELD_ALIAS[lower]) return MARKETING_FIELD_ALIAS[lower];
  return raw;
}

/**
 * Extract field-level validation errors from a 422 response body. Supports
 *   - { errors: [{ field, message }] }
 *   - { detail: [{ loc: [..., 'field'], msg }] }   (FastAPI / pydantic)
 *   - { fieldErrors: { field: 'message' } }
 * Returns an empty object if no structured field errors are present.
 */
export function parseMarketingFieldErrors(body: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!body || typeof body !== 'object') return out;
  const b = body as Record<string, unknown>;

  const fieldErrors = b.fieldErrors;
  if (fieldErrors && typeof fieldErrors === 'object' && !Array.isArray(fieldErrors)) {
    for (const [k, v] of Object.entries(fieldErrors as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim()) {
        out[normalizeFieldName(k)] = v;
      }
    }
  }

  const errors = b.errors;
  if (Array.isArray(errors)) {
    for (const entry of errors) {
      if (entry && typeof entry === 'object') {
        const e = entry as Record<string, unknown>;
        const field = typeof e.field === 'string' ? e.field : typeof e.path === 'string' ? e.path : null;
        const message =
          typeof e.message === 'string'
            ? e.message
            : typeof e.msg === 'string'
              ? e.msg
              : null;
        if (field && message && !out[normalizeFieldName(field)]) {
          out[normalizeFieldName(field)] = message;
        }
      }
    }
  }

  const detail = b.detail;
  if (Array.isArray(detail)) {
    for (const entry of detail) {
      if (entry && typeof entry === 'object') {
        const e = entry as Record<string, unknown>;
        const loc = Array.isArray(e.loc) ? e.loc : null;
        const msg = typeof e.msg === 'string' ? e.msg : typeof e.message === 'string' ? e.message : null;
        if (loc && loc.length && msg) {
          // Pick the last string segment as the field name (skip 'body'/'query' prefix).
          let field: string | null = null;
          for (let i = loc.length - 1; i >= 0; i -= 1) {
            const seg = loc[i];
            if (typeof seg === 'string' && seg !== 'body' && seg !== 'query') {
              field = seg;
              break;
            }
          }
          if (field && !out[normalizeFieldName(field)]) {
            out[normalizeFieldName(field)] = msg;
          }
        }
      }
    }
  }

  return out;
}

/**
 * Simple client-side validator used to block obviously-invalid URLs before hitting
 * the server. Intentionally permissive — the backend remains the source of truth.
 */
export function isValidWebsiteUrl(value: string | null | undefined): boolean {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return false;
  return /^https?:\/\/[^\s.]+\.[^\s]+$/i.test(trimmed);
}
