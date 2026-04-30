import type {
  GetMarketingJobStatusResponse,
  MarketingCreativeAssetReviewPayload,
  MarketingDashboardAsset,
  MarketingStageCard,
} from '@/lib/api/marketing';

export type WorkspaceView = 'brand' | 'strategy' | 'creative' | 'publish';

export interface WorkspaceAction {
  label: string;
  href: string;
}

export interface WorkspaceHeaderState {
  title: string;
  sourceDomain: string | null;
  sourceUrl: string | null;
}

export interface GateFallbackState {
  title: string;
  description: string;
  detail: string | null;
  action: WorkspaceAction | null;
}

export interface PublishSurfaceState {
  title: string;
  description: string;
  action: WorkspaceAction | null;
  emptyTitle: string;
  emptyDescription: string;
}

export interface GenerationProgressState {
  title: string;
  currentLabel: string;
  description: string;
  completedCount: number;
  activeCount: number;
  totalCount: number;
  percentComplete: number;
  activePercent: number;
  imageCount: number | null;
  videoCount: number | null;
  completedImageCount: number;
  completedVideoCount: number;
  isComplete: boolean;
}

type ReviewStatusPayload = { status: string };

const VIEW_ORDER: Record<WorkspaceView, number> = {
  brand: 0,
  strategy: 1,
  creative: 2,
  publish: 3,
};

const VIEW_LABELS: Record<WorkspaceView, string> = {
  brand: 'Brand Review',
  strategy: 'Strategy Review',
  creative: 'Creative Review',
  publish: 'Launch Status',
};

const DEFAULT_WAITING_COPY: Record<WorkspaceView, { title: string; description: string }> = {
  brand: {
    title: 'Brand review will open here',
    description: 'The current-source brand package will appear here as soon as the website review and brand identity are ready.',
  },
  strategy: {
    title: 'Strategy review will open here',
    description: 'The campaign strategy package will appear here as soon as the current plan is ready for approval.',
  },
  creative: {
    title: 'Creative review will open here',
    description: 'Reviewable assets will appear here when production outputs are available.',
  },
  publish: {
    title: 'Launch status will open here',
    description: 'Launch-ready items will appear here after upstream approvals and final preparation finish.',
  },
};

function normalizeUrl(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) {
    return null;
  }

  try {
    return new URL(trimmed).toString();
  } catch {
    return trimmed;
  }
}

function normalizedDomain(value: string | null | undefined): string | null {
  const normalized = normalizeUrl(value);
  if (!normalized) {
    return null;
  }

  try {
    return new URL(normalized).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return normalized.replace(/^https?:\/\//i, '').replace(/\/+$/, '') || null;
  }
}

function currentStageHref(campaignId: string, view: WorkspaceView): string {
  return `/dashboard/campaigns/${encodeURIComponent(campaignId)}?view=${view}`;
}

function stageForView(view: WorkspaceView): MarketingStageCard['stage'] {
  if (view === 'brand') return 'strategy';
  if (view === 'strategy') return 'production';
  return 'publish';
}

function stageCardForView(
  stageCards: MarketingStageCard[] | null | undefined,
  view: WorkspaceView,
): MarketingStageCard | null {
  return stageCards?.find((card) => card.stage === stageForView(view)) || null;
}

function blockerViewFromWorkflowState(
  workflowState: GetMarketingJobStatusResponse['workflowState'],
): WorkspaceView | null {
  if (workflowState === 'brand_review_required') return 'brand';
  if (workflowState === 'strategy_review_required') return 'strategy';
  if (workflowState === 'creative_review_required') return 'creative';
  return null;
}

function nextStepDetail(nextStep: string): string | null {
  if (nextStep === 'submit_approval') {
    return 'The next step is waiting on an approval checkpoint.';
  }
  if (nextStep === 'wait_for_completion') {
    return 'Aries is still preparing the next package.';
  }
  return null;
}

function sameOrDownstream(activeView: WorkspaceView, blockerView: WorkspaceView): boolean {
  return VIEW_ORDER[activeView] >= VIEW_ORDER[blockerView];
}

function positiveCount(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function clampCount(value: number, total: number): number {
  return Math.min(Math.max(Math.floor(value), 0), total);
}

function parseProductionContractCounts(
  stageCards: MarketingStageCard[] | null | undefined,
): { imageCount: number | null; videoCount: number | null } {
  const highlight = stageCards?.find((card) => card.stage === 'production')?.highlight?.trim() || '';
  if (!highlight) {
    return {
      imageCount: null,
      videoCount: null,
    };
  }

  const imageMatch = highlight.match(/static contracts:\s*(\d+)/i);
  const videoMatch = highlight.match(/video contracts:\s*(\d+)/i);

  return {
    imageCount: imageMatch ? Number(imageMatch[1]) : null,
    videoCount: videoMatch ? Number(videoMatch[1]) : null,
  };
}

function videoLike(value: string | null | undefined): boolean {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /video|reel|short|tiktok|story/.test(normalized);
}

function isVideoDashboardAsset(asset: MarketingDashboardAsset): boolean {
  return (asset.contentType || '').toLowerCase().startsWith('video/') || videoLike(`${asset.platform} ${asset.title}`);
}

function dashboardAssetHasPreview(asset: MarketingDashboardAsset): boolean {
  return Boolean(asset.previewUrl?.trim() || asset.thumbnailUrl?.trim());
}

function reviewAssetHasPreview(asset: MarketingCreativeAssetReviewPayload): boolean {
  return Boolean(asset.previewUrl?.trim() || asset.fullPreviewUrl?.trim());
}

function countCompletedCreativeAssets(
  dashboardAssets: MarketingDashboardAsset[] | null | undefined,
  creativeReviewAssets: MarketingCreativeAssetReviewPayload[] | null | undefined,
  _dashboardImageAds: number | null | undefined,
): { imageCount: number; videoCount: number } {
  const reviewAssets = creativeReviewAssets || [];
  const readyReviewAssets = reviewAssets.filter(reviewAssetHasPreview);
  const readyDashboardAssets = (dashboardAssets || []).filter(dashboardAssetHasPreview);
  const reviewVideoCount = readyReviewAssets.filter(
    (asset) => (asset.contentType || '').toLowerCase().startsWith('video/') || videoLike(`${asset.platformLabel} ${asset.title}`),
  ).length;
  const reviewImageCount = readyReviewAssets.filter(
    (asset) => (asset.contentType || '').toLowerCase().startsWith('image/'),
  ).length;

  const dashboardVideoCount = readyDashboardAssets.filter((asset) => isVideoDashboardAsset(asset)).length;
  const dashboardImageCount = readyDashboardAssets.filter(
    (asset) => asset.type === 'image_ad' && !isVideoDashboardAsset(asset),
  ).length;

  return {
    imageCount: Math.max(reviewImageCount, dashboardImageCount),
    videoCount: Math.max(reviewVideoCount, dashboardVideoCount),
  };
}

function generationCopy(
  imageCount: number | null,
  videoCount: number | null,
  completedCount: number,
  totalCount: number,
): { title: string; currentLabel: string; description: string } {
  const hasImages = !!imageCount;
  const hasVideos = !!videoCount;
  const unitSingular = hasVideos && !hasImages ? 'video' : hasImages && !hasVideos ? 'image' : hasImages || hasVideos ? 'asset' : 'item';
  const unitPlural = unitSingular === 'item' ? 'items' : `${unitSingular}s`;
  const verb = unitSingular === 'video' ? 'Rendering' : 'Generating';
  const pendingCount = Math.max(totalCount - completedCount, 0);
  const activeCount = completedCount < totalCount ? completedCount + 1 : totalCount;
  const breakdown: string[] = [];

  if (hasImages) {
    breakdown.push(`${imageCount} static image${imageCount === 1 ? '' : 's'}`);
  }
  if (hasVideos) {
    breakdown.push(`${videoCount} video render${videoCount === 1 ? '' : 's'}`);
  }

  if (completedCount >= totalCount) {
    return {
      title: 'Creative generation is complete',
      currentLabel: `${totalCount} ${unitPlural} ready`,
      description:
        breakdown.length > 0
          ? `All planned creative outputs are ready. ${breakdown.join(' · ')}.`
          : 'All planned creative outputs are ready.',
    };
  }

  return {
    title: 'Creative generation is running',
    currentLabel: `${verb} ${unitSingular} ${activeCount} of ${totalCount}`,
    description:
      breakdown.length > 0
        ? `${completedCount} complete and ${pendingCount} remaining. ${breakdown.join(' · ')}.`
        : `${completedCount} complete and ${pendingCount} remaining.`,
  };
}

export function resolveWorkspaceView(
  value: string | null | undefined,
  fallback: WorkspaceView = 'brand',
): WorkspaceView {
  if (value === 'brand' || value === 'strategy' || value === 'creative' || value === 'publish') {
    return value;
  }
  return fallback;
}

export function approvalStepToView(workflowStepId: string | null | undefined): WorkspaceView | null {
  if (workflowStepId === 'approve_stage_2') return 'brand';
  if (workflowStepId === 'approve_stage_3') return 'strategy';
  if (workflowStepId === 'approve_stage_4') return 'creative';
  if (workflowStepId === 'approve_stage_4_publish') return 'publish';
  return null;
}

export function deriveGenerationProgressState(
  status: Pick<
    GetMarketingJobStatusResponse,
    'approval' | 'workflowState' | 'plannedPostCount' | 'createdPostCount' | 'stageCards' | 'publishConfig' | 'dashboard' | 'creativeReview'
  >,
): GenerationProgressState | null {
  const approvalView = approvalStepToView(status.approval?.workflowStepId);
  const explicitCounts = parseProductionContractCounts(status.stageCards);
  const plannedImageCount = explicitCounts.imageCount;
  const plannedVideoCount = explicitCounts.videoCount ?? positiveCount(status.publishConfig.videoRenderPlatforms.length);
  const explicitTotal =
    plannedImageCount !== null || plannedVideoCount !== null ? (plannedImageCount || 0) + (plannedVideoCount || 0) : null;
  const productionActive =
    approvalView === 'creative' ||
    approvalView === 'publish' ||
    status.workflowState === 'creative_review_required' ||
    status.workflowState === 'ready_to_publish' ||
    status.workflowState === 'published' ||
    explicitTotal !== null;
  const completedCreativeCounts = countCompletedCreativeAssets(
    status.dashboard.assets,
    status.creativeReview?.assets,
    status.dashboard.campaign?.counts.imageAds,
  );
  const fallbackTotal = positiveCount(status.plannedPostCount);
  const totalCount = explicitTotal && explicitTotal > 0 ? explicitTotal : fallbackTotal;

  if (!productionActive || !totalCount) {
    return null;
  }

  const explicitCompletedCount = completedCreativeCounts.imageCount + completedCreativeCounts.videoCount;
  const fallbackCompletedCount = positiveCount(status.createdPostCount);
  const completedCount = clampCount(
    explicitTotal && explicitTotal > 0
      ? explicitCompletedCount
      : fallbackCompletedCount || explicitCompletedCount,
    totalCount,
  );
  const activeCount = completedCount < totalCount ? completedCount + 1 : totalCount;
  const copy = generationCopy(plannedImageCount, plannedVideoCount, completedCount, totalCount);

  return {
    title: copy.title,
    currentLabel: copy.currentLabel,
    description: copy.description,
    completedCount,
    activeCount,
    totalCount,
    percentComplete: completedCount / totalCount,
    activePercent: activeCount / totalCount,
    imageCount: plannedImageCount,
    videoCount: plannedVideoCount,
    completedImageCount: completedCreativeCounts.imageCount,
    completedVideoCount: completedCreativeCounts.videoCount,
    isComplete: completedCount >= totalCount,
  };
}

// Matches the historic stage-slug campaign name generated by lobster/bin/campaign-planner
// (e.g. "7-stage2-plan", "linear-app-stage2-plan"). The planner has been fixed to
// emit real names, but pre-fix campaigns may still have this shape in their
// review bundle. Rejecting it here keeps the header readable until they age out.
const SYNTHETIC_STAGE_SLUG_RE = /-stage\d+-plan$/i;

function safeReviewCampaignName(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) {
    return null;
  }
  if (SYNTHETIC_STAGE_SLUG_RE.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export function deriveWorkspaceHeaderState(
  status: Pick<GetMarketingJobStatusResponse, 'reviewBundle' | 'brandWebsiteUrl' | 'campaignBrief' | 'dashboard' | 'jobId' | 'tenantName'>,
): WorkspaceHeaderState {
  const sourceUrl = normalizeUrl(status.brandWebsiteUrl) || normalizeUrl(status.campaignBrief?.websiteUrl);
  const sourceDomain = normalizedDomain(sourceUrl);

  return {
    title:
      safeReviewCampaignName(status.reviewBundle?.campaignName) ||
      sourceDomain ||
      status.tenantName ||
      status.dashboard.campaign?.name ||
      `Campaign ${status.jobId}`,
    sourceDomain,
    sourceUrl,
  };
}

export function deriveGateFallbackState(
  status: Pick<
    GetMarketingJobStatusResponse,
    'approval' | 'workflowState' | 'stageCards' | 'nextStep' | 'brandReview' | 'strategyReview' | 'creativeReview'
  >,
  activeView: WorkspaceView,
  campaignId: string,
  publishBlockedReason?: string | null,
): GateFallbackState {
  const defaultCopy = DEFAULT_WAITING_COPY[activeView];
  const approvalView = approvedReviewView(status, approvalStepToView(status.approval?.workflowStepId))
    ? null
    : approvalStepToView(status.approval?.workflowStepId);
  const workflowBlockerView = blockerViewFromWorkflowState(status.workflowState);
  const blockerView = approvalView || (approvedReviewView(status, workflowBlockerView) ? null : workflowBlockerView);
  const activeStageCard = stageCardForView(status.stageCards, activeView);
  const stageSummary = activeStageCard?.summary?.trim() || null;
  const stageHighlight = activeStageCard?.highlight?.trim() || null;

  if (status.workflowState === 'revisions_requested') {
    return {
      title: 'Revisions are blocking this gate',
      description: publishBlockedReason || 'Requested changes must be resolved before this gate can continue.',
      detail: stageHighlight || nextStepDetail(status.nextStep),
      action: {
        label: 'Open review queue',
        href: '/review',
      },
    };
  }

  if (
    approvalView === activeView &&
    status.approval?.actionHref &&
    status.approval.actionHref.trim().length > 0
  ) {
    return {
      title: status.approval.title || `${VIEW_LABELS[activeView]} checkpoint`,
      description: status.approval.message || stageSummary || defaultCopy.description,
      detail: stageHighlight || nextStepDetail(status.nextStep),
      action: {
        label: status.approval.actionLabel || `Open ${VIEW_LABELS[activeView]}`,
        href: status.approval.actionHref,
      },
    };
  }

  if (
    blockerView &&
    blockerView !== activeView &&
    sameOrDownstream(activeView, blockerView)
  ) {
    return {
      title: `${VIEW_LABELS[blockerView]} is blocking this gate`,
      description: `${VIEW_LABELS[blockerView]} must be approved before ${VIEW_LABELS[activeView].toLowerCase()} can continue.`,
      detail: stageSummary || stageHighlight || nextStepDetail(status.nextStep),
      action: {
        label: `Open ${VIEW_LABELS[blockerView]}`,
        href: currentStageHref(campaignId, blockerView),
      },
    };
  }

  return {
    title: defaultCopy.title,
    description: stageSummary || defaultCopy.description,
    detail: stageHighlight || nextStepDetail(status.nextStep),
    action: null,
  };
}

function reviewForView(
  status: Pick<GetMarketingJobStatusResponse, 'brandReview' | 'strategyReview' | 'creativeReview'>,
  view: WorkspaceView | null,
): ReviewStatusPayload | null {
  if (view === 'brand') {
    return status.brandReview;
  }
  if (view === 'strategy') {
    return status.strategyReview;
  }
  if (view === 'creative') {
    return status.creativeReview;
  }
  return null;
}

function approvedReviewView(
  status: Pick<GetMarketingJobStatusResponse, 'brandReview' | 'strategyReview' | 'creativeReview'>,
  view: WorkspaceView | null,
): boolean {
  return reviewForView(status, view)?.status === 'approved';
}

export function derivePublishSurfaceState(
  status: Pick<GetMarketingJobStatusResponse, 'approval' | 'workflowState' | 'stageCards' | 'nextStep' | 'dashboard'>,
  campaignId: string,
  publishBlockedReason?: string | null,
): PublishSurfaceState {
  const publishItems = status.dashboard.publishItems || [];
  const approvalView = approvalStepToView(status.approval?.workflowStepId);
  const blockerView = approvalView || blockerViewFromWorkflowState(status.workflowState);
  const publishStageCard = stageCardForView(status.stageCards, 'publish');
  const stageSummary =
    publishStageCard?.summary?.trim() ||
    'Launch items will appear here after upstream approvals and final preparation finish.';

  if (status.workflowState === 'revisions_requested') {
    return {
      title: 'Launch is blocked by requested changes',
      description: publishBlockedReason || 'Requested changes must be resolved before publishing can continue.',
      action: {
        label: 'Open review queue',
        href: '/review',
      },
      emptyTitle: 'Launch items are waiting on revisions',
      emptyDescription: 'Launch packages will appear here after the requested changes are resolved.',
    };
  }

  if (publishBlockedReason) {
    return {
      title: 'Launch is blocked',
      description: publishBlockedReason,
      action:
        blockerView && blockerView !== 'publish'
          ? {
              label: `Open ${VIEW_LABELS[blockerView]}`,
              href: currentStageHref(campaignId, blockerView),
            }
          : null,
      emptyTitle: 'Launch items are waiting on approvals',
      emptyDescription: 'Launch packages will appear here after the blocking review is approved and final preparation finishes.',
    };
  }

  if (
    approvalView === 'publish' &&
    status.approval?.actionHref &&
    status.approval.actionHref.trim().length > 0
  ) {
    return {
      title: status.approval.title || 'Publish approval is ready',
      description: status.approval.message || stageSummary,
      action: {
        label: status.approval.actionLabel || 'Open publish approval',
        href: status.approval.actionHref,
      },
      emptyTitle: 'Publish queue opens after approval',
      emptyDescription: 'Launch items will populate here after the publish checkpoint is approved.',
    };
  }

  if (
    blockerView &&
    blockerView !== 'publish' &&
    sameOrDownstream('publish', blockerView)
  ) {
    return {
      title: `${VIEW_LABELS[blockerView]} is still blocking launch`,
      description: `${VIEW_LABELS[blockerView]} must be approved before launch-ready items can move forward.`,
      action: {
        label: `Open ${VIEW_LABELS[blockerView]}`,
        href: currentStageHref(campaignId, blockerView),
      },
      emptyTitle: 'Launch queue is still locked',
      emptyDescription: 'Launch packages will appear here after the blocking review is approved.',
    };
  }

  if (
    publishItems.length > 0 &&
    (status.workflowState === 'ready_to_publish' || status.workflowState === 'published')
  ) {
    return {
      title: status.workflowState === 'published' ? 'Launch is live' : 'Launch-ready items are available',
      description:
        status.workflowState === 'published'
          ? 'Published items are available below with their current launch status.'
          : 'All required approvals are complete. Publish-ready items can now move forward.',
      action: null,
      emptyTitle: 'No launch items yet',
      emptyDescription: 'Launch packages will appear here as soon as final preparation finishes.',
    };
  }

  return {
    title: 'Launch preparation is still running',
    description: stageSummary,
    action: null,
    emptyTitle: 'No launch items yet',
    emptyDescription:
      nextStepDetail(status.nextStep) || 'Launch packages will appear here as soon as upstream approvals and final preparation are complete.',
  };
}
