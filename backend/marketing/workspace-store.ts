import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { resolveDataPath } from '@/lib/runtime-paths';
import { marketingPayloadDefaultsFromBusinessProfile } from '@/backend/tenant/business-profile';

export type MarketingCampaignWorkflowState =
  | 'draft'
  | 'brand_review_required'
  | 'strategy_review_required'
  | 'creative_review_required'
  | 'revisions_requested'
  | 'approved'
  | 'ready_to_publish'
  | 'published';

export type MarketingReviewStageKey = 'brand' | 'strategy' | 'creative';

export type MarketingReviewDecisionAction = 'approve' | 'changes_requested' | 'reject';

export type MarketingReviewStatus =
  | 'not_ready'
  | 'pending_review'
  | 'approved'
  | 'changes_requested'
  | 'rejected';

export type CampaignBriefAssetRecord = {
  id: string;
  name: string;
  fileName: string;
  contentType: string;
  filePath: string;
  size: number;
  uploadedAt: string;
};

export type CampaignBriefRecord = {
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
  brandAssets: CampaignBriefAssetRecord[];
};

export type CampaignStatusHistoryEntry = {
  id: string;
  at: string;
  actor: string;
  type: 'state_changed' | 'stage_review' | 'creative_asset_review' | 'comment';
  workflowState: MarketingCampaignWorkflowState;
  stage?: MarketingReviewStageKey;
  assetId?: string;
  action?: MarketingReviewDecisionAction;
  note?: string | null;
  status?: MarketingReviewStatus;
};

export type CampaignStageReviewState = {
  status: MarketingReviewStatus;
  latestNote: string | null;
  updatedAt: string | null;
};

export type CampaignCreativeAssetReviewState = {
  assetId: string;
  status: MarketingReviewStatus;
  latestNote: string | null;
  updatedAt: string | null;
};

export type CampaignWorkspaceRecord = {
  schema_name: 'marketing_campaign_workspace';
  schema_version: '1.0.0';
  job_id: string;
  tenant_id: string;
  workflow_state: MarketingCampaignWorkflowState;
  brief: CampaignBriefRecord;
  stage_reviews: Record<MarketingReviewStageKey, CampaignStageReviewState>;
  creative_asset_reviews: Record<string, CampaignCreativeAssetReviewState>;
  status_history: CampaignStatusHistoryEntry[];
  created_at: string;
  updated_at: string;
};

export type CampaignWorkflowSnapshot = {
  brandReviewReady: boolean;
  strategyReviewReady: boolean;
  creativeReviewReady: boolean;
  creativeAssetIds: string[];
  publishReadySignal: boolean;
  publishedSignal: boolean;
};

export type CampaignWorkflowResolution = {
  workflowState: MarketingCampaignWorkflowState;
  creativeApprovedCount: number;
  creativePendingCount: number;
  creativeRejectedCount: number;
  publishBlockedReason: string | null;
};

export type CreateCampaignWorkspaceInput = {
  jobId: string;
  tenantId: string;
  payload?: Record<string, unknown>;
};

export type CampaignWorkspaceAssetUpload = {
  name: string;
  contentType: string;
  data: Buffer;
};

function nowIso(): string {
  return new Date().toISOString();
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() || fallback : fallback;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim());
}

function coalesceStringPayload(primary: unknown, fallback: unknown): string | undefined {
  const primaryValue = stringValue(primary);
  if (primaryValue) {
    return primaryValue;
  }
  const fallbackValue = stringValue(fallback);
  return fallbackValue || undefined;
}

function withBusinessProfileDefaults(
  tenantId: string,
  payload: Record<string, unknown> = {},
): Record<string, unknown> {
  const defaults = marketingPayloadDefaultsFromBusinessProfile(tenantId);
  const nextPayload = { ...payload };

  const mergedChannels = stringArray(payload.channels);
  if (mergedChannels.length === 0 && defaults.channels && defaults.channels.length > 0) {
    nextPayload.channels = defaults.channels;
  }

  const websiteUrl = coalesceStringPayload(payload.websiteUrl || payload.brandUrl, defaults.websiteUrl);
  if (websiteUrl) {
    nextPayload.websiteUrl = websiteUrl;
    if (!stringValue(payload.brandUrl)) {
      nextPayload.brandUrl = websiteUrl;
    }
  }

  const mappings: Array<[keyof typeof defaults, string[]]> = [
    ['businessName', ['businessName']],
    ['businessType', ['businessType']],
    ['primaryGoal', ['primaryGoal', 'goal']],
    ['approverName', ['approverName', 'launchApproverName']],
    ['offer', ['offer']],
    ['competitorUrl', ['competitorUrl']],
  ];

  for (const [defaultKey, payloadKeys] of mappings) {
    const defaultValue = defaults[defaultKey];
    if (!defaultValue) {
      continue;
    }
    for (const payloadKey of payloadKeys) {
      if (!stringValue(nextPayload[payloadKey])) {
        nextPayload[payloadKey] = defaultValue;
      }
    }
  }

  return nextPayload;
}

function workspaceRoot(jobId: string): string {
  return resolveDataPath('generated', 'draft', 'marketing-workspaces', jobId);
}

function workspaceStatePath(jobId: string): string {
  return path.join(workspaceRoot(jobId), 'workspace.json');
}

function workspaceAssetsRoot(jobId: string): string {
  return path.join(workspaceRoot(jobId), 'brief-assets');
}

export function marketingWorkspaceAssetUrl(jobId: string, assetId: string): string {
  return `/api/marketing/jobs/${encodeURIComponent(jobId)}/workspace-assets/${encodeURIComponent(assetId)}`;
}

function safeFileName(fileName: string): string {
  const base = path.basename(fileName).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-');
  return base || 'asset';
}

function emptyStageReviewState(): CampaignStageReviewState {
  return {
    status: 'not_ready',
    latestNote: null,
    updatedAt: null,
  };
}

function normalizeCampaignBrief(
  payload: Record<string, unknown> = {},
  existing?: CampaignBriefRecord,
): CampaignBriefRecord {
  return {
    websiteUrl: stringValue(payload.websiteUrl || payload.brandUrl, existing?.websiteUrl || ''),
    businessName: stringValue(payload.businessName, existing?.businessName || ''),
    businessType: stringValue(payload.businessType, existing?.businessType || ''),
    approverName: stringValue(payload.approverName || payload.launchApproverName, existing?.approverName || ''),
    goal: stringValue(payload.goal || payload.primaryGoal, existing?.goal || ''),
    offer: stringValue(payload.offer, existing?.offer || ''),
    competitorUrl: stringValue(payload.competitorUrl, existing?.competitorUrl || ''),
    channels: stringArray(payload.channels).length > 0
      ? stringArray(payload.channels)
      : (existing?.channels || []),
    brandVoice: stringValue(payload.brandVoice, existing?.brandVoice || ''),
    styleVibe: stringValue(payload.styleVibe, existing?.styleVibe || ''),
    visualReferences: stringArray(payload.visualReferences).length > 0
      ? stringArray(payload.visualReferences)
      : (existing?.visualReferences || []),
    mustUseCopy: stringValue(payload.mustUseCopy, existing?.mustUseCopy || ''),
    mustAvoidAesthetics: stringValue(payload.mustAvoidAesthetics, existing?.mustAvoidAesthetics || ''),
    notes: stringValue(payload.notes, existing?.notes || ''),
    brandAssets: existing?.brandAssets || [],
  };
}

export function createCampaignWorkspaceRecord(input: CreateCampaignWorkspaceInput): CampaignWorkspaceRecord {
  const ts = nowIso();
  const payload = withBusinessProfileDefaults(input.tenantId, input.payload || {});
  return {
    schema_name: 'marketing_campaign_workspace',
    schema_version: '1.0.0',
    job_id: input.jobId,
    tenant_id: input.tenantId,
    workflow_state: 'draft',
    brief: normalizeCampaignBrief(payload),
    stage_reviews: {
      brand: emptyStageReviewState(),
      strategy: emptyStageReviewState(),
      creative: emptyStageReviewState(),
    },
    creative_asset_reviews: {},
    status_history: [
      {
        id: `hist_${randomUUID()}`,
        at: ts,
        actor: 'system',
        type: 'state_changed',
        workflowState: 'draft',
        note: 'Campaign workspace created.',
      },
    ],
    created_at: ts,
    updated_at: ts,
  };
}

export function loadCampaignWorkspaceRecord(jobId: string, tenantId?: string): CampaignWorkspaceRecord | null {
  const filePath = workspaceStatePath(jobId);
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as CampaignWorkspaceRecord;
    if (!parsed || parsed.schema_name !== 'marketing_campaign_workspace' || parsed.job_id !== jobId) {
      return null;
    }
    if (tenantId && parsed.tenant_id !== tenantId) {
      return null;
    }
    parsed.stage_reviews ||= {
      brand: emptyStageReviewState(),
      strategy: emptyStageReviewState(),
      creative: emptyStageReviewState(),
    };
    parsed.creative_asset_reviews ||= {};
    parsed.status_history ||= [];
    parsed.brief = normalizeCampaignBrief(parsed.brief as unknown as Record<string, unknown>, parsed.brief);
    return parsed;
  } catch {
    return null;
  }
}

export function saveCampaignWorkspaceRecord(record: CampaignWorkspaceRecord): string {
  const filePath = workspaceStatePath(record.job_id);
  mkdirSync(path.dirname(filePath), { recursive: true });
  record.updated_at = nowIso();
  writeFileSync(filePath, JSON.stringify(record, null, 2));
  return filePath;
}

export function ensureCampaignWorkspaceRecord(input: CreateCampaignWorkspaceInput): CampaignWorkspaceRecord {
  const payload = withBusinessProfileDefaults(input.tenantId, input.payload || {});
  const existing = loadCampaignWorkspaceRecord(input.jobId, input.tenantId);
  if (existing) {
    existing.brief = normalizeCampaignBrief(payload, existing.brief);
    saveCampaignWorkspaceRecord(existing);
    return existing;
  }

  const created = createCampaignWorkspaceRecord({ ...input, payload });
  saveCampaignWorkspaceRecord(created);
  return created;
}

export function saveCampaignWorkspaceAssets(
  record: CampaignWorkspaceRecord,
  uploads: CampaignWorkspaceAssetUpload[],
): CampaignWorkspaceRecord {
  if (uploads.length === 0) {
    return record;
  }

  mkdirSync(workspaceAssetsRoot(record.job_id), { recursive: true });

  const assets = uploads.map((upload) => {
    const assetId = `brief_asset_${randomUUID()}`;
    const fileName = safeFileName(upload.name);
    const filePath = path.join(workspaceAssetsRoot(record.job_id), `${assetId}-${fileName}`);
    writeFileSync(filePath, upload.data);
    return {
      id: assetId,
      name: upload.name || fileName,
      fileName,
      contentType: upload.contentType || 'application/octet-stream',
      filePath,
      size: upload.data.byteLength,
      uploadedAt: nowIso(),
    } satisfies CampaignBriefAssetRecord;
  });

  record.brief.brandAssets = [...record.brief.brandAssets, ...assets];
  appendCampaignHistory(record, {
    actor: 'system',
    type: 'comment',
    workflowState: record.workflow_state,
    note: `${assets.length} brand asset${assets.length === 1 ? '' : 's'} uploaded.`,
  });
  saveCampaignWorkspaceRecord(record);
  return record;
}

export function appendCampaignHistory(
  record: CampaignWorkspaceRecord,
  entry: Omit<CampaignStatusHistoryEntry, 'id' | 'at'> & { at?: string },
): CampaignStatusHistoryEntry {
  const created: CampaignStatusHistoryEntry = {
    id: `hist_${randomUUID()}`,
    at: entry.at || nowIso(),
    actor: entry.actor,
    type: entry.type,
    workflowState: entry.workflowState,
    stage: entry.stage,
    assetId: entry.assetId,
    action: entry.action,
    note: entry.note ?? null,
    status: entry.status,
  };
  record.status_history.push(created);
  return created;
}

export function setStageReviewDecision(
  record: CampaignWorkspaceRecord,
  stage: MarketingReviewStageKey,
  action: MarketingReviewDecisionAction,
  actor: string,
  note?: string,
): CampaignStageReviewState {
  const nextStatus: MarketingReviewStatus =
    action === 'approve'
      ? 'approved'
      : action === 'reject'
        ? 'rejected'
        : 'changes_requested';
  const state = record.stage_reviews[stage] || emptyStageReviewState();
  state.status = nextStatus;
  state.latestNote = note?.trim() || null;
  state.updatedAt = nowIso();
  record.stage_reviews[stage] = state;
  appendCampaignHistory(record, {
    actor,
    type: 'stage_review',
    workflowState: record.workflow_state,
    stage,
    action,
    note: note?.trim() || null,
    status: nextStatus,
  });
  return state;
}

export function setCreativeAssetDecision(
  record: CampaignWorkspaceRecord,
  assetId: string,
  action: MarketingReviewDecisionAction,
  actor: string,
  note?: string,
): CampaignCreativeAssetReviewState {
  const nextStatus: MarketingReviewStatus =
    action === 'approve'
      ? 'approved'
      : action === 'reject'
        ? 'rejected'
        : 'changes_requested';
  const state = record.creative_asset_reviews[assetId] || {
    assetId,
    status: 'pending_review' as MarketingReviewStatus,
    latestNote: null,
    updatedAt: null,
  };
  state.status = nextStatus;
  state.latestNote = note?.trim() || null;
  state.updatedAt = nowIso();
  record.creative_asset_reviews[assetId] = state;
  appendCampaignHistory(record, {
    actor,
    type: 'creative_asset_review',
    workflowState: record.workflow_state,
    stage: 'creative',
    assetId,
    action,
    note: note?.trim() || null,
    status: nextStatus,
  });
  return state;
}

function anyRequestedChanges(record: CampaignWorkspaceRecord, creativeAssetIds: string[]): boolean {
  if (
    record.stage_reviews.brand.status === 'changes_requested' ||
    record.stage_reviews.brand.status === 'rejected' ||
    record.stage_reviews.strategy.status === 'changes_requested' ||
    record.stage_reviews.strategy.status === 'rejected' ||
    record.stage_reviews.creative.status === 'changes_requested' ||
    record.stage_reviews.creative.status === 'rejected'
  ) {
    return true;
  }

  return creativeAssetIds.some((assetId) => {
    const state = record.creative_asset_reviews[assetId];
    return state?.status === 'changes_requested' || state?.status === 'rejected';
  });
}

export function resolveCampaignWorkflowState(
  record: CampaignWorkspaceRecord,
  snapshot: CampaignWorkflowSnapshot,
): CampaignWorkflowResolution {
  const creativeStates = snapshot.creativeAssetIds.map((assetId) => record.creative_asset_reviews[assetId]);
  const creativeApprovedCount = creativeStates.filter((state) => state?.status === 'approved').length;
  const creativeRejectedCount = creativeStates.filter(
    (state) => state?.status === 'changes_requested' || state?.status === 'rejected',
  ).length;
  const creativePendingCount = snapshot.creativeAssetIds.length - creativeApprovedCount - creativeRejectedCount;
  const creativeResolved =
    snapshot.creativeAssetIds.length === 0
      ? record.stage_reviews.creative.status === 'approved'
      : creativePendingCount === 0 && creativeRejectedCount === 0;

  let workflowState: MarketingCampaignWorkflowState = 'draft';
  let publishBlockedReason: string | null = null;

  if (snapshot.publishedSignal) {
    workflowState = 'published';
  } else if (anyRequestedChanges(record, snapshot.creativeAssetIds)) {
    workflowState = 'revisions_requested';
    publishBlockedReason = 'Revisions were requested and must be resolved before publishing.';
  } else if (snapshot.brandReviewReady && record.stage_reviews.brand.status !== 'approved') {
    workflowState = 'brand_review_required';
    publishBlockedReason = 'Brand review must be approved before the campaign can move forward.';
  } else if (snapshot.strategyReviewReady && record.stage_reviews.strategy.status !== 'approved') {
    workflowState = 'strategy_review_required';
    publishBlockedReason = 'Strategy review must be approved before creative can move forward.';
  } else if (snapshot.creativeReviewReady && !creativeResolved) {
    workflowState = 'creative_review_required';
    publishBlockedReason = 'Every required creative asset must be approved before publish can be unlocked.';
  } else if (snapshot.publishReadySignal) {
    workflowState = 'ready_to_publish';
  } else if (
    snapshot.brandReviewReady &&
    record.stage_reviews.brand.status === 'approved' &&
    (!snapshot.strategyReviewReady || record.stage_reviews.strategy.status === 'approved') &&
    (!snapshot.creativeReviewReady || creativeResolved)
  ) {
    workflowState = 'approved';
  }

  if (workflowState === 'approved' && !snapshot.publishReadySignal) {
    publishBlockedReason = 'Publish-ready outputs are not available yet.';
  }

  return {
    workflowState,
    creativeApprovedCount,
    creativePendingCount,
    creativeRejectedCount,
    publishBlockedReason,
  };
}

export function syncCampaignWorkflowState(
  record: CampaignWorkspaceRecord,
  snapshot: CampaignWorkflowSnapshot,
): CampaignWorkflowResolution {
  const resolution = resolveCampaignWorkflowState(record, snapshot);
  if (record.workflow_state !== resolution.workflowState) {
    record.workflow_state = resolution.workflowState;
    appendCampaignHistory(record, {
      actor: 'system',
      type: 'state_changed',
      workflowState: resolution.workflowState,
      note: `Workflow state changed to ${resolution.workflowState}.`,
      status: 'approved',
    });
  }
  saveCampaignWorkspaceRecord(record);
  return resolution;
}
