import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { resolveDataPath } from '@/lib/runtime-paths';

import { approveMarketingJob } from './jobs-approve';
import { denyMarketingJob } from './orchestrator';
import { loadMarketingJobRuntime, listMarketingJobIdsForTenant, type MarketingJobRuntimeDocument } from './runtime-state';
import {
  dashboardDateRangeText,
  getMarketingDashboardCampaignContent,
  getMarketingDashboardContentForTenant,
  type MarketingDashboardAsset,
  type MarketingDashboardCampaign,
  type MarketingDashboardCalendarEvent,
  type MarketingDashboardCampaignContent,
  type MarketingDashboardItemStatus,
  type MarketingDashboardPost,
  type MarketingDashboardPublishItem,
  type MarketingDashboardStatusSummary,
} from './dashboard-content';
import { getMarketingJobStatus, type MarketingJobStatusResponse, type MarketingReviewBundle } from './jobs-status';

export type RuntimeCampaignStatus = 'draft' | 'in_review' | 'approved' | 'scheduled' | 'live' | 'changes_requested';

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

function reviewItemSourceHash(item: RuntimeReviewItem): string {
  return stableHash({
    title: item.title,
    summary: item.summary,
    scheduledFor: item.scheduledFor,
    currentVersion: {
      label: item.currentVersion.label,
      headline: item.currentVersion.headline,
      supportingText: item.currentVersion.supportingText,
      cta: item.currentVersion.cta,
      notes: item.currentVersion.notes,
    },
    previousVersion: item.previousVersion
      ? {
          label: item.previousVersion.label,
          headline: item.previousVersion.headline,
          supportingText: item.previousVersion.supportingText,
          cta: item.previousVersion.cta,
          notes: item.previousVersion.notes,
        }
      : null,
  });
}

function isWorkflowApprovalItem(item: RuntimeReviewItem): boolean {
  return item.currentVersion.id === 'approval' || item.currentVersion.id.startsWith('approval:') || item.id.endsWith('::approval');
}

function mapCampaignStatus(status: MarketingJobStatusResponse): RuntimeCampaignStatus {
  if (status.approvalRequired) return 'in_review';
  const normalized = String(status.status || '').toLowerCase();
  if (status.calendarEvents.some((event) => String(event.status).toLowerCase() === 'published')) {
    return 'live';
  }
  if (normalized.includes('complete')) return 'scheduled';
  if (normalized.includes('running') || normalized.includes('pending')) return 'draft';
  if (normalized.includes('fail')) return 'changes_requested';
  return 'draft';
}

function campaignName(status: MarketingJobStatusResponse): string {
  return status.reviewBundle?.campaignName || status.tenantName || `Campaign ${status.jobId}`;
}

function campaignObjective(status: MarketingJobStatusResponse): string {
  return status.summary.headline || 'Campaign in progress';
}

function campaignDateRange(status: MarketingJobStatusResponse): string {
  if (status.campaignWindow?.start && status.campaignWindow?.end) {
    return `${status.campaignWindow.start} - ${status.campaignWindow.end}`;
  }
  return 'Dates not scheduled yet';
}

function nextScheduledText(status: MarketingJobStatusResponse): string {
  const next = status.calendarEvents
    .slice()
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0];
  if (!next) {
    return status.approvalRequired ? 'Waiting on approval before scheduling' : 'Nothing scheduled yet';
  }
  return `${next.startsAt}${next.platform ? ` · ${next.platform}` : ''}`;
}

function nextScheduledTextFromDashboard(events: MarketingDashboardCalendarEvent[]): string {
  const next = events
    .slice()
    .sort((left, right) => left.startsAt.localeCompare(right.startsAt))[0];
  if (!next) {
    return 'Nothing scheduled yet';
  }
  return `${next.startsAt} · ${next.statusLabel}${next.platformLabel ? ` · ${next.platformLabel}` : ''}`;
}

function buildCampaignListItem(
  status: MarketingJobStatusResponse,
  dashboardCampaign: MarketingDashboardCampaign | null,
  dashboard: MarketingDashboardCampaignContent,
  pendingApprovals: number,
): RuntimeCampaignListItem {
  const fallbackStatus = mapCampaignStatus(status);
  return {
    id: status.jobId,
    jobId: status.jobId,
    name: dashboardCampaign?.name || campaignName(status),
    objective: dashboardCampaign?.objective || campaignObjective(status),
    funnelStage: dashboardCampaign?.funnelStage || null,
    status: dashboardCampaign?.compatibilityStatus || fallbackStatus,
    dashboardStatus: dashboardCampaign?.status || 'draft',
    stageLabel: dashboardCampaign?.stageLabel || status.currentStage || 'campaign',
    summary: dashboardCampaign?.summary || status.summary.subheadline || 'Campaign status is available for review.',
    dateRange: dashboardCampaign ? dashboardDateRangeText(dashboardCampaign.campaignWindow) : campaignDateRange(status),
    pendingApprovals,
    nextScheduled: dashboard.calendarEvents.length > 0 ? nextScheduledTextFromDashboard(dashboard.calendarEvents) : nextScheduledText(status),
    trustNote: 'Nothing goes live without approval.',
    updatedAt: dashboardCampaign?.updatedAt || status.updatedAt,
    approvalRequired: dashboardCampaign?.approvalRequired ?? status.approvalRequired,
    approvalActionHref: dashboardCampaign?.approvalActionHref || status.approval?.actionHref,
    counts: dashboardCampaign?.counts || {
      posts: dashboard.posts.length,
      landingPages: dashboard.assets.filter((asset) => asset.type === 'landing_page').length,
      imageAds: dashboard.assets.filter((asset) => asset.type === 'image_ad').length,
      scripts: dashboard.assets.filter((asset) => asset.type === 'script' || asset.type === 'copy').length,
      publishItems: dashboard.publishItems.length,
      proposalConcepts: dashboard.posts.filter((post) => post.provenance.sourceKind === 'proposal').length,
      ready: dashboard.statuses.countsByStatus.ready,
      readyToPublish: dashboard.statuses.countsByStatus.ready_to_publish,
      pausedMetaAds: dashboard.statuses.countsByStatus.published_to_meta_paused,
      scheduled: dashboard.statuses.countsByStatus.scheduled,
      live: dashboard.statuses.countsByStatus.live,
    },
    previewPosts: dashboard.posts.slice(0, 3),
    previewAssets: dashboard.assets.slice(0, 3),
    dashboard: {
      posts: dashboard.posts,
      assets: dashboard.assets,
      publishItems: dashboard.publishItems,
      calendarEvents: dashboard.calendarEvents,
      statuses: dashboard.statuses,
    },
  };
}

function deriveScheduledFor(status: MarketingJobStatusResponse, previewId: string): string {
  const event = status.calendarEvents.find((entry) => entry.assetPreviewId === previewId) || status.calendarEvents[0];
  if (event) {
    return event.startsAt;
  }
  return status.approvalRequired ? 'Before launch approval' : 'Not scheduled yet';
}

function buildPreviewItems(status: MarketingJobStatusResponse, reviewBundle: MarketingReviewBundle): RuntimeReviewItem[] {
  if (reviewBundle.platformPreviews.length === 0) {
    return [];
  }

  const defaultStatus: RuntimeCampaignStatus = status.approvalRequired ? 'in_review' : 'approved';

  return reviewBundle.platformPreviews.map((preview) => ({
    id: `${status.jobId}::${preview.id}`,
    jobId: status.jobId,
    campaignId: status.jobId,
    campaignName: campaignName(status),
    title: preview.headline || preview.platformName,
    channel: preview.platformName,
    placement: preview.channelType,
    scheduledFor: deriveScheduledFor(status, preview.id),
    status: defaultStatus,
    summary: preview.summary,
    currentVersion: {
      id: preview.id,
      label: 'Current version',
      headline: preview.headline || preview.platformName,
      supportingText: preview.caption || preview.summary,
      cta: preview.cta || '',
      notes: preview.details,
    },
    previousVersion: undefined,
    lastDecision: null,
  }));
}

function buildFallbackApprovalItem(status: MarketingJobStatusResponse): RuntimeReviewItem[] {
  if (!status.approvalRequired || !status.approval) {
    return [];
  }

  return [{
    id: `${status.jobId}::approval`,
    jobId: status.jobId,
    campaignId: status.jobId,
    campaignName: campaignName(status),
    title: status.approval.title,
    channel: 'Campaign',
    placement: status.currentStage || 'approval',
    scheduledFor: 'Before launch approval',
    status: 'in_review',
    summary: status.approval.message,
    currentVersion: {
      id: status.approval?.approvalId ? `approval:${status.approval.approvalId}` : 'approval',
      label: 'Current version',
      headline: status.approval.title,
      supportingText: status.approval.message,
      cta: 'Approve',
      notes: status.approval.workflowStepId ? [`Workflow step: ${status.approval.workflowStepId}`] : [],
    },
    previousVersion: undefined,
    lastDecision: null,
  }];
}

function mergeReviewState(status: MarketingJobStatusResponse, items: RuntimeReviewItem[]): RuntimeReviewItem[] {
  const state = loadReviewState(status.jobId, status.tenantId || 'unknown');
  let changed = false;

  for (const item of items) {
    const sourceHash = reviewItemSourceHash(item);
    const exact = state.items[item.id];
    const existing = exact ?? Object.values(state.items).find((entry) => entry.sourceHash === sourceHash);

    if (!existing) {
      state.items[item.id] = {
        sourceHash,
        status: 'in_review',
        lastDecision: null,
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

function buildReviewItemsForStatus(status: MarketingJobStatusResponse): RuntimeReviewItem[] {
  const baseItems = [
    ...(status.reviewBundle ? buildPreviewItems(status, status.reviewBundle) : []),
    ...buildFallbackApprovalItem(status),
  ];
  return mergeReviewState(status, baseItems);
}

function resolveRuntimeReviewItem(status: MarketingJobStatusResponse, reviewId: string): RuntimeReviewItem | null {
  const items = buildReviewItemsForStatus(status);
  const exact = items.find((item) => item.id === reviewId);
  if (exact) {
    return exact;
  }

  const { itemId } = reviewIdParts(reviewId);
  if (itemId) {
    const byCurrentVersionId = items.find((item) => item.currentVersion.id === itemId);
    if (byCurrentVersionId) {
      return byCurrentVersionId;
    }
  }

  const state = loadReviewState(status.jobId, status.tenantId || 'unknown');
  const persisted = state.items[reviewId];
  if (!persisted) {
    return null;
  }

  return items.find((item) => reviewItemSourceHash(item) === persisted.sourceHash) ?? null;
}

export async function listMarketingCampaignsForTenant(tenantId: string): Promise<RuntimeCampaignListItem[]> {
  const content = getMarketingDashboardContentForTenant(tenantId);
  const campaignById = new Map(content.campaigns.map((campaign) => [campaign.jobId, campaign]));
  const campaigns = listMarketingJobIdsForTenant(tenantId).map((jobId) => {
    const status = getMarketingJobStatus(jobId);
    const pendingApprovals = buildReviewItemsForStatus(status).filter((item) => item.status !== 'approved').length;
    const dashboard = getMarketingDashboardCampaignContent(jobId);
    return buildCampaignListItem(status, campaignById.get(jobId) || null, dashboard, pendingApprovals);
  });

  return campaigns.sort((left, right) => {
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
  return getMarketingDashboardCampaignContent(campaignId);
}

export async function listMarketingPostsForTenant(
  tenantId: string,
): Promise<ReturnType<typeof getMarketingDashboardContentForTenant>> {
  return getMarketingDashboardContentForTenant(tenantId);
}

export async function listMarketingReviewItemsForTenant(tenantId: string): Promise<RuntimeReviewItem[]> {
  const jobIds = listMarketingJobIdsForTenant(tenantId);
  const items = jobIds.flatMap((jobId) => buildReviewItemsForStatus(getMarketingJobStatus(jobId)));
  return items.filter((item) => item.status !== 'approved');
}

export async function getMarketingReviewItemForTenant(tenantId: string, reviewId: string): Promise<RuntimeReviewItem | null> {
  const { jobId } = reviewIdParts(reviewId);
  const status = getMarketingJobStatus(jobId);
  if (status.tenantId !== tenantId) {
    return null;
  }
  return resolveRuntimeReviewItem(status, reviewId);
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

  const status = getMarketingJobStatus(jobId);
  const item = resolveRuntimeReviewItem(status, input.reviewId);
  if (!item) {
    return null;
  }

  if (input.action === 'approve' && isWorkflowApprovalItem(item)) {
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

    if (approvalResult.reason === 'job_not_found' || approvalResult.reason === 'tenant_mismatch') {
      return null;
    }

    if (approvalResult.reason === 'missing_approved_by') {
      throw new RuntimeReviewDecisionError(
        'missing_approved_by',
        'approvedBy is required.',
        400,
      );
    }

    if (approvalResult.reason === 'approval_not_available') {
      throw new RuntimeReviewDecisionError(
        'approval_not_available',
        'This campaign is not waiting on an active approval checkpoint.',
        409,
      );
    }

    if (approvalResult.reason === 'approval_stage_not_selected') {
      throw new RuntimeReviewDecisionError(
        'approval_stage_not_selected',
        'The current approval checkpoint was not selected.',
        409,
      );
    }

    if (approvalResult.reason === 'workflow_missing_for_route') {
      throw new RuntimeReviewDecisionError(
        'workflow_missing_for_route',
        'The workflow route for this approval is not available.',
        501,
      );
    }

    if (approvalResult.status !== 'resumed' && approvalResult.status !== 'already_resolved') {
      throw new RuntimeReviewDecisionError(
        approvalResult.reason || 'approval_failed',
        `Approval failed: ${approvalResult.reason || approvalResult.status}`,
        400,
      );
    }
  } else if (isWorkflowApprovalItem(item) && input.action === 'reject') {
    const denialResult = await denyMarketingJob({
      jobId,
      tenantId: input.tenantId,
      deniedBy: input.actedBy,
      approvalId: input.approvalId,
      note: input.note,
      publishConfig: runtimeDoc.approvals.current?.stage === 'publish'
        ? (runtimeDoc.approvals.current.publish_config ?? undefined)
        : undefined,
    }, runtimeDoc);

    if (denialResult.reason === 'approval_not_available') {
      throw new RuntimeReviewDecisionError(
        'approval_not_available',
        'This campaign is not waiting on an active approval checkpoint.',
        409,
      );
    }

    if (denialResult.status !== 'denied' && denialResult.status !== 'already_resolved') {
      throw new RuntimeReviewDecisionError(
        denialResult.reason || 'approval_denial_failed',
        `Approval denial failed: ${denialResult.reason || denialResult.status}`,
        400,
      );
    }
  }

  const state = loadReviewState(jobId, input.tenantId);
  const persisted = state.items[item.id] ?? state.items[input.reviewId] ?? {
    sourceHash: reviewItemSourceHash(item),
    status: 'in_review' as RuntimeCampaignStatus,
    lastDecision: null,
  };

  const nextStatus: RuntimeCampaignStatus =
    input.action === 'approve'
      ? 'approved'
      : input.action === 'reject'
        ? 'changes_requested'
        : 'changes_requested';

  persisted.status = nextStatus;
  persisted.lastDecision = {
    action: input.action,
    actedBy: input.actedBy,
    note: input.note?.trim() || null,
    at: nowIso(),
  };
  state.items[item.id] = persisted;
  if (input.reviewId !== item.id) {
    state.items[input.reviewId] = persisted;
  }
  saveReviewState(state);

  return {
    ...item,
    status: nextStatus,
    lastDecision: persisted.lastDecision,
  };
}

export async function countPendingMarketingReviewItemsForTenant(tenantId: string): Promise<number> {
  const reviews = await listMarketingReviewItemsForTenant(tenantId);
  return reviews.length;
}
