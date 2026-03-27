import { requestJson, type ApiClientOptions } from './http';

export type MarketingJobType = 'brand_campaign';
export type MarketingStage = 'research' | 'strategy' | 'production' | 'publish';

export interface BrandCampaignPayload {
  brandUrl: string;
  competitorUrl: string;
  /** Optional intake fields stored on the runtime job `inputs.request` record */
  goal?: string;
  channels?: string[];
  mode?: string;
}

export interface PostMarketingJobsRequest {
  jobType: MarketingJobType;
  payload: BrandCampaignPayload;
}

export interface StartJobAccepted {
  marketing_job_status: 'accepted';
  jobId: string;
  jobType: MarketingJobType;
  marketing_stage: MarketingStage;
  approvalRequired: boolean;
  approval?: MarketingApprovalSummary | null;
  jobStatusUrl: string;
}

export interface MarketingStageCard {
  stage: MarketingStage;
  label: string;
  status: string;
  summary: string;
  highlight?: string;
}

export interface MarketingArtifactCard {
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

export interface MarketingAssetLink {
  id: string;
  url: string;
  label: string;
  contentType: string;
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

export interface MarketingReviewPreviewCard {
  id: string;
  platformSlug: string;
  platformName: string;
  channelType: string;
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
  calendarEvents: MarketingCalendarEvent[];
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
  approvedStages?: MarketingStage[];
  approvalId?: string;
  resumePublishIfNeeded?: boolean;
  publishConfig?: {
    platforms?: string[];
    livePublishPlatforms?: string[];
    videoRenderPlatforms?: string[];
  };
}

export interface ApproveJobResult {
  approval_status: 'resumed' | 'already_resolved' | 'denied' | 'error';
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

export function createMarketingApi(options: ApiClientOptions = {}) {
  return {
    createJob(body: PostMarketingJobsRequest) {
      return requestJson<MarketingResult<StartJobAccepted>>(
        '/api/marketing/jobs',
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
        options
      );
    },

    getJob(jobId: string) {
      return requestJson<MarketingResult<GetMarketingJobStatusResponse>>(
        `/api/marketing/jobs/${encodeURIComponent(jobId)}`,
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
        `/api/marketing/jobs/${encodeURIComponent(jobId)}/approve`,
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
