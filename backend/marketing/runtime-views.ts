import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type {
  MarketingCampaignStatusHistoryEntry,
  MarketingReviewAttachment,
  MarketingReviewSection,
  MarketingStage,
  MarketingWorkflowState,
} from '@/lib/api/marketing';
import { resolveDataPath } from '@/lib/runtime-paths';

import { buildMarketingAssetLinks } from './asset-library';
import { normalizeBrandKitSignals } from './brand-kit';
import { approveMarketingJob } from './jobs-approve';
import { denyMarketingJob } from './orchestrator';
import { loadMarketingJobRuntime, listMarketingJobIdsForTenant, listMarketingTenantIds, type MarketingJobRuntimeDocument } from './runtime-state';
import {
  dashboardDateRangeText,
  type MarketingDashboardAsset,
  type MarketingDashboardCampaign,
  type MarketingDashboardCampaignContent,
  type MarketingDashboardCalendarEvent,
  type MarketingDashboardContent,
  type MarketingDashboardItemStatus,
  type MarketingDashboardPost,
  type MarketingDashboardPublishItem,
  type MarketingDashboardStatusSummary,
} from './dashboard-content';
import { getMarketingJobStatus, type MarketingJobStatusResponse } from './jobs-status';
import {
  buildCampaignWorkspaceView,
  getWorkflowAwareDashboardContentForTenant,
  type CampaignWorkspaceView,
} from './workspace-views';
import {
  ensureCampaignWorkspaceRecord,
  saveCampaignWorkspaceRecord,
  setCreativeAssetDecision,
  setStageReviewDecision,
} from './workspace-store';

export type RuntimeCampaignStatus =
  | 'draft'
  | 'in_review'
  | 'approved'
  | 'scheduled'
  | 'live'
  | 'changes_requested'
  | 'rejected';

export type RuntimeCampaignDashboard = {
  posts: MarketingDashboardPost[];
  assets: MarketingDashboardAsset[];
  publishItems: MarketingDashboardPublishItem[];
  calendarEvents: MarketingDashboardCalendarEvent[];
  statuses: MarketingDashboardStatusSummary;
};

export type RuntimeCampaignListItem = {
  id: string;
  jobId: string;
  name: string;
  objective: string;
  funnelStage: string | null;
  status: RuntimeCampaignStatus;
  dashboardStatus: MarketingDashboardItemStatus;
  stageLabel: string;
  summary: string;
  dateRange: string;
  pendingApprovals: number;
  nextScheduled: string;
  trustNote: string;
  updatedAt: string | null;
  approvalRequired: boolean;
  approvalActionHref?: string;
  counts: MarketingDashboardCampaign['counts'];
  previewPosts: MarketingDashboardPost[];
  previewAssets: MarketingDashboardAsset[];
  dashboard: RuntimeCampaignDashboard;
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
  status: RuntimeCampaignStatus;
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

export type RuntimeReviewQueue = {
  reviews: RuntimeReviewItem[];
  archivedReviews: RuntimeReviewItem[];
};

export type RuntimeReviewStateFile = {
  schema_name: 'marketing_review_state';
  schema_version: '1.0.0';
  job_id: string;
  tenant_id: string;
  items: Record<
    string,
    {
      sourceHash: string;
      status: RuntimeCampaignStatus;
      lastDecision: RuntimeReviewDecision | null;
    }
  >;
  updated_at: string;
};

export class RuntimeReviewDecisionError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'RuntimeReviewDecisionError';
    this.code = code;
    this.status = status;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function reviewStatePath(jobId: string): string {
  return resolveDataPath('generated', 'draft', 'marketing-reviews', `${jobId}.json`);
}

function emptyReviewState(jobId: string, tenantId: string): RuntimeReviewStateFile {
  return {
    schema_name: 'marketing_review_state',
    schema_version: '1.0.0',
    job_id: jobId,
    tenant_id: tenantId,
    items: {},
    updated_at: nowIso(),
  };
}

function loadReviewState(jobId: string, tenantId: string): RuntimeReviewStateFile {
  const filePath = reviewStatePath(jobId);
  if (!existsSync(filePath)) {
    return emptyReviewState(jobId, tenantId);
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as RuntimeReviewStateFile;
    if (parsed && parsed.job_id === jobId && parsed.tenant_id === tenantId && parsed.items) {
      return parsed;
    }
  } catch {}
  return emptyReviewState(jobId, tenantId);
}

function saveReviewState(state: RuntimeReviewStateFile): string {
  const filePath = reviewStatePath(state.job_id);
  mkdirSync(path.dirname(filePath), { recursive: true });
  state.updated_at = nowIso();
  writeFileSync(filePath, JSON.stringify(state, null, 2));
  return filePath;
}

function stableHash(value: unknown): string {
  return crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex');
}

function reviewIdParts(reviewId: string): { jobId: string; itemId: string } {
  const separator = reviewId.indexOf('::');
  if (separator === -1) {
    return { jobId: reviewId, itemId: '' };
  }
  return {
    jobId: reviewId.slice(0, separator),
    itemId: reviewId.slice(separator + 2),
  };
}

function stringValue(value: unknown, fallback = ''): string {
  if (typeof value === 'string' && value.trim().length > 0) {
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

function labeledBlock(entries: Array<[string, string | null | undefined]>): string {
  return entries
    .filter(([, value]) => typeof value === 'string' && value.trim().length > 0)
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n');
}

function formatList(items: Array<string | null | undefined>, empty = 'None provided.'): string {
  const values = items
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim());
  if (values.length === 0) {
    return empty;
  }
  return values.map((item) => `- ${item}`).join('\n');
}

function isApproveStage2Checkpoint(status: MarketingJobStatusResponse): boolean {
  return status.approval?.workflowStepId === 'approve_stage_2';
}

function approvalSurfaceSummary(status: MarketingJobStatusResponse): string {
  const message = stringValue(status.approval?.message, status.summary.subheadline);
  switch (status.approval?.workflowStepId) {
    case 'approve_stage_2':
      return 'Research is complete. Brand analysis is ready next once this direction is approved.';
    case 'approve_stage_3':
      return message || 'The campaign strategy is ready for approval before production begins.';
    case 'approve_stage_4':
      return message || 'Creative production is ready for approval before launch packaging begins.';
    case 'approve_stage_4_publish':
      return message || 'Launch packaging is ready for approval before publishing begins.';
    default:
      return message || 'The next campaign checkpoint is ready for review.';
  }
}

function approvalSurfaceTitle(status: MarketingJobStatusResponse): string {
  switch (status.approval?.workflowStepId) {
    case 'approve_stage_2':
      return 'Research complete';
    case 'approve_stage_3':
      return 'Campaign strategy';
    case 'approve_stage_4':
      return 'Creative review';
    case 'approve_stage_4_publish':
      return 'Publishing approval';
    default:
      return stringValue(status.approval?.title, 'Campaign approval');
  }
}

function firstCheckpointBrandKitVisuals(
  status: MarketingJobStatusResponse,
  runtimeDoc: MarketingJobRuntimeDocument,
): NonNullable<MarketingReviewSection['brandKitVisuals']> {
  const normalized = normalizeBrandKitSignals(runtimeDoc.brand_kit);
  const colorEntries = [
    normalized.colors.primary ? { label: 'Primary', hex: normalized.colors.primary } : null,
    normalized.colors.secondary ? { label: 'Secondary', hex: normalized.colors.secondary } : null,
    normalized.colors.accent ? { label: 'Accent', hex: normalized.colors.accent } : null,
  ].filter((entry): entry is { label: string; hex: string } => !!entry);

  return {
    logos: normalized.logo_urls.slice(0, 1),
    colors: colorEntries,
    fonts: normalized.font_families.slice(0, 3).map((family) => ({
      label: family,
      family,
      sampleText: status.tenantName || runtimeDoc.brand_kit?.brand_name || 'Brand sample',
    })),
  };
}

function runtimeStatusFromWorkflowState(
  workflowState: MarketingWorkflowState,
  dashboardStatus?: MarketingDashboardItemStatus | null,
): RuntimeCampaignStatus {
  if (workflowState === 'published') {
    if (dashboardStatus === 'live') {
      return 'live';
    }
    if (dashboardStatus === 'scheduled') {
      return 'scheduled';
    }
    return 'approved';
  }
  if (workflowState === 'ready_to_publish' || workflowState === 'approved') {
    return 'approved';
  }
  if (workflowState === 'revisions_requested') {
    return 'changes_requested';
  }
  if (workflowState === 'brand_review_required' || workflowState === 'strategy_review_required' || workflowState === 'creative_review_required') {
    return 'in_review';
  }
  return 'draft';
}

function runtimeStatusFromReviewState(status: 'not_ready' | 'pending_review' | 'approved' | 'changes_requested' | 'rejected'): RuntimeCampaignStatus {
  switch (status) {
    case 'approved':
      return 'approved';
    case 'changes_requested':
      return 'changes_requested';
    case 'rejected':
      return 'rejected';
    default:
      return 'in_review';
  }
}

function formatUtcTimestampLabel(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return value;
  }

  return `${new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(new Date(timestamp))} UTC`;
}

function nextScheduledText(status: MarketingJobStatusResponse): string {
  const next = status.calendarEvents
    .slice()
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0];
  if (!next) {
    return status.approvalRequired ? 'Waiting on approval before scheduling' : 'Nothing scheduled yet';
  }
  return `${formatUtcTimestampLabel(next.startsAt)}${next.platform ? ` · ${next.platform}` : ''}`;
}

function nextScheduledTextFromDashboard(events: MarketingDashboardCalendarEvent[]): string {
  const next = events
    .slice()
    .sort((left, right) => left.startsAt.localeCompare(right.startsAt))[0];
  if (!next) {
    return 'Nothing scheduled yet';
  }
  return `${formatUtcTimestampLabel(next.startsAt)} · ${next.statusLabel}${next.platformLabel ? ` · ${next.platformLabel}` : ''}`;
}

function campaignName(status: MarketingJobStatusResponse, view: CampaignWorkspaceView): string {
  return view.dashboard.campaign?.name || status.reviewBundle?.campaignName || status.tenantName || `Campaign ${status.jobId}`;
}

function campaignObjective(status: MarketingJobStatusResponse, view: CampaignWorkspaceView): string {
  return view.dashboard.campaign?.objective || status.summary.headline || 'Campaign in progress';
}

function buildCampaignListItem(
  status: MarketingJobStatusResponse,
  view: CampaignWorkspaceView,
  pendingApprovals: number,
): RuntimeCampaignListItem {
  const dashboardCampaign = view.dashboard.campaign;
  return {
    id: status.jobId,
    jobId: status.jobId,
    name: campaignName(status, view),
    objective: campaignObjective(status, view),
    funnelStage: dashboardCampaign?.funnelStage || null,
    status: runtimeStatusFromWorkflowState(view.workflowState, dashboardCampaign?.status || null),
    dashboardStatus: dashboardCampaign?.status || 'draft',
    stageLabel: dashboardCampaign?.stageLabel || status.currentStage || 'campaign',
    summary: dashboardCampaign?.summary || status.summary.subheadline || 'Campaign status is available for review.',
    dateRange: dashboardCampaign ? dashboardDateRangeText(dashboardCampaign.campaignWindow) : 'Dates not scheduled yet',
    pendingApprovals,
    nextScheduled:
      view.dashboard.calendarEvents.length > 0 ? nextScheduledTextFromDashboard(view.dashboard.calendarEvents) : nextScheduledText(status),
    trustNote: 'Nothing can reach publish until every required review is approved.',
    updatedAt: dashboardCampaign?.updatedAt || status.updatedAt,
    approvalRequired: dashboardCampaign?.approvalRequired ?? status.approvalRequired,
    approvalActionHref:
      view.workflowState === 'revisions_requested'
        ? undefined
        : dashboardCampaign?.approvalActionHref || status.approval?.actionHref,
    counts: dashboardCampaign?.counts || {
      posts: view.dashboard.posts.length,
      landingPages: view.dashboard.assets.filter((asset) => asset.type === 'landing_page').length,
      imageAds: view.dashboard.assets.filter((asset) => asset.type === 'image_ad').length,
      scripts: view.dashboard.assets.filter((asset) => asset.type === 'script' || asset.type === 'copy').length,
      publishItems: view.dashboard.publishItems.length,
      proposalConcepts: view.dashboard.posts.filter((post) => post.provenance.sourceKind === 'proposal').length,
      ready: view.dashboard.statuses.countsByStatus.ready,
      readyToPublish: view.dashboard.statuses.countsByStatus.ready_to_publish,
      pausedMetaAds: view.dashboard.statuses.countsByStatus.published_to_meta_paused,
      scheduled: view.dashboard.statuses.countsByStatus.scheduled,
      live: view.dashboard.statuses.countsByStatus.live,
    },
    previewPosts: view.dashboard.posts.slice(0, 3),
    previewAssets: view.dashboard.assets.slice(0, 3),
    dashboard: {
      posts: view.dashboard.posts,
      assets: view.dashboard.assets,
      publishItems: view.dashboard.publishItems,
      calendarEvents: view.dashboard.calendarEvents,
      statuses: view.dashboard.statuses,
    },
  };
}

function reviewItemSourceHash(item: RuntimeReviewItem): string {
  return stableHash({
    reviewType: item.reviewType,
    title: item.title,
    summary: item.summary,
    scheduledFor: item.scheduledFor,
    sections: item.sections,
    attachments: item.attachments,
    previewUrl: item.previewUrl,
    fullPreviewUrl: item.fullPreviewUrl,
    destinationUrl: item.destinationUrl,
    currentVersion: item.currentVersion,
  });
}

function reviewItemUpdatedAt(item: RuntimeReviewItem): number {
  const timestamps = [
    item.lastDecision?.at || '',
    ...item.history.map((entry) => entry.at),
  ]
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value));

  if (timestamps.length === 0) {
    return 0;
  }

  return Math.max(...timestamps);
}

function compareReviewItems(left: RuntimeReviewItem, right: RuntimeReviewItem): number {
  const timeDelta = reviewItemUpdatedAt(right) - reviewItemUpdatedAt(left);
  if (timeDelta !== 0) {
    return timeDelta;
  }
  return left.title.localeCompare(right.title);
}

function reviewQueueKey(item: RuntimeReviewItem): string {
  if (item.reviewType === 'creative') {
    return `creative:${item.jobId}:${item.assetId || item.currentVersion.id || item.id}`;
  }
  if (item.reviewType === 'workflow_approval') {
    return `workflow:${item.jobId}:${item.workflowStage || item.workflowState}:${item.currentVersion.id || item.id}`;
  }
  return `stage:${item.jobId}:${item.reviewType}:${item.workflowStage || 'review'}`;
}

function buildRuntimeReviewQueue(items: RuntimeReviewItem[]): RuntimeReviewQueue {
  const active: RuntimeReviewItem[] = [];
  const archived: RuntimeReviewItem[] = [];
  const seenKeys = new Set<string>();

  for (const item of items.slice().sort(compareReviewItems)) {
    const key = reviewQueueKey(item);
    if (seenKeys.has(key)) {
      archived.push(item);
      continue;
    }
    seenKeys.add(key);
    active.push(item);
  }

  return {
    reviews: active,
    archivedReviews: archived,
  };
}

function isWorkflowApprovalItem(item: RuntimeReviewItem): boolean {
  return item.reviewType === 'workflow_approval' || item.currentVersion.id === 'approval' || item.currentVersion.id.startsWith('approval:');
}

function lastDecisionFromHistory(history: MarketingCampaignStatusHistoryEntry[]): RuntimeReviewDecision | null {
  const latest = history
    .filter((entry) => !!entry.action)
    .slice()
    .sort((left, right) => right.at.localeCompare(left.at))[0];
  if (!latest?.action) {
    return null;
  }
  return {
    action: latest.action,
    actedBy: latest.actor,
    note: latest.note ?? null,
    at: latest.at,
  };
}

function stageReviewItem(
  view: CampaignWorkspaceView,
  review: NonNullable<CampaignWorkspaceView['brandReview'] | CampaignWorkspaceView['strategyReview']>,
  campaignNameValue: string,
): RuntimeReviewItem {
  return {
    id: review.reviewId,
    jobId: view.jobId,
    campaignId: view.jobId,
    campaignName: campaignNameValue,
    reviewType: review.reviewType,
    workflowState: view.workflowState,
    workflowStage: review.reviewType,
    title: review.title,
    channel: review.reviewType === 'brand' ? 'Brand' : 'Strategy',
    placement: 'Campaign review',
    scheduledFor: 'Awaiting review',
    status: runtimeStatusFromReviewState(review.status),
    summary: review.summary,
    currentVersion: {
      id: `${review.reviewType}:${view.jobId}`,
      label: 'Current version',
      headline: review.title,
      supportingText: review.summary,
      cta: 'Approve',
      notes: review.sections.map((section) => section.title),
    },
    previousVersion: undefined,
    lastDecision: lastDecisionFromHistory(review.history),
    notePlaceholder: review.notePlaceholder,
    sections: review.sections,
    attachments: review.attachments,
    history: review.history,
  };
}

function creativeReviewItem(
  view: CampaignWorkspaceView,
  item: NonNullable<CampaignWorkspaceView['creativeReview']>['assets'][number],
  campaignNameValue: string,
): RuntimeReviewItem {
  return {
    id: item.reviewId,
    jobId: view.jobId,
    campaignId: view.jobId,
    campaignName: campaignNameValue,
    reviewType: 'creative',
    workflowState: view.workflowState,
    workflowStage: 'creative',
    title: item.title,
    channel: item.platformLabel,
    placement: 'Creative asset',
    scheduledFor: 'Awaiting review',
    status: runtimeStatusFromReviewState(item.status),
    summary: item.summary,
    currentVersion: {
      id: item.assetId,
      label: 'Current version',
      headline: item.title,
      supportingText: item.summary,
      cta: 'Approve',
      notes: item.notes,
    },
    previousVersion: undefined,
    lastDecision: lastDecisionFromHistory(item.history),
    notePlaceholder: 'Add per-asset notes, approval context, or requested changes.',
    assetId: item.assetId,
    contentType: item.contentType,
    previewUrl: item.previewUrl,
    fullPreviewUrl: item.fullPreviewUrl,
    destinationUrl: item.destinationUrl,
    sections: [
      {
        id: `${item.assetId}-summary`,
        title: 'Asset summary',
        body: item.notes.join('\n'),
      },
    ],
    attachments: item.fullPreviewUrl
      ? [
          {
            id: `${item.assetId}-preview`,
            label: 'Open full preview',
            url: item.fullPreviewUrl,
            contentType: item.contentType || 'application/octet-stream',
            kind: 'preview',
          },
        ]
      : [],
    history: item.history,
  };
}

function normalizePublishPreviewPlatform(value: string | null | undefined): string {
  const normalized = (value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (['meta', 'facebook', 'facebook-ads', 'meta-ads'].includes(normalized)) {
    return 'meta-ads';
  }
  return normalized || 'preview';
}

function publishPreviewReviewItems(
  status: MarketingJobStatusResponse,
  view: CampaignWorkspaceView,
  campaignNameValue: string,
): RuntimeReviewItem[] {
  const reviewBundle = status.reviewBundle;
  if (!status.approval || status.currentStage !== 'publish' || !reviewBundle || reviewBundle.platformPreviews.length === 0) {
    return [];
  }

  return reviewBundle.platformPreviews.map((preview, index) => {
    const normalizedPlatform = normalizePublishPreviewPlatform(preview.platformSlug || preview.platformName);
    const previewAsset = preview.mediaAssets[0] || preview.assetLinks[0] || reviewBundle.previewAsset;

    return {
      id: `${status.jobId}::publish-preview:${normalizedPlatform}`,
      jobId: status.jobId,
      campaignId: status.jobId,
      campaignName: campaignNameValue,
      reviewType: 'creative',
      workflowState: view.workflowState,
      workflowStage: 'publish',
      title: preview.displayTitle || preview.platformName || `Platform ${index + 1}`,
      channel: preview.platformName || 'Publish preview',
      placement: 'Publish preview',
      scheduledFor: 'Before workflow resume',
      status: 'in_review',
      summary: preview.summary,
      currentVersion: {
        id: preview.id || `platform-preview:${normalizedPlatform}`,
        label: 'Current version',
        headline: preview.displayTitle || preview.platformName || `Platform ${index + 1}`,
        supportingText: preview.summary,
        cta: 'Approve',
        notes: preview.details,
      },
      previousVersion: undefined,
      lastDecision: null,
      notePlaceholder: 'Add launch review notes, requested changes, or approval context.',
      contentType: previewAsset?.contentType || null,
      previewUrl: previewAsset?.url || null,
      fullPreviewUrl: previewAsset?.url || null,
      destinationUrl: undefined,
      sections: [
        {
          id: `${normalizedPlatform}-publish-preview`,
          title: 'Launch preview',
          body: [preview.summary, ...preview.details].filter(Boolean).join('\n'),
        },
      ],
      attachments: [
        ...preview.mediaAssets.map((asset) => ({
          id: asset.id,
          label: asset.label,
          url: asset.url,
          contentType: asset.contentType,
          kind: asset.contentType.startsWith('image/') ? ('preview' as const) : ('artifact' as const),
        })),
        ...preview.assetLinks.map((asset) => ({
          id: asset.id,
          label: asset.label,
          url: asset.url,
          contentType: asset.contentType,
          kind: asset.contentType.startsWith('image/') ? ('preview' as const) : ('artifact' as const),
        })),
      ],
      history: [],
    };
  });
}

function firstCheckpointSections(
  status: MarketingJobStatusResponse,
  view: CampaignWorkspaceView,
  runtimeDoc: MarketingJobRuntimeDocument,
): MarketingReviewSection[] {
  const researchCard = status.stageCards.find((card) => card.stage === 'research');
  const researchArtifacts = status.artifacts.filter((artifact) => artifact.stage === 'research');
  const researchArtifact = researchArtifacts[0];
  const researchPrimaryOutput = recordValue(runtimeDoc.stages.research.primary_output);
  const researchExecutiveSummary = recordValue(researchPrimaryOutput?.executive_summary);
  const brief = view.campaignBrief;
  const brandKit = runtimeDoc.brand_kit;
  const normalizedBrandKit = normalizeBrandKitSignals(brandKit);
  const researchDetailLines = (researchArtifact?.details || []).filter((entry) => typeof entry === 'string' && entry.trim().length > 0);
  const hasResearchCompetitorDetail = researchDetailLines.some((entry) => /^competitor:/i.test(entry));
  const externalLinks = Array.isArray(brandKit?.external_links)
    ? brandKit.external_links
        .map((link) => {
          const entry = recordValue(link);
          const platform = stringValue(entry?.platform);
          const url = stringValue(entry?.url);
          if (!platform && !url) {
            return null;
          }
          return platform ? `${platform}: ${url || 'Link available'}` : url;
        })
        .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
  const researchBody = [
    stringValue(
      researchArtifact?.summary,
      stringValue(
        runtimeDoc.stages.research.summary?.summary,
        stringValue(researchExecutiveSummary?.market_positioning, researchCard?.summary || status.summary.subheadline),
      ),
    ),
    stringValue(
      runtimeDoc.stages.research.summary?.highlight,
      stringValue(researchExecutiveSummary?.campaign_takeaway, researchCard?.highlight || ''),
    )
      ? `Key takeaway: ${stringValue(
          runtimeDoc.stages.research.summary?.highlight,
          stringValue(researchExecutiveSummary?.campaign_takeaway, researchCard?.highlight || ''),
        )}`
      : '',
    ...researchDetailLines,
    !hasResearchCompetitorDetail
      ? stringValue(
          brief?.competitorUrl,
          stringValue(runtimeDoc.inputs.competitor_url),
        )
          ? `Competitor: ${stringValue(
              brief?.competitorUrl,
              stringValue(runtimeDoc.inputs.competitor_url),
            )}`
          : ''
      : '',
  ].filter((entry) => typeof entry === 'string' && entry.trim().length > 0).join('\n');
  const campaignBriefBody = labeledBlock([
    ['Business name', stringValue(brief?.businessName)],
    ['Business type', stringValue(brief?.businessType)],
    ['Goal', stringValue(brief?.goal)],
    ['Offer', stringValue(brief?.offer)],
    ['Channels', formatList(brief?.channels || [], '')],
    ['Brand voice', stringValue(brief?.brandVoice)],
    ['Style / vibe', stringValue(brief?.styleVibe)],
    ['Visual references', formatList(brief?.visualReferences || [], '')],
    ['Must-use copy', stringValue(brief?.mustUseCopy)],
    ['Must-avoid aesthetics', stringValue(brief?.mustAvoidAesthetics)],
    ['Notes', stringValue(brief?.notes)],
  ]);

  const sections: MarketingReviewSection[] = [
    {
      id: 'research-summary',
      title: 'Research summary',
      body: researchBody,
    },
    {
      id: 'extracted-brand-kit',
      title: 'Extracted brand kit',
      body: labeledBlock([
        ['Brand', stringValue(brandKit?.brand_name, status.tenantName || '')],
        ['Source URL', stringValue(brandKit?.source_url, status.brandWebsiteUrl || '')],
        ['Canonical URL', stringValue(brandKit?.canonical_url)],
        ['Logo count', normalizedBrandKit.logo_urls.length > 0 ? String(normalizedBrandKit.logo_urls.length) : 'None detected'],
        ['Palette', normalizedBrandKit.colors.palette.length > 0 ? 'Swatches shown below.' : 'None detected'],
        ['Fonts', normalizedBrandKit.font_families.length > 0 ? 'Preview samples shown below.' : 'None detected'],
        ['External links', formatList(externalLinks, '')],
      ]),
      brandKitVisuals: firstCheckpointBrandKitVisuals(status, runtimeDoc),
    },
  ];

  if (campaignBriefBody.trim().length > 0) {
    sections.splice(1, 0, {
      id: 'campaign-brief',
      title: 'Campaign brief',
      body: campaignBriefBody,
    });
  }

  if ((brief?.brandAssets.length || 0) > 0) {
    sections.push({
      id: 'uploaded-brand-assets',
      title: 'Uploaded brand assets',
      body: formatList(brief?.brandAssets.map((asset) => asset.name) || []),
    });
  }

  return sections.filter((section) => section.body.trim().length > 0);
}

function firstCheckpointAttachments(
  view: CampaignWorkspaceView,
  runtimeDoc: MarketingJobRuntimeDocument,
): MarketingReviewAttachment[] {
  const attachments: MarketingReviewAttachment[] = [];
  const assetLinks = new Map(buildMarketingAssetLinks(runtimeDoc.job_id, runtimeDoc).map((asset) => [asset.id, asset] as const));
  const researchSummary = assetLinks.get('research-summary');
  const brandKit = assetLinks.get('brand-kit-json');

  if (researchSummary) {
    attachments.push({
      id: researchSummary.id,
      label: researchSummary.label,
      url: researchSummary.url,
      contentType: researchSummary.contentType,
      kind: 'document',
    });
  }

  if (brandKit) {
    attachments.push({
      id: brandKit.id,
      label: brandKit.label,
      url: brandKit.url,
      contentType: brandKit.contentType,
      kind: 'document',
    });
  }

  for (const asset of view.campaignBrief?.brandAssets || []) {
    attachments.push({
      id: asset.id,
      label: asset.name,
      url: asset.url,
      contentType: asset.contentType,
      kind: 'brand_asset',
    });
  }

  return attachments;
}

function workflowApprovalItem(
  status: MarketingJobStatusResponse,
  view: CampaignWorkspaceView,
  runtimeDoc: MarketingJobRuntimeDocument,
  campaignNameValue: string,
): RuntimeReviewItem | null {
  if (!status.approval) {
    return null;
  }

  const firstCheckpoint = isApproveStage2Checkpoint(status);
  const sections = firstCheckpoint
    ? firstCheckpointSections(status, view, runtimeDoc)
    : [
        {
          id: 'workflow-approval',
          title: 'What is ready now',
          body: approvalSurfaceSummary(status),
        },
      ];
  const attachments = firstCheckpoint ? firstCheckpointAttachments(view, runtimeDoc) : [];
  const summary = approvalSurfaceSummary(status);
  const title = approvalSurfaceTitle(status);
  const cta = view.workflowState === 'revisions_requested'
    ? 'Resolve revisions'
    : status.approval.actionLabel || 'Approve and continue';

  return {
    id: `${status.jobId}::approval`,
    jobId: status.jobId,
    campaignId: status.jobId,
    campaignName: campaignNameValue,
    reviewType: 'workflow_approval',
    workflowState: view.workflowState,
    workflowStage: status.currentStage || status.approval.workflowStepId || 'approval',
    title,
    channel: firstCheckpoint ? 'Research' : 'Campaign',
    placement: firstCheckpoint ? 'Brand analysis next' : (status.currentStage || 'Current checkpoint'),
    scheduledFor: firstCheckpoint ? 'Before brand analysis begins' : 'Before the next stage begins',
    status: 'in_review',
    summary,
    currentVersion: {
      id: status.approval.approvalId ? `approval:${status.approval.approvalId}` : 'approval',
      label: 'Current version',
      headline: title,
      supportingText: summary,
      cta,
      notes:
        sections.length > 0
          ? sections.map((section) => section.title)
          : [],
    },
    previousVersion: undefined,
    lastDecision: null,
    notePlaceholder: 'Add client-facing context for the next step.',
    sections,
    attachments,
    history: [],
  };
}

function mergeReviewState(jobId: string, tenantId: string, items: RuntimeReviewItem[]): RuntimeReviewItem[] {
  const state = loadReviewState(jobId, tenantId);
  let changed = false;

  for (const item of items) {
    const sourceHash = reviewItemSourceHash(item);
    const exact = state.items[item.id];
    const existing = exact ?? Object.values(state.items).find((entry) => entry.sourceHash === sourceHash);

    if (!existing) {
      state.items[item.id] = {
        sourceHash,
        status: item.status,
        lastDecision: item.lastDecision,
      };
      changed = true;
      continue;
    }

    if (!exact) {
      state.items[item.id] = {
        sourceHash,
        status: existing.status,
        lastDecision: existing.lastDecision,
      };
      changed = true;
    } else if (existing.sourceHash !== sourceHash) {
      state.items[item.id] = {
        sourceHash,
        status: existing.status === 'approved' ? 'in_review' : existing.status,
        lastDecision: existing.lastDecision,
      };
      changed = true;
    }

    if (
      state.items[item.id].lastDecision === null &&
      state.items[item.id].status !== item.status &&
      (state.items[item.id].status === 'in_review' || item.status === 'in_review' || item.status === 'approved')
    ) {
      state.items[item.id] = {
        ...state.items[item.id],
        status: item.status,
      };
      changed = true;
    }

    item.status = state.items[item.id].status;
    item.lastDecision = state.items[item.id].lastDecision;
  }

  if (changed) {
    saveReviewState(state);
  }

  return items.map((item) => {
    const persisted = state.items[item.id];
    return persisted
      ? { ...item, status: persisted.status, lastDecision: persisted.lastDecision }
      : item;
  });
}

function buildReviewItemsForJob(jobId: string): RuntimeReviewItem[] {
  const runtimeDoc = loadMarketingJobRuntime(jobId);
  if (!runtimeDoc) {
    return [];
  }

  const status = getMarketingJobStatus(jobId);
  const view = buildCampaignWorkspaceView(jobId);
  const campaignNameValue = campaignName(status, view);

  const items: RuntimeReviewItem[] = [];
  if (view.brandReview) {
    items.push(stageReviewItem(view, view.brandReview, campaignNameValue));
  }
  if (view.strategyReview) {
    items.push(stageReviewItem(view, view.strategyReview, campaignNameValue));
  }
  for (const asset of view.creativeReview?.assets || []) {
    items.push(creativeReviewItem(view, asset, campaignNameValue));
  }
  items.push(...publishPreviewReviewItems(status, view, campaignNameValue));

  const approvalItem = workflowApprovalItem(status, view, runtimeDoc, campaignNameValue);
  if (approvalItem) {
    items.push(approvalItem);
  }

  return mergeReviewState(jobId, runtimeDoc.tenant_id, items);
}

function resolveRuntimeReviewItem(jobId: string, reviewId: string): RuntimeReviewItem | null {
  const items = buildReviewItemsForJob(jobId);
  const exact = items.find((item) => item.id === reviewId);
  if (exact) {
    return exact;
  }

  const { itemId } = reviewIdParts(reviewId);
  if (itemId) {
    const byCurrentVersionId = items.find((item) => item.currentVersion.id === itemId || item.assetId === itemId);
    if (byCurrentVersionId) {
      return byCurrentVersionId;
    }
  }

  const runtimeDoc = loadMarketingJobRuntime(jobId);
  if (!runtimeDoc) {
    return null;
  }
  const state = loadReviewState(jobId, runtimeDoc.tenant_id);
  const persisted = state.items[reviewId];
  if (!persisted) {
    return null;
  }

  return items.find((item) => reviewItemSourceHash(item) === persisted.sourceHash) ?? null;
}

function nextStatusFromAction(action: 'approve' | 'changes_requested' | 'reject'): RuntimeCampaignStatus {
  if (action === 'approve') {
    return 'approved';
  }
  if (action === 'reject') {
    return 'rejected';
  }
  return 'changes_requested';
}

function persistReviewDecision(
  tenantId: string,
  item: RuntimeReviewItem,
  reviewId: string,
  action: 'approve' | 'changes_requested' | 'reject',
  actedBy: string,
  note?: string,
): RuntimeReviewDecision {
  const state = loadReviewState(item.jobId, tenantId);
  const lastDecision: RuntimeReviewDecision = {
    action,
    actedBy,
    note: note?.trim() || null,
    at: nowIso(),
  };
  const persisted = {
    sourceHash: reviewItemSourceHash(item),
    status: nextStatusFromAction(action),
    lastDecision,
  };
  state.items[item.id] = persisted;
  if (reviewId !== item.id) {
    state.items[reviewId] = persisted;
  }
  saveReviewState(state);
  return lastDecision;
}

function assertApprovalResult(result: Awaited<ReturnType<typeof approveMarketingJob>>) {
  if (result.reason === 'job_not_found' || result.reason === 'tenant_mismatch') {
    return;
  }
  if (result.reason === 'missing_approved_by') {
    throw new RuntimeReviewDecisionError('missing_approved_by', 'approvedBy is required.', 400);
  }
  if (result.reason === 'approval_not_available') {
    throw new RuntimeReviewDecisionError(
      'approval_not_available',
      'This campaign is not waiting on an active approval checkpoint.',
      409,
    );
  }
  if (result.reason === 'approval_stage_not_selected') {
    throw new RuntimeReviewDecisionError(
      'approval_stage_not_selected',
      'The current approval checkpoint was not selected.',
      409,
    );
  }
  if (result.reason === 'workflow_missing_for_route') {
    throw new RuntimeReviewDecisionError(
      'workflow_missing_for_route',
      'The workflow route for this approval is not available.',
      501,
    );
  }
  if (result.status !== 'resumed' && result.status !== 'already_resolved') {
    throw new RuntimeReviewDecisionError(
      result.reason || 'approval_failed',
      `Approval failed: ${result.reason || result.status}`,
      400,
    );
  }
}

function assertDenialResult(result: Awaited<ReturnType<typeof denyMarketingJob>>) {
  if (result.reason === 'approval_not_available') {
    throw new RuntimeReviewDecisionError(
      'approval_not_available',
      'This campaign is not waiting on an active approval checkpoint.',
      409,
    );
  }

  if (result.status !== 'denied' && result.status !== 'already_resolved') {
    throw new RuntimeReviewDecisionError(
      result.reason || 'approval_denial_failed',
      `Approval denial failed: ${result.reason || result.status}`,
      400,
    );
  }
}

export async function listMarketingCampaignsForTenant(tenantId: string): Promise<RuntimeCampaignListItem[]> {
  const campaigns: RuntimeCampaignListItem[] = [];
  const seen = new Set<string>();

  for (const jobId of listMarketingJobIdsForTenant(tenantId)) {
    const status = getMarketingJobStatus(jobId);
    if (status.tenantName === null && status.brandWebsiteUrl === null && status.status === 'error') {
      continue;
    }
    const view = buildCampaignWorkspaceView(jobId);
    const key = view.dashboard.campaign?.externalCampaignId || view.dashboard.campaign?.name || `job::${jobId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const pendingApprovals = buildReviewItemsForJob(jobId).filter((item) => item.status !== 'approved').length;
    campaigns.push(buildCampaignListItem(status, view, pendingApprovals));
  }

  return campaigns.sort((left, right) => {
    const leftUpdated = Date.parse(left.updatedAt || '');
    const rightUpdated = Date.parse(right.updatedAt || '');
    return (Number.isFinite(rightUpdated) ? rightUpdated : 0) - (Number.isFinite(leftUpdated) ? leftUpdated : 0);
  });
}

export async function listPublicMarketingCampaigns(): Promise<RuntimeCampaignListItem[]> {
  const byId = new Map<string, RuntimeCampaignListItem>();

  for (const tenantId of listMarketingTenantIds()) {
    const campaigns = await listMarketingCampaignsForTenant(tenantId);
    for (const campaign of campaigns) {
      if (!byId.has(campaign.id)) {
        byId.set(campaign.id, campaign);
      }
    }
  }

  return [...byId.values()].sort((left, right) => {
    const leftUpdated = Date.parse(left.updatedAt || '');
    const rightUpdated = Date.parse(right.updatedAt || '');
    return (Number.isFinite(rightUpdated) ? rightUpdated : 0) - (Number.isFinite(leftUpdated) ? leftUpdated : 0);
  });
}

export async function getMarketingCampaignContentForTenant(
  tenantId: string,
  campaignId: string,
): Promise<MarketingDashboardCampaignContent | null> {
  const jobIds = new Set(listMarketingJobIdsForTenant(tenantId));
  if (!jobIds.has(campaignId)) {
    return null;
  }
  return buildCampaignWorkspaceView(campaignId).dashboard;
}

export async function listMarketingPostsForTenant(tenantId: string): Promise<MarketingDashboardContent> {
  return getWorkflowAwareDashboardContentForTenant(tenantId);
}

export async function listPublicMarketingPosts(): Promise<MarketingDashboardContent> {
  const tenantIds = listMarketingTenantIds();
  const emptyTenantId = tenantIds[0] || 'public_empty';
  const content = getWorkflowAwareDashboardContentForTenant(emptyTenantId);

  if (tenantIds.length <= 1) {
    return content;
  }

  const campaigns = [] as MarketingDashboardContent['campaigns'];
  const posts = [] as MarketingDashboardContent['posts'];
  const assets = [] as MarketingDashboardContent['assets'];
  const publishItems = [] as MarketingDashboardContent['publishItems'];
  const calendarEvents = [] as MarketingDashboardContent['calendarEvents'];
  const statuses = {
    countsByStatus: {
      draft: 0,
      in_review: 0,
      ready: 0,
      ready_to_publish: 0,
      published_to_meta_paused: 0,
      scheduled: 0,
      live: 0,
    },
  };

  for (const tenantId of tenantIds) {
    const next = getWorkflowAwareDashboardContentForTenant(tenantId);
    campaigns.push(...next.campaigns);
    posts.push(...next.posts);
    assets.push(...next.assets);
    publishItems.push(...next.publishItems);
    calendarEvents.push(...next.calendarEvents);
    for (const key of Object.keys(statuses.countsByStatus) as Array<keyof typeof statuses.countsByStatus>) {
      statuses.countsByStatus[key] += next.statuses.countsByStatus[key];
    }
  }

  campaigns.sort((left, right) => {
    const leftUpdated = Date.parse(left.updatedAt || '');
    const rightUpdated = Date.parse(right.updatedAt || '');
    return (Number.isFinite(rightUpdated) ? rightUpdated : 0) - (Number.isFinite(leftUpdated) ? leftUpdated : 0);
  });
  calendarEvents.sort((left, right) => left.startsAt.localeCompare(right.startsAt));

  return {
    campaigns,
    posts,
    assets,
    publishItems,
    calendarEvents,
    statuses,
  };
}

export async function listMarketingReviewItemsForTenant(tenantId: string): Promise<RuntimeReviewItem[]> {
  return (await listMarketingReviewQueueForTenant(tenantId)).reviews;
}

export async function listMarketingReviewQueueForTenant(tenantId: string): Promise<RuntimeReviewQueue> {
  const items = listMarketingJobIdsForTenant(tenantId)
    .flatMap((jobId) => buildReviewItemsForJob(jobId))
    .filter((item) => item.status !== 'approved');

  return buildRuntimeReviewQueue(items);
}

export async function listPublicMarketingReviewItems(): Promise<RuntimeReviewItem[]> {
  const items = [] as RuntimeReviewItem[];
  for (const tenantId of listMarketingTenantIds()) {
    items.push(...(await listMarketingReviewItemsForTenant(tenantId)));
  }
  return items.sort((left, right) => right.scheduledFor.localeCompare(left.scheduledFor));
}

export async function getMarketingReviewItemForTenant(tenantId: string, reviewId: string): Promise<RuntimeReviewItem | null> {
  const { jobId } = reviewIdParts(reviewId);
  const runtimeDoc = loadMarketingJobRuntime(jobId);
  if (!runtimeDoc || runtimeDoc.tenant_id !== tenantId) {
    return null;
  }
  return resolveRuntimeReviewItem(jobId, reviewId);
}

export async function recordMarketingReviewDecision(input: {
  tenantId: string;
  reviewId: string;
  action: 'approve' | 'changes_requested' | 'reject';
  actedBy: string;
  note?: string;
  approvalId?: string;
}): Promise<RuntimeReviewItem | null> {
  const { jobId } = reviewIdParts(input.reviewId);
  const runtimeDoc = loadMarketingJobRuntime(jobId);
  if (!runtimeDoc || runtimeDoc.tenant_id !== input.tenantId) {
    return null;
  }

  const item = resolveRuntimeReviewItem(jobId, input.reviewId);
  if (!item) {
    return null;
  }

  if (isWorkflowApprovalItem(item)) {
    const workspaceRecord = ensureCampaignWorkspaceRecord({
      jobId,
      tenantId: input.tenantId,
      payload: (runtimeDoc.inputs.request as Record<string, unknown>) || {},
    });
    const approvalStage = runtimeDoc.approvals.current?.stage || runtimeDoc.current_stage;

    if (input.action === 'approve') {
      const checkpoint = runtimeDoc.approvals.current;
      const approvalResult = await approveMarketingJob({
        jobId,
        tenantId: input.tenantId,
        approvedBy: input.actedBy,
        approvedStages: checkpoint ? [checkpoint.stage] : undefined,
        approvalId: input.approvalId,
        resumePublishIfNeeded: checkpoint?.stage === 'publish' ? true : undefined,
        publishConfig: checkpoint?.stage === 'publish' ? (checkpoint.publish_config ?? undefined) : undefined,
      });
      assertApprovalResult(approvalResult);
    } else if (input.action === 'changes_requested') {
      if (approvalStage === 'strategy') {
        setStageReviewDecision(workspaceRecord, 'strategy', input.action, input.actedBy, input.note);
        saveCampaignWorkspaceRecord(workspaceRecord);
      } else if (approvalStage === 'production' || approvalStage === 'publish') {
        setStageReviewDecision(workspaceRecord, 'creative', input.action, input.actedBy, input.note);
        saveCampaignWorkspaceRecord(workspaceRecord);
      }
    } else if (input.action === 'reject') {
      if (approvalStage === 'strategy') {
        setStageReviewDecision(workspaceRecord, 'strategy', input.action, input.actedBy, input.note);
        saveCampaignWorkspaceRecord(workspaceRecord);
      } else if (approvalStage === 'production' || approvalStage === 'publish') {
        setStageReviewDecision(workspaceRecord, 'creative', input.action, input.actedBy, input.note);
        saveCampaignWorkspaceRecord(workspaceRecord);
      }
      const denialResult = await denyMarketingJob(
        {
          jobId,
          tenantId: input.tenantId,
          deniedBy: input.actedBy,
          approvalId: input.approvalId,
          note: input.note,
          publishConfig:
            runtimeDoc.approvals.current?.stage === 'publish'
              ? (runtimeDoc.approvals.current.publish_config ?? undefined)
              : undefined,
        },
        runtimeDoc,
      );
      assertDenialResult(denialResult);
    }
  } else {
    const workspaceRecord = ensureCampaignWorkspaceRecord({
      jobId,
      tenantId: input.tenantId,
      payload: (runtimeDoc.inputs.request as Record<string, unknown>) || {},
    });

    if (item.reviewType === 'brand') {
      setStageReviewDecision(workspaceRecord, 'brand', input.action, input.actedBy, input.note);
      saveCampaignWorkspaceRecord(workspaceRecord);
    }

    if (item.reviewType === 'strategy') {
      setStageReviewDecision(workspaceRecord, 'strategy', input.action, input.actedBy, input.note);
      saveCampaignWorkspaceRecord(workspaceRecord);

      if (runtimeDoc.approvals.current?.stage === 'strategy') {
        if (input.action === 'approve') {
          const approvalResult = await approveMarketingJob({
            jobId,
            tenantId: input.tenantId,
            approvedBy: input.actedBy,
            approvedStages: ['strategy'],
            approvalId: input.approvalId,
          });
          assertApprovalResult(approvalResult);
        } else {
          const denialResult = await denyMarketingJob(
            {
              jobId,
              tenantId: input.tenantId,
              deniedBy: input.actedBy,
              approvalId: input.approvalId,
              note: input.note,
            },
            runtimeDoc,
          );
          assertDenialResult(denialResult);
        }
      }
    }

    if (item.reviewType === 'creative' && item.assetId) {
      setCreativeAssetDecision(workspaceRecord, item.assetId, input.action, input.actedBy, input.note);
      saveCampaignWorkspaceRecord(workspaceRecord);

      if (input.action === 'approve' && runtimeDoc.approvals.current?.stage === 'production') {
        const refreshedView = buildCampaignWorkspaceView(jobId);
        if (refreshedView.creativeReview?.approvalComplete) {
          const approvalResult = await approveMarketingJob({
            jobId,
            tenantId: input.tenantId,
            approvedBy: input.actedBy,
            approvedStages: ['production'],
            approvalId: input.approvalId,
          });
          assertApprovalResult(approvalResult);
        }
      }
    }
  }

  const lastDecision = persistReviewDecision(input.tenantId, item, input.reviewId, input.action, input.actedBy, input.note);
  const refreshed = resolveRuntimeReviewItem(jobId, item.id) || resolveRuntimeReviewItem(jobId, input.reviewId);
  if (!refreshed) {
    return {
      ...item,
      status: nextStatusFromAction(input.action),
      lastDecision,
    };
  }

  return {
    ...refreshed,
    status: nextStatusFromAction(input.action),
    lastDecision,
  };
}

export async function countPendingMarketingReviewItemsForTenant(tenantId: string): Promise<number> {
  return (await listMarketingReviewQueueForTenant(tenantId)).reviews.length;
}
