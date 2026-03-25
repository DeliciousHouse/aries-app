import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { resolveDataPath } from '@/lib/runtime-paths';

import { loadMarketingJobRuntime, listMarketingJobIdsForTenant, type MarketingJobRuntimeDocument } from './runtime-state';
import { getMarketingJobStatus, type MarketingJobStatusResponse, type MarketingReviewBundle } from './jobs-status';

export type RuntimeCampaignStatus = 'draft' | 'in_review' | 'approved' | 'scheduled' | 'live' | 'changes_requested';

export type RuntimeCampaignListItem = {
  id: string;
  jobId: string;
  name: string;
  objective: string;
  status: RuntimeCampaignStatus;
  stageLabel: string;
  summary: string;
  dateRange: string;
  pendingApprovals: number;
  nextScheduled: string;
  trustNote: string;
  updatedAt: string | null;
  approvalRequired: boolean;
  approvalActionHref?: string;
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

function buildCampaignListItem(status: MarketingJobStatusResponse, pendingApprovals: number): RuntimeCampaignListItem {
  return {
    id: status.jobId,
    jobId: status.jobId,
    name: campaignName(status),
    objective: campaignObjective(status),
    status: mapCampaignStatus(status),
    stageLabel: status.currentStage || 'campaign',
    summary: status.summary.subheadline || 'Campaign status is available for review.',
    dateRange: campaignDateRange(status),
    pendingApprovals,
    nextScheduled: nextScheduledText(status),
    trustNote: 'Nothing goes live without approval.',
    updatedAt: status.updatedAt,
    approvalRequired: status.approvalRequired,
    approvalActionHref: status.approval?.actionHref,
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

  return reviewBundle.platformPreviews.map((preview) => ({
    id: `${status.jobId}::${preview.id}`,
    jobId: status.jobId,
    campaignId: status.jobId,
    campaignName: campaignName(status),
    title: preview.headline || preview.platformName,
    channel: preview.platformName,
    placement: preview.channelType,
    scheduledFor: deriveScheduledFor(status, preview.id),
    status: 'in_review',
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
      id: 'approval',
      label: 'Current version',
      headline: status.approval.title,
      supportingText: status.approval.message,
      cta: 'Approve',
      notes: [],
    },
    previousVersion: undefined,
    lastDecision: null,
  }];
}

function mergeReviewState(status: MarketingJobStatusResponse, items: RuntimeReviewItem[]): RuntimeReviewItem[] {
  const state = loadReviewState(status.jobId, status.tenantId || 'unknown');
  let changed = false;

  for (const item of items) {
    const sourceHash = stableHash({
      title: item.title,
      summary: item.summary,
      currentVersion: item.currentVersion,
      scheduledFor: item.scheduledFor,
    });
    const existing = state.items[item.id];

    if (!existing) {
      state.items[item.id] = {
        sourceHash,
        status: 'in_review',
        lastDecision: null,
      };
      changed = true;
      continue;
    }

    if (existing.sourceHash !== sourceHash) {
      state.items[item.id] = {
        sourceHash,
        status: existing.status === 'approved' ? 'in_review' : existing.status,
        lastDecision: existing.lastDecision,
      };
      changed = true;
    }

    item.status = state.items[item.id].status;
    item.lastDecision = state.items[item.id].lastDecision;
  }

  const validIds = new Set(items.map((item) => item.id));
  for (const id of Object.keys(state.items)) {
    if (!validIds.has(id)) {
      delete state.items[id];
      changed = true;
    }
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
  const baseItems = status.reviewBundle
    ? buildPreviewItems(status, status.reviewBundle)
    : buildFallbackApprovalItem(status);
  return mergeReviewState(status, baseItems);
}

export async function listMarketingCampaignsForTenant(tenantId: string): Promise<RuntimeCampaignListItem[]> {
  const jobIds = listMarketingJobIdsForTenant(tenantId);
  return jobIds.map((jobId) => {
    const status = getMarketingJobStatus(jobId);
    const pendingApprovals = buildReviewItemsForStatus(status).filter((item) => item.status !== 'approved').length;
    return buildCampaignListItem(status, pendingApprovals);
  });
}

export async function listMarketingReviewItemsForTenant(tenantId: string): Promise<RuntimeReviewItem[]> {
  const jobIds = listMarketingJobIdsForTenant(tenantId);
  const items = jobIds.flatMap((jobId) => buildReviewItemsForStatus(getMarketingJobStatus(jobId)));
  return items.filter((item) => item.status !== 'approved');
}

export async function getMarketingReviewItemForTenant(tenantId: string, reviewId: string): Promise<RuntimeReviewItem | null> {
  const [jobId] = reviewId.split('::');
  const status = getMarketingJobStatus(jobId);
  if (status.tenantId !== tenantId) {
    return null;
  }
  return buildReviewItemsForStatus(status).find((item) => item.id === reviewId) ?? null;
}

export async function recordMarketingReviewDecision(input: {
  tenantId: string;
  reviewId: string;
  action: 'approve' | 'changes_requested' | 'reject';
  actedBy: string;
  note?: string;
}): Promise<RuntimeReviewItem | null> {
  const [jobId] = input.reviewId.split('::');
  const runtimeDoc = loadMarketingJobRuntime(jobId);
  if (!runtimeDoc || runtimeDoc.tenant_id !== input.tenantId) {
    return null;
  }

  const status = getMarketingJobStatus(jobId);
  const allItems = buildReviewItemsForStatus(status);
  const item = allItems.find((entry) => entry.id === input.reviewId);
  if (!item) {
    return null;
  }

  const state = loadReviewState(jobId, input.tenantId);
  const persisted = state.items[input.reviewId] ?? {
    sourceHash: stableHash({
      title: item.title,
      summary: item.summary,
      currentVersion: item.currentVersion,
      scheduledFor: item.scheduledFor,
    }),
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
  state.items[input.reviewId] = persisted;
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
