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
}

export interface PostMarketingJobApproveRequest {
  approvedBy: string;
  approvedStages?: MarketingStage[];
  resumePublishIfNeeded?: boolean;
  publishConfig?: {
    platforms?: string[];
    livePublishPlatforms?: string[];
    videoRenderPlatforms?: string[];
  };
}

export interface ApproveJobResult {
  approval_status: 'resumed' | 'error';
  jobId: string;
  resumedStage: string | null;
  completed: boolean;
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
