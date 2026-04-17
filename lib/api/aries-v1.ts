import { requestJson, requestJsonWithRetry, type ApiClientOptions } from './http';
import type {
  MarketingCampaignStatusHistoryEntry,
  MarketingDashboardAsset,
  MarketingDashboardCalendarEvent,
  MarketingDashboardCampaignContent,
  MarketingDashboardContent,
  MarketingDashboardItemStatus,
  MarketingDashboardPost,
  MarketingDashboardPublishItem,
  MarketingReviewAttachment,
  MarketingBrandIdentity,
  MarketingReviewSection,
  MarketingDashboardStatusSummary,
  MarketingWorkflowState,
} from './marketing';
import type { TenantUserProfile } from '@/backend/tenant/user-profiles';

export type AriesCampaignStatus =
  | 'draft'
  | 'in_review'
  | 'approved'
  | 'scheduled'
  | 'live'
  | 'changes_requested'
  | 'rejected';

export type RuntimeCampaignListItem = {
  id: string;
  jobId: string;
  name: string;
  objective: string;
  funnelStage: string | null;
  status: AriesCampaignStatus;
  dashboardStatus: AriesItemStatus;
  stageLabel: string;
  summary: string;
  dateRange: string;
  pendingApprovals: number;
  nextScheduled: string;
  trustNote: string;
  updatedAt: string | null;
  approvalRequired: boolean;
  approvalActionHref?: string;
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
  previewPosts: AriesDashboardPost[];
  previewAssets: AriesDashboardAsset[];
  dashboard: AriesDashboardCampaignContent;
  /** Set when the campaign has been soft-deleted (Recycle Bin entry). */
  deletedAt?: string | null;
  /** User id of whoever soft-deleted the campaign. Paired with deletedAt. */
  deletedBy?: string | null;
  /** Set when the delete landed while the pipeline was still running. The
   * orchestrator will stop starting new stages and (best-effort) the
   * gateway will abort the in-flight run. Until the pipeline reaches a
   * terminal state, the UI shows "Cancelling..." instead of just "Deleted". */
  softCancelRequestedAt?: string | null;
};

export type RuntimeReviewDecision = {
  action: 'approve' | 'changes_requested' | 'reject';
  actedBy: string;
  note: string | null;
  at: string;
};

export type RuntimeReviewItem = {
  id: string;
  jobId: string;
  campaignId: string;
  campaignName: string;
  reviewType: 'brand' | 'strategy' | 'creative' | 'workflow_approval';
  workflowState: MarketingWorkflowState;
  workflowStage: string | null;
  title: string;
  channel: string;
  placement: string;
  scheduledFor: string;
  status: AriesCampaignStatus;
  summary: string;
  currentVersion: {
    id: string;
    label: string;
    headline: string;
    supportingText: string;
    cta: string;
    notes: string[];
  };
  previousVersion?: {
    id: string;
    label: string;
    headline: string;
    supportingText: string;
    cta: string;
    notes: string[];
  };
  lastDecision: RuntimeReviewDecision | null;
  notePlaceholder?: string;
  assetId?: string;
  contentType?: string | null;
  previewUrl?: string | null;
  fullPreviewUrl?: string | null;
  destinationUrl?: string | null;
  sections: MarketingReviewSection[];
  attachments: MarketingReviewAttachment[];
  history: MarketingCampaignStatusHistoryEntry[];
};

export type BusinessProfileView = {
  tenantId: string;
  businessName: string;
  tenantSlug: string;
  websiteUrl: string | null;
  businessType: string | null;
  primaryGoal: string | null;
  launchApproverUserId: string | null;
  launchApproverName: string | null;
  offer: string | null;
  brandVoice: string | null;
  styleVibe: string | null;
  notes: string | null;
  competitorUrl: string | null;
  channels: string[];
  brandIdentity?: MarketingBrandIdentity | null;
  brandKit: {
    brand_name: string;
    source_url: string;
    canonical_url: string | null;
    logo_urls: string[];
    colors: {
      primary: string | null;
      secondary: string | null;
      accent: string | null;
      palette: string[];
    };
    font_families: string[];
    external_links: Array<{
      platform: string;
      url: string;
    }>;
    extracted_at: string;
    brand_voice_summary: string | null;
    offer_summary: string | null;
  } | null;
  incomplete: boolean;
};

export type UrlPreviewBrandKitPreview = {
  brandName: string;
  canonicalUrl: string | null;
  logoUrls: string[];
  colors: {
    primary: string | null;
    secondary: string | null;
    accent: string | null;
    palette: string[];
  };
  fontFamilies: string[];
  externalLinks: Array<{
    platform: string;
    url: string;
  }>;
  extractedAt: string;
  brandVoiceSummary: string | null;
  offerSummary: string | null;
};

export type UrlPreviewResponse = {
  title: string;
  favicon: string;
  domain: string;
  description: string;
  canonicalUrl: string | null;
  brandKitPreview: UrlPreviewBrandKitPreview | null;
};

export type OnboardingDraftStatus =
  | 'draft'
  | 'ready_for_auth'
  | 'materializing'
  | 'materialized';

export type OnboardingDraft = {
  draftId: string;
  status: OnboardingDraftStatus;
  websiteUrl: string;
  businessName: string;
  businessType: string;
  approverName: string;
  channels: string[];
  goal: string;
  offer: string;
  competitorUrl: string;
  preview: UrlPreviewResponse | null;
  provenance: {
    source_url: string | null;
    canonical_url: string | null;
    source_fingerprint: string | null;
  };
  createdAt: string;
  updatedAt: string;
  materializedTenantId: string | null;
  materializedJobId: string | null;
};

export type CampaignListResponse = {
  campaigns: RuntimeCampaignListItem[];
  /** Soft-deleted campaigns in the same shape as `campaigns`. Feeds the
   * Recycle Bin / "Deleted campaigns" section of the campaign list screen
   * so users can see what they deleted and restore if needed. */
  deletedCampaigns: RuntimeCampaignListItem[];
};
export type ReviewQueueResponse = { reviews: RuntimeReviewItem[]; archivedReviews?: RuntimeReviewItem[] };
export type ReviewItemResponse = { review: RuntimeReviewItem };
export type ReviewDecisionRequest = {
  action: 'approve' | 'changes_requested' | 'reject';
  actedBy: string;
  note?: string;
  approvalId?: string;
};
export type BusinessProfileResponse = { profile: BusinessProfileView };
export type OnboardingDraftResponse = { draft: OnboardingDraft };
export type BusinessProfilePatch = {
  businessName?: string | null;
  websiteUrl?: string | null;
  businessType?: string | null;
  primaryGoal?: string | null;
  launchApproverUserId?: string | null;
  launchApproverName?: string | null;
  offer?: string | null;
  brandVoice?: string | null;
  styleVibe?: string | null;
  notes?: string | null;
  competitorUrl?: string | null;
  channels?: string[] | null;
};
export type TenantProfilesResponse = { profiles: TenantUserProfile[] };
export type OnboardingDraftPatch = {
  status?: OnboardingDraftStatus;
  websiteUrl?: string | null;
  businessName?: string | null;
  businessType?: string | null;
  approverName?: string | null;
  channels?: string[] | null;
  goal?: string | null;
  offer?: string | null;
  competitorUrl?: string | null;
  preview?: UrlPreviewResponse | null;
  provenance?: {
    source_url?: string | null;
    canonical_url?: string | null;
    source_fingerprint?: string | null;
  } | null;
  materializedTenantId?: string | null;
  materializedJobId?: string | null;
};

export type AriesAssetVersion = RuntimeReviewItem['currentVersion'];
export type AriesRecommendation = {
  id: string;
  title: string;
  summary: string;
  actionLabel: string;
  href: string;
};
export type AriesKpi = {
  label: string;
  value: string;
  delta: string;
  tone: 'good' | 'neutral' | 'watch';
};
export type AriesItemStatus = MarketingDashboardItemStatus;
export type AriesScheduleItem = {
  id: string;
  title: string;
  channel: string;
  scheduledFor: string;
  status: AriesCampaignStatus | AriesItemStatus;
};
export type AriesChannelConnection = {
  id: string;
  name: string;
  handle: string;
  health: 'connected' | 'attention' | 'not_connected';
  detail: string;
  /** When false, disconnect is not offered by the integration (UI hides Disconnect). */
  canDisconnect: boolean;
};
export type AriesCampaign = RuntimeCampaignListItem & {
  plan: {
    goal: string;
    audience: string;
    message: string;
    offer: string;
    channels: string[];
    whyNow: string;
  };
  creative: {
    heroTitle: string;
    summary: string;
    assets: Array<{
      id: string;
      name: string;
      type: string;
      status: AriesCampaignStatus;
      channel: string;
      summary: string;
    }>;
  };
  schedule: AriesScheduleItem[];
  results: {
    headline: string;
    summary: string;
    kpis: AriesKpi[];
    trend: Array<{ label: string; leads: number; bookings: number }>;
  };
  recommendations: AriesRecommendation[];
  activity: Array<{ id: string; label: string; detail: string; at: string }>;
};
export type AriesReviewItem = RuntimeReviewItem;
export type AriesDashboardAsset = MarketingDashboardAsset;
export type AriesDashboardPost = MarketingDashboardPost;
export type AriesDashboardPublishItem = MarketingDashboardPublishItem;
export type AriesDashboardCalendarEvent = MarketingDashboardCalendarEvent;
export type AriesDashboardStatusSummary = MarketingDashboardStatusSummary;
export type AriesDashboardCampaignContent = MarketingDashboardCampaignContent;
export type PostsInventoryResponse = MarketingDashboardContent;

export function createAriesV1Api(options: ApiClientOptions = {}) {
  return {
    getCampaigns() {
      return requestJson<CampaignListResponse>('/api/marketing/campaigns', { method: 'GET' }, options);
    },
    getReviews() {
      return requestJson<ReviewQueueResponse>('/api/marketing/reviews', { method: 'GET' }, options);
    },
    getPosts() {
      return requestJson<PostsInventoryResponse>('/api/marketing/posts', { method: 'GET' }, options);
    },
    getReviewItem(reviewId: string) {
      return requestJson<ReviewItemResponse>(`/api/marketing/reviews/${encodeURIComponent(reviewId)}`, { method: 'GET' }, options);
    },
    decideReview(reviewId: string, body: ReviewDecisionRequest) {
      return requestJsonWithRetry<ReviewItemResponse>(
        `/api/marketing/reviews/${encodeURIComponent(reviewId)}/decision`,
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
        { retryOn: [502, 503, 504], maxAttempts: 2, backoffMs: 500 },
        options,
      );
    },
    getBusinessProfile() {
      return requestJson<BusinessProfileResponse>('/api/business/profile', { method: 'GET' }, options);
    },
    updateBusinessProfile(body: BusinessProfilePatch) {
      return requestJson<BusinessProfileResponse>('/api/business/profile', {
        method: 'PATCH',
        body: JSON.stringify(body),
      }, options);
    },
    createOnboardingDraft() {
      return requestJson<OnboardingDraftResponse>('/api/onboarding/draft', { method: 'POST' }, options);
    },
    getOnboardingDraft(draftId: string) {
      return requestJson<OnboardingDraftResponse>(`/api/onboarding/draft?draft=${encodeURIComponent(draftId)}`, {
        method: 'GET',
      }, options);
    },
    updateOnboardingDraft(draftId: string, body: OnboardingDraftPatch) {
      return requestJson<OnboardingDraftResponse>(`/api/onboarding/draft?draft=${encodeURIComponent(draftId)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }, options);
    },
    getUrlPreview(url: string, draftId: string) {
      return requestJson<UrlPreviewResponse>(
        `/api/pipeline/url-preview?url=${encodeURIComponent(url)}&draft=${encodeURIComponent(draftId)}`,
        { method: 'GET' },
        options,
      );
    },
    getTenantProfiles() {
      return requestJson<TenantProfilesResponse>('/api/tenant/profiles', { method: 'GET' }, options);
    },
    updateTenantProfile(userId: string, body: { fullName?: string | null; role?: 'tenant_admin' | 'tenant_analyst' | 'tenant_viewer' }) {
      return requestJson<{ profile: TenantUserProfile }>(`/api/tenant/profiles/${encodeURIComponent(userId)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }, options);
    },
  };
}
