import { requestJson, requestJsonWithRetry, type ApiClientOptions } from './http';
import type {
  SocialContentStatusHistoryEntry,
  MarketingDashboardAsset,
  MarketingDashboardCalendarEvent,
  MarketingDashboardSocialContentJobContent,
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

export type AriesPostStatus =
  | 'draft'
  | 'in_review'
  | 'approved'
  | 'scheduled'
  | 'live'
  | 'changes_requested'
  | 'rejected';

/**
 * Execution-level state of the underlying marketing job. Mirrors the runtime
 * doc's `state` field so the gate layer can distinguish a genuinely running
 * job from a terminal one that happens to carry a `draft` workflow status.
 * Terminal states: 'completed' | 'failed' | 'failed_stale'.
 */
export type RuntimePostExecutionState = string;

export type RuntimePostListItem = {
  id: string;
  jobId: string;
  name: string;
  objective: string;
  funnelStage: string | null;
  status: AriesPostStatus;
  dashboardStatus: AriesItemStatus;
  /** Raw execution state from the marketing job runtime doc (e.g. 'running',
   * 'failed', 'completed'). Use this to distinguish a live in-flight run from
   * a terminal run that still shows a `draft` workflow status. */
  executionState: RuntimePostExecutionState;
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
  previewPosts: AriesDashboardPost[];
  previewAssets: AriesDashboardAsset[];
  dashboard: AriesDashboardPostContent;
  /** Set when the social content job has been soft-deleted (Recycle Bin entry). */
  deletedAt?: string | null;
  /** User id of whoever soft-deleted the social content job. Paired with deletedAt. */
  deletedBy?: string | null;
  /** Set when the delete landed while the pipeline was still running. The
   * orchestrator will stop starting new stages and (best-effort) the
   * gateway will abort the in-flight run. Until the pipeline reaches a
   * terminal state, the UI shows "Cancelling..." instead of just "Deleted". */
  softCancelRequestedAt?: string | null;
  /** ISO timestamp of the brand-kit snapshot baked into this social content job.
   * When this predates the tenant's current brand-kit extracted_at, the UI
   * shows an amber "Generated with previous brand update" badge. */
  brandKitExtractedAt?: string | null;
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
  postId: string;
  postName: string;
  reviewType: 'brand' | 'strategy' | 'creative' | 'workflow_approval';
  workflowState: MarketingWorkflowState;
  workflowStage: string | null;
  title: string;
  channel: string;
  placement: string;
  scheduledFor: string;
  status: AriesPostStatus;
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
  /** Optional poster/thumbnail URL for video review items. Null for images. */
  posterUrl?: string | null;
  destinationUrl?: string | null;
  sections: MarketingReviewSection[];
  attachments: MarketingReviewAttachment[];
  history: SocialContentStatusHistoryEntry[];
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
  timezone: string;
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
  positioning: string | null;
  audience: string | null;
  toneOfVoice: string | null;
  styleVibe: string | null;
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

export type SocialContentListResponse = {
  posts: RuntimePostListItem[];
  /** True when the tenant has additional social content jobs beyond the returned page.
   * The current page is capped at 20 most-recent social content jobs. */
  hasMore?: boolean;
  /** Soft-deleted social content jobs in the same shape as `posts`. Feeds the
   * Recycle Bin / "Deleted social content jobs" section of the social content list screen
   * so users can see what they deleted and restore if needed. */
  deletedPosts: RuntimePostListItem[];
  /** extracted_at of the tenant's current brand-kit.json. Used by the social content
   * list to compare per-post brandKitExtractedAt and render a staleness
   * badge when a social content job predates the latest brand-kit update. */
  currentBrandKitExtractedAt?: string | null;
};
export type ReviewQueueResponse = { reviews: RuntimeReviewItem[]; archivedReviews?: RuntimeReviewItem[] };
export type ReviewItemResponse = { review: RuntimeReviewItem };
export type ReviewDecisionRequest = {
  action: 'approve' | 'changes_requested' | 'reject';
  actedBy: string;
  note?: string;
  approvalId?: string;
};
export type ReviewItemCopyEditRequest = {
  headline?: string | null;
  supportingText?: string | null;
  editedBy?: string | null;
};
export type ReviewItemCopyEditResponse = {
  review: RuntimeReviewItem;
  edit: {
    headline: string | null;
    supportingText: string | null;
    updatedAt: string;
    editedBy: string | null;
    previous: { headline: string | null; supportingText: string | null } | null;
  };
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
  timezone?: string | null;
};
export type TenantProfilesResponse = {
  profiles: TenantUserProfile[];
  viewer?: { userId: string; role: 'tenant_admin' | 'tenant_analyst' | 'tenant_viewer' };
};

// A3 — calendar planner read model.
export type ScheduledPostDispatchDetail = {
  platform: string;
  status: string;
  dispatchedAt: string | null;
  errorAt: string | null;
  errorMessage: string | null;
};
export type ScheduledPostItem = {
  id: string;
  postId: string;
  jobId: string | null;
  tenantId: number;
  title: string;
  caption: string;
  platform: string | null;
  targetPlatforms: string[];
  scheduledFor: string;
  dispatchStatus: string;
  dispatchedAt: string | null;
  errorAt: string | null;
  errorMessage: string | null;
  updatedAt: string;
  dispatches: ScheduledPostDispatchDetail[];
};
export type UnscheduledPostItem = {
  postId: string;
  jobId: string | null;
  title: string;
  caption: string;
  platform: string | null;
  imageUrl: string | null;
};
export type ScheduledPostsResponse = {
  posts: ScheduledPostItem[];
  unscheduled: UnscheduledPostItem[];
  range: { from: string; to: string };
};
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

// ── Insights / analytics (#596, #597) ─────────────────────────────────────────
// Shapes mirror backend/insights/read-api.ts exactly. Facebook-only in the UI
// (Instagram is deferred); the screens pass platform=facebook.
export type InsightsSummaryResponse = {
  period: { days: number; from: string };
  platform: string | null;
  totalViews: number;
  currentFollowers: number;
  followersGained: number;
  totalLikes: number;
  totalComments: number;
  totalShares: number;
  totalWatchTimeMinutes: number;
  totalEngagement: number;
};

export type InsightsAccountMetricPoint = {
  date: string;
  platform: string;
  views: number;
  watchTimeMinutes: number;
  followers: number;
  followersDelta: number;
  likes: number;
  commentsCount: number;
  shares: number;
};
export type InsightsAccountMetricsResponse = {
  period: { days: number; from: string };
  platform: string | null;
  series: InsightsAccountMetricPoint[];
};

export type InsightsPostMetrics = {
  totalViews: number;
  totalLikes: number;
  totalComments: number;
  totalShares: number;
  avgViewPercentage: number | null;
};
export type InsightsPostItem = {
  id: number;
  platform: string;
  externalPostId: string;
  title: string | null;
  mediaType: string;
  publishedAt: string;
  permalink: string | null;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  metrics: InsightsPostMetrics;
};
export type InsightsPostsResponse = {
  posts: InsightsPostItem[];
  limit: number;
  offset: number;
  count: number;
};

export type InsightsCommentItem = {
  id: number;
  postId: number;
  platform: string;
  authorHandle: string | null;
  bodyText: string;
  receivedAt: string;
  isReplied: boolean;
  repliedAt: string | null;
  postTitle: string | null;
  postPermalink: string | null;
};
export type InsightsCommentsResponse = {
  comments: InsightsCommentItem[];
  limit: number;
  count: number;
};

/**
 * Success shape of POST /api/insights/comments/:id/reply. Non-2xx responses
 * (flag-off 404, needs_manual_reconciliation 502, validation 4xx) surface as a
 * thrown ApiRequestError carrying `.status`/`.code`, handled by the caller.
 */
export type InsightsCommentReplyResponse =
  | { status: 'replied'; comment_id: number; platform_reply_id: string; replied_at: string }
  | { status: 'already_replied'; comment_id: number };

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
  status: AriesPostStatus | AriesItemStatus;
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
export type AriesPost = RuntimePostListItem & {
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
      status: AriesPostStatus;
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
export type AriesDashboardPostContent = MarketingDashboardSocialContentJobContent;
export type PostsInventoryResponse = MarketingDashboardContent;

export function createAriesV1Api(options: ApiClientOptions = {}) {
  return {
    getSocialContentList() {
      return requestJson<SocialContentListResponse>('/api/social-content/posts', { method: 'GET', timeoutMs: 30000 }, options);
    },
    getReviews() {
      return requestJson<ReviewQueueResponse>('/api/marketing/reviews', { method: 'GET', timeoutMs: 30000 }, options);
    },
    getInsightsSummary(params: { platform?: string; days?: number } = {}) {
      return requestJson<InsightsSummaryResponse>(
        '/api/insights/summary',
        { method: 'GET', query: { platform: params.platform, days: params.days }, timeoutMs: 30000 },
        options,
      );
    },
    getInsightsAccountMetrics(params: { platform?: string; days?: number } = {}) {
      return requestJson<InsightsAccountMetricsResponse>(
        '/api/insights/account-metrics',
        { method: 'GET', query: { platform: params.platform, days: params.days }, timeoutMs: 30000 },
        options,
      );
    },
    getInsightsPosts(params: { platform?: string; limit?: number; offset?: number } = {}) {
      return requestJson<InsightsPostsResponse>(
        '/api/insights/posts',
        {
          method: 'GET',
          query: { platform: params.platform, limit: params.limit, offset: params.offset },
          timeoutMs: 30000,
        },
        options,
      );
    },
    getInsightsComments(params: { platform?: string; postId?: number; limit?: number } = {}) {
      return requestJson<InsightsCommentsResponse>(
        '/api/insights/comments',
        {
          method: 'GET',
          query: { platform: params.platform, postId: params.postId, limit: params.limit },
          timeoutMs: 30000,
        },
        options,
      );
    },
    replyToInsightComment(commentId: number, replyText: string) {
      return requestJson<InsightsCommentReplyResponse>(
        `/api/insights/comments/${encodeURIComponent(String(commentId))}/reply`,
        { method: 'POST', body: JSON.stringify({ reply_text: replyText }) },
        options,
      );
    },
    getPosts() {
      return requestJson<PostsInventoryResponse>('/api/marketing/posts', { method: 'GET', timeoutMs: 30000 }, options);
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
    updateReviewItemCopy(jobId: string, postId: string, body: ReviewItemCopyEditRequest) {
      return requestJson<ReviewItemCopyEditResponse>(
        `/api/social-content/jobs/${encodeURIComponent(jobId)}/posts/${encodeURIComponent(postId)}`,
        {
          method: 'PATCH',
          body: JSON.stringify(body),
        },
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
    getScheduledPosts(range: { from: string; to: string }) {
      const query = `from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;
      return requestJson<ScheduledPostsResponse>(
        `/api/social-content/scheduled-posts?${query}`,
        { method: 'GET' },
        options,
      );
    },
    updateTenantProfile(userId: string, body: { fullName?: string | null; role?: 'tenant_admin' | 'tenant_analyst' | 'tenant_viewer' }) {
      return requestJson<{ profile: TenantUserProfile }>(`/api/tenant/profiles/${encodeURIComponent(userId)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }, options);
    },
    inviteTenantMember(body: { email: string; fullName?: string | null; role?: 'tenant_admin' | 'tenant_analyst' | 'tenant_viewer' }) {
      return requestJson<{ profile: TenantUserProfile; invited: boolean }>('/api/tenant/profiles', {
        method: 'POST',
        body: JSON.stringify(body),
      }, options);
    },
    resendTenantInvite(userId: string) {
      return requestJson<{ status: string }>(`/api/tenant/profiles/${encodeURIComponent(userId)}/resend-invite`, {
        method: 'POST',
      }, options);
    },
    deleteTenantProfile(userId: string) {
      return requestJson<{ status: string }>(`/api/tenant/profiles/${encodeURIComponent(userId)}`, {
        method: 'DELETE',
      }, options);
    },
  };
}
