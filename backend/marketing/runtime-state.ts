import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { resolveDataPath, resolveSpecPath } from '@/lib/runtime-paths';

const REQUIRED_SCHEMA_PATHS = [
  resolveSpecPath('marketing_job_state_schema.v1.json'),
] as const;

export type MarketingStage = 'research' | 'strategy' | 'production' | 'publish';
export type MarketingJobState = 'queued' | 'running' | 'approval_required' | 'completed' | 'failed';
export type MarketingJobStatus = 'pending' | 'running' | 'awaiting_approval' | 'completed' | 'failed';
export type MarketingStageStatus = 'not_started' | 'in_progress' | 'awaiting_approval' | 'completed' | 'failed' | 'skipped';

export type MarketingStageArtifact = {
  id: string;
  stage: MarketingStage;
  title: string;
  category: string;
  status: string;
  summary: string;
  details: string[];
  path?: string | null;
  preview_path?: string | null;
  action_label?: string | null;
  action_href?: string | null;
};

export type MarketingStageSummary = {
  summary: string;
  highlight?: string | null;
};

export type MarketingStageError = {
  code: string;
  message: string;
  stage: MarketingStage;
  retryable?: boolean;
  details?: Record<string, unknown>;
  at: string;
};

export type MarketingStageRecord = {
  stage: MarketingStage;
  status: MarketingStageStatus;
  started_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  run_id: string | null;
  summary: MarketingStageSummary | null;
  primary_output: Record<string, unknown> | null;
  outputs: Record<string, unknown>;
  artifacts: MarketingStageArtifact[];
  errors: MarketingStageError[];
};

export type MarketingPublishConfig = {
  platforms: string[];
  live_publish_platforms: string[];
  video_render_platforms: string[];
};

export type MarketingApprovalCheckpoint = {
  stage: Extract<MarketingStage, 'strategy' | 'production' | 'publish'>;
  status: 'awaiting_approval';
  title: string;
  message: string;
  requested_at: string;
  action_label?: string | null;
  publish_config?: MarketingPublishConfig | null;
};

export type MarketingApprovalHistoryEntry = {
  stage: Extract<MarketingStage, 'strategy' | 'production' | 'publish'>;
  status: 'requested' | 'approved' | 'cleared';
  at: string;
  approved_by?: string | null;
  message?: string | null;
  publish_config?: MarketingPublishConfig | null;
};

export type MarketingHistoryEntry = {
  at: string;
  state: string;
  status: string;
  stage: MarketingStage | null;
  note: string;
};

export type MarketingJobRuntimeDocument = {
  schema_name: 'marketing_job_state_schema';
  schema_version: '1.0.0';
  job_id: string;
  tenant_id: string;
  job_type: 'brand_campaign';
  state: MarketingJobState;
  status: MarketingJobStatus;
  current_stage: MarketingStage;
  stage_order: MarketingStage[];
  stages: Record<MarketingStage, MarketingStageRecord>;
  approvals: {
    current: MarketingApprovalCheckpoint | null;
    history: MarketingApprovalHistoryEntry[];
  };
  publish_config: MarketingPublishConfig;
  inputs: {
    request: Record<string, unknown>;
    brand_url?: string | null;
    competitor_url?: string | null;
  };
  summary?: {
    headline?: string;
    subheadline?: string;
  };
  errors: MarketingStageError[];
  last_error: MarketingStageError | null;
  history: MarketingHistoryEntry[];
  created_at: string;
  updated_at: string;
};

const STAGES: MarketingStage[] = ['research', 'strategy', 'production', 'publish'];

export function nowIso(): string {
  return new Date().toISOString();
}

export function defaultPublishConfig(input: Partial<MarketingPublishConfig> = {}): MarketingPublishConfig {
  return {
    platforms: normalizePlatformList(input.platforms, ['meta-ads', 'instagram', 'x', 'tiktok', 'youtube', 'linkedin', 'reddit']),
    live_publish_platforms: normalizePlatformList(input.live_publish_platforms),
    video_render_platforms: normalizePlatformList(input.video_render_platforms),
  };
}

function normalizePlatformList(value: unknown, fallback: string[] = []): string[] {
  const items = Array.isArray(value) ? value : fallback;
  return Array.from(
    new Set(
      items
        .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        .map((entry) => entry.trim().toLowerCase())
    )
  );
}

function defaultStageRecord(stage: MarketingStage): MarketingStageRecord {
  return {
    stage,
    status: 'not_started',
    started_at: null,
    completed_at: null,
    failed_at: null,
    run_id: null,
    summary: null,
    primary_output: null,
    outputs: {},
    artifacts: [],
    errors: [],
  };
}

export function createMarketingJobRuntimeDocument(input: {
  jobId: string;
  tenantId: string;
  payload: Record<string, unknown>;
  publishConfig?: Partial<MarketingPublishConfig>;
}): MarketingJobRuntimeDocument {
  const ts = nowIso();
  return {
    schema_name: 'marketing_job_state_schema',
    schema_version: '1.0.0',
    job_id: input.jobId,
    tenant_id: input.tenantId,
    job_type: 'brand_campaign',
    state: 'queued',
    status: 'pending',
    current_stage: 'research',
    stage_order: [...STAGES],
    stages: {
      research: defaultStageRecord('research'),
      strategy: defaultStageRecord('strategy'),
      production: defaultStageRecord('production'),
      publish: defaultStageRecord('publish'),
    },
    approvals: {
      current: null,
      history: [],
    },
    publish_config: defaultPublishConfig(input.publishConfig),
    inputs: {
      request: input.payload,
      brand_url: asString(input.payload.brandUrl),
      competitor_url: asString(input.payload.competitorUrl),
    },
    errors: [],
    last_error: null,
    history: [
      {
        at: ts,
        state: 'queued',
        status: 'pending',
        stage: 'research',
        note: 'marketing job created',
      },
    ],
    created_at: ts,
    updated_at: ts,
  };
}

export function assertMarketingRuntimeSchemas(): void {
  for (const schemaPath of REQUIRED_SCHEMA_PATHS) {
    if (!existsSync(schemaPath)) {
      throw new Error(`HARD_FAILURE: missing required schema input: ${schemaPath}`);
    }

    try {
      const raw = readFileSync(schemaPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('schema root must be an object');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`HARD_FAILURE: invalid required schema input ${schemaPath}: ${message}`);
    }
  }
}

export function marketingRuntimePath(jobId: string): string {
  return resolveDataPath('generated', 'draft', 'marketing-jobs', `${jobId}.json`);
}

export function loadMarketingJobRuntime(jobId: string): MarketingJobRuntimeDocument | null {
  const filePath = marketingRuntimePath(jobId);
  if (!existsSync(filePath)) {
    return null;
  }

  const raw = readFileSync(filePath, 'utf8');
  return JSON.parse(raw) as MarketingJobRuntimeDocument;
}

export function saveMarketingJobRuntime(jobId: string, doc: MarketingJobRuntimeDocument): string {
  doc.updated_at = nowIso();
  const filePath = marketingRuntimePath(jobId);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(doc, null, 2));
  return filePath;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
}

export function getStageRecord(doc: MarketingJobRuntimeDocument, stage: MarketingStage): MarketingStageRecord {
  const existing = doc.stages?.[stage];
  if (existing) {
    return existing;
  }
  const created = defaultStageRecord(stage);
  doc.stages[stage] = created;
  return created;
}

export function appendHistory(
  doc: MarketingJobRuntimeDocument,
  note: string,
  input: { state?: string; status?: string; stage?: MarketingStage | null; at?: string } = {}
): void {
  doc.history.push({
    at: input.at ?? nowIso(),
    state: input.state ?? doc.state,
    status: input.status ?? doc.status,
    stage: input.stage ?? doc.current_stage ?? null,
    note,
  });
}

export function setJobRunning(doc: MarketingJobRuntimeDocument, stage: MarketingStage, note: string): void {
  doc.state = 'running';
  doc.status = 'running';
  doc.current_stage = stage;
  appendHistory(doc, note, { stage });
}

export function markStageInProgress(doc: MarketingJobRuntimeDocument, stage: MarketingStage): MarketingStageRecord {
  const record = getStageRecord(doc, stage);
  if (!record.started_at) {
    record.started_at = nowIso();
  }
  record.status = 'in_progress';
  doc.state = 'running';
  doc.status = 'running';
  doc.current_stage = stage;
  return record;
}

export function markStageCompleted(
  doc: MarketingJobRuntimeDocument,
  stage: MarketingStage,
  input: {
    runId?: string | null;
    summary?: MarketingStageSummary | null;
    primaryOutput?: Record<string, unknown> | null;
    outputs?: Record<string, unknown>;
    artifacts?: MarketingStageArtifact[];
  } = {}
): MarketingStageRecord {
  const record = getStageRecord(doc, stage);
  if (!record.started_at) {
    record.started_at = nowIso();
  }
  record.status = 'completed';
  record.completed_at = nowIso();
  record.failed_at = null;
  record.run_id = input.runId ?? record.run_id;
  record.summary = input.summary ?? record.summary;
  record.primary_output = input.primaryOutput ?? record.primary_output;
  record.outputs = input.outputs ?? record.outputs;
  record.artifacts = input.artifacts ?? record.artifacts;
  return record;
}

export function markStageAwaitingApproval(
  doc: MarketingJobRuntimeDocument,
  stage: Extract<MarketingStage, 'strategy' | 'production' | 'publish'>,
  checkpoint: Omit<MarketingApprovalCheckpoint, 'stage' | 'status' | 'requested_at'> & {
    requested_at?: string;
  },
  input: {
    runId?: string | null;
    summary?: MarketingStageSummary | null;
    primaryOutput?: Record<string, unknown> | null;
    outputs?: Record<string, unknown>;
    artifacts?: MarketingStageArtifact[];
  } = {}
): MarketingStageRecord {
  const record = getStageRecord(doc, stage);
  if (!record.started_at) {
    record.started_at = nowIso();
  }
  record.status = 'awaiting_approval';
  record.run_id = input.runId ?? record.run_id;
  record.summary = input.summary ?? record.summary;
  record.primary_output = input.primaryOutput ?? record.primary_output;
  record.outputs = input.outputs ?? record.outputs;
  record.artifacts = input.artifacts ?? record.artifacts;

  doc.state = 'approval_required';
  doc.status = 'awaiting_approval';
  doc.current_stage = stage;
  doc.approvals.current = {
    stage,
    status: 'awaiting_approval',
    title: checkpoint.title,
    message: checkpoint.message,
    requested_at: checkpoint.requested_at ?? nowIso(),
    action_label: checkpoint.action_label ?? null,
    publish_config: checkpoint.publish_config ?? null,
  };
  doc.approvals.history.push({
    stage,
    status: 'requested',
    at: doc.approvals.current.requested_at,
    message: checkpoint.message,
    publish_config: checkpoint.publish_config ?? null,
  });
  return record;
}

export function clearApprovalCheckpoint(doc: MarketingJobRuntimeDocument, note: string): void {
  const current = doc.approvals.current;
  if (current) {
    doc.approvals.history.push({
      stage: current.stage,
      status: 'cleared',
      at: nowIso(),
      message: current.message,
      publish_config: current.publish_config ?? null,
    });
  }
  doc.approvals.current = null;
  appendHistory(doc, note);
}

export function recordApproval(
  doc: MarketingJobRuntimeDocument,
  input: {
    stage: Extract<MarketingStage, 'strategy' | 'production' | 'publish'>;
    approvedBy: string;
    message?: string;
    publishConfig?: Partial<MarketingPublishConfig>;
  }
): void {
  if (input.stage === 'publish' && input.publishConfig) {
    doc.publish_config = defaultPublishConfig({
      ...doc.publish_config,
      ...input.publishConfig,
    });
  }
  doc.approvals.history.push({
    stage: input.stage,
    status: 'approved',
    at: nowIso(),
    approved_by: input.approvedBy,
    message: input.message ?? null,
    publish_config: input.stage === 'publish' ? doc.publish_config : null,
  });
  doc.approvals.current = null;
}

export function recordStageFailure(
  doc: MarketingJobRuntimeDocument,
  stage: MarketingStage,
  error: Omit<MarketingStageError, 'stage' | 'at'> & { at?: string }
): MarketingStageError {
  const normalized: MarketingStageError = {
    code: error.code,
    message: error.message,
    stage,
    retryable: error.retryable,
    details: error.details,
    at: error.at ?? nowIso(),
  };
  const record = getStageRecord(doc, stage);
  if (!record.started_at) {
    record.started_at = normalized.at;
  }
  record.status = 'failed';
  record.failed_at = normalized.at;
  record.errors.push(normalized);
  doc.state = 'failed';
  doc.status = 'failed';
  doc.current_stage = stage;
  doc.last_error = normalized;
  doc.errors.push(normalized);
  return normalized;
}

export function responseStageStatus(record: MarketingStageRecord): string {
  switch (record.status) {
    case 'not_started':
      return 'ready';
    case 'in_progress':
      return 'in_progress';
    case 'awaiting_approval':
      return 'awaiting_approval';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'skipped':
      return 'skipped';
    default:
      return 'ready';
  }
}
