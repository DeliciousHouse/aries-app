import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describeSpecResolution, resolveDataPath } from '@/lib/runtime-paths';
import { loadTenantBrandKit, tenantBrandKitPath, type TenantBrandKit } from './brand-kit';

const REQUIRED_SCHEMA_FILES = [
  'marketing_job_state_schema.v1.json',
] as const;
const MARKETING_RUNTIME_SCHEMA_NAME = 'marketing_job_state_schema';
const LEGACY_MARKETING_RUNTIME_SCHEMA_NAME = 'job_runtime_state_schema';
const MARKETING_RUNTIME_SCHEMA_VERSION = '1.0.0';

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

export type MarketingBrandKitReference = Omit<TenantBrandKit, 'tenant_id'> & {
  path: string;
};

export type MarketingApprovalCheckpoint = {
  stage: Extract<MarketingStage, 'strategy' | 'production' | 'publish'>;
  status: 'awaiting_approval';
  approval_id?: string | null;
  workflow_name?: string | null;
  workflow_step_id?: string | null;
  title: string;
  message: string;
  requested_at: string;
  resume_token?: string | null;
  action_label?: string | null;
  publish_config?: MarketingPublishConfig | null;
};

export type MarketingApprovalHistoryEntry = {
  stage: Extract<MarketingStage, 'strategy' | 'production' | 'publish'>;
  status: 'requested' | 'approved' | 'denied' | 'cleared';
  at: string;
  approval_id?: string | null;
  workflow_step_id?: string | null;
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
  schema_name: typeof MARKETING_RUNTIME_SCHEMA_NAME;
  schema_version: typeof MARKETING_RUNTIME_SCHEMA_VERSION;
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
  brand_kit: MarketingBrandKitReference | null;
  inputs: {
    request: Record<string, unknown>;
    brand_url: string;
    competitor_url?: string | null;
    competitor_facebook_url?: string | null;
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
    platforms: normalizePlatformList(input.platforms, ['meta-ads', 'tiktok']),
    live_publish_platforms: normalizePlatformList(input.live_publish_platforms, ['meta-ads']),
    video_render_platforms: normalizePlatformList(input.video_render_platforms, ['tiktok']),
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
  brandKit: MarketingBrandKitReference;
  publishConfig?: Partial<MarketingPublishConfig>;
}): MarketingJobRuntimeDocument {
  const ts = nowIso();
  return {
    schema_name: MARKETING_RUNTIME_SCHEMA_NAME,
    schema_version: MARKETING_RUNTIME_SCHEMA_VERSION,
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
    brand_kit: input.brandKit,
    inputs: {
      request: input.payload,
      brand_url: asString(input.payload.brandUrl) || '',
      competitor_url: asString(input.payload.competitorUrl) || asString(input.payload.brandUrl),
      competitor_facebook_url: asString(input.payload.competitorFacebookUrl),
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
  for (const fileName of REQUIRED_SCHEMA_FILES) {
    const resolution = describeSpecResolution(fileName);
    console.info('[marketing-runtime-schema]', {
      event: 'resolve',
      requestedCodeRoot: resolution.requestedCodeRoot,
      resolvedCodeRoot: resolution.resolvedCodeRoot,
      resolvedSpecPath: resolution.resolvedSpecPath,
      cwd: process.cwd(),
      triedSpecPaths: resolution.triedSpecPaths,
    });

    const schemaPath = resolution.resolvedSpecPath;
    if (!existsSync(schemaPath)) {
      throw new Error(
        `marketing_runtime_schema_resolution_failed: requestedCodeRoot=${resolution.requestedCodeRoot || 'unset'} cwd=${process.cwd()} resolvedCodeRoot=${resolution.resolvedCodeRoot} triedSpecPaths=${resolution.triedSpecPaths.join(', ')}`,
      );
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

function marketingRuntimeRoot(): string {
  return resolveDataPath('generated', 'draft', 'marketing-jobs');
}

function runtimeBrandKitReferenceFromTenantBrandKit(
  tenantId: string,
  brandKit: TenantBrandKit,
): MarketingBrandKitReference {
  return {
    path: tenantBrandKitPath(tenantId),
    source_url: brandKit.source_url,
    canonical_url: brandKit.canonical_url,
    brand_name: brandKit.brand_name,
    logo_urls: [...brandKit.logo_urls],
    colors: {
      primary: brandKit.colors.primary,
      secondary: brandKit.colors.secondary,
      accent: brandKit.colors.accent,
      palette: [...brandKit.colors.palette],
    },
    font_families: [...brandKit.font_families],
    external_links: [...brandKit.external_links],
    extracted_at: brandKit.extracted_at,
    brand_voice_summary: brandKit.brand_voice_summary ?? null,
    offer_summary: brandKit.offer_summary ?? null,
  };
}

function recoverLegacyRuntimeBrandKit(doc: MarketingJobRuntimeDocument): MarketingBrandKitReference | null {
  try {
    const persistedBrandKit = loadTenantBrandKit(doc.tenant_id);
    if (!persistedBrandKit) {
      console.warn('[marketing-runtime-state]', {
        event: 'legacy-runtime-brand-kit-missing',
        jobId: doc.job_id,
        tenantId: doc.tenant_id,
        recovered: false,
        source: 'none',
      });
      return null;
    }

    const recoveredBrandKit = runtimeBrandKitReferenceFromTenantBrandKit(doc.tenant_id, persistedBrandKit);
    console.warn('[marketing-runtime-state]', {
      event: 'legacy-runtime-brand-kit-missing',
      jobId: doc.job_id,
      tenantId: doc.tenant_id,
      recovered: true,
      source: 'validated_brand_kit_file',
      brandKitPath: recoveredBrandKit.path,
    });
    return recoveredBrandKit;
  } catch (error) {
    console.warn('[marketing-runtime-state]', {
      event: 'legacy-runtime-brand-kit-missing',
      jobId: doc.job_id,
      tenantId: doc.tenant_id,
      recovered: false,
      source: 'none',
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function assertMarketingRuntimeDocument(doc: MarketingJobRuntimeDocument): void {
  if (!doc.brand_kit) {
    throw new Error('invalid_marketing_runtime_document:brand_kit_required');
  }
  if (!doc.inputs?.brand_url || doc.inputs.brand_url.trim().length === 0) {
    throw new Error('invalid_marketing_runtime_document:brand_url_required');
  }
  if (doc.brand_kit.source_url !== doc.inputs.brand_url) {
    throw new Error('invalid_marketing_runtime_document:brand_kit_source_mismatch');
  }
  if (!Number.isFinite(Date.parse(doc.brand_kit.extracted_at))) {
    throw new Error('invalid_marketing_runtime_document:brand_kit_extracted_at_invalid');
  }
}

export function loadMarketingJobRuntime(jobId: string): MarketingJobRuntimeDocument | null {
  const filePath = marketingRuntimePath(jobId);
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const schemaName = parsed.schema_name;
    const isKnownSchema =
      schemaName === MARKETING_RUNTIME_SCHEMA_NAME || schemaName === LEGACY_MARKETING_RUNTIME_SCHEMA_NAME;
    if (!isKnownSchema) {
      return null;
    }
    if (typeof parsed.job_id !== 'string' || parsed.job_id.length === 0) {
      return null;
    }
    if (typeof parsed.tenant_id !== 'string' || parsed.tenant_id.length === 0) {
      return null;
    }

    const doc = parsed as MarketingJobRuntimeDocument;
    if (!doc.stage_order || !Array.isArray(doc.stage_order) || doc.stage_order.length === 0) {
      doc.stage_order = [...STAGES];
    }
    if (!doc.current_stage || !STAGES.includes(doc.current_stage)) {
      doc.current_stage = 'research';
    }
    if (!doc.stages || typeof doc.stages !== 'object' || Array.isArray(doc.stages)) {
      return null;
    }
    if (
      !doc.stages.research &&
      !doc.stages.strategy &&
      !doc.stages.production &&
      !doc.stages.publish
    ) {
      return null;
    }
    for (const stage of STAGES) {
      if (!doc.stages[stage]) {
        doc.stages[stage] = defaultStageRecord(stage);
      }
    }
    if (!doc.publish_config || typeof doc.publish_config !== 'object' || Array.isArray(doc.publish_config)) {
      doc.publish_config = defaultPublishConfig();
    } else {
      doc.publish_config = defaultPublishConfig(doc.publish_config);
    }
    if (!doc.brand_kit) {
      doc.brand_kit = recoverLegacyRuntimeBrandKit(doc);
    }
    return doc;
  } catch {
    return null;
  }
}

function collectMarketingJobRefsForTenant(tenantId: string): Array<{ jobId: string; updatedAt: number }> {
  const root = marketingRuntimeRoot();
  if (!existsSync(root)) {
    return [];
  }

  const refs: Array<{ jobId: string; updatedAt: number }> = [];
  const entries = readdirSync(root).filter((entry) => entry.endsWith('.json'));

  for (const entry of entries) {
    try {
      const raw = readFileSync(path.join(root, entry), 'utf8');
      const doc = JSON.parse(raw) as Record<string, unknown>;
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        continue;
      }
      const schemaName = doc.schema_name;
      const isKnownSchema =
        schemaName === MARKETING_RUNTIME_SCHEMA_NAME || schemaName === LEGACY_MARKETING_RUNTIME_SCHEMA_NAME;
      if (!isKnownSchema) {
        continue;
      }
      const stages = doc.stages as Record<string, unknown> | undefined;
      if (!stages || typeof stages !== 'object' || Array.isArray(stages)) {
        continue;
      }
      const hasAtLeastOneStage =
        'research' in stages || 'strategy' in stages || 'production' in stages || 'publish' in stages;
      if (!hasAtLeastOneStage) {
        continue;
      }
      if (typeof doc.job_id !== 'string' || doc.job_id.length === 0) {
        continue;
      }
      if (typeof doc.tenant_id !== 'string' || doc.tenant_id.length === 0) {
        continue;
      }
      if (doc.tenant_id !== tenantId) {
        continue;
      }
      const updatedAt = Date.parse(typeof doc.updated_at === 'string' ? doc.updated_at : '');
      if (!Number.isFinite(updatedAt)) {
        continue;
      }
      refs.push({ jobId: doc.job_id, updatedAt });
    } catch {
      continue;
    }
  }

  return refs.sort((left, right) => right.updatedAt - left.updatedAt);
}

export function listMarketingJobIdsForTenant(tenantId: string): string[] {
  return collectMarketingJobRefsForTenant(tenantId).map((entry) => entry.jobId);
}

export function listMarketingTenantIds(): string[] {
  const root = marketingRuntimeRoot();
  if (!existsSync(root)) {
    return [];
  }

  const entries = readdirSync(root).filter((entry) => entry.endsWith('.json'));
  const tenants = new Set<string>();

  for (const entry of entries) {
    try {
      const raw = readFileSync(path.join(root, entry), 'utf8');
      const doc = JSON.parse(raw) as Record<string, unknown>;
      const tenantId = typeof doc.tenant_id === 'string' ? doc.tenant_id.trim() : '';
      if (tenantId) {
        tenants.add(tenantId);
      }
    } catch {
      continue;
    }
  }

  return [...tenants];
}

export function findLatestMarketingTenantId(): string | null {
  const root = marketingRuntimeRoot();
  if (!existsSync(root)) {
    return null;
  }

  const entries = readdirSync(root).filter((entry) => entry.endsWith('.json'));
  let latest: { tenantId: string; updatedAt: number } | null = null;

  for (const entry of entries) {
    try {
      const raw = readFileSync(path.join(root, entry), 'utf8');
      const doc = JSON.parse(raw) as Record<string, unknown>;
      const tenantId = typeof doc.tenant_id === 'string' ? doc.tenant_id.trim() : '';
      const updatedAt = Date.parse(typeof doc.updated_at === 'string' ? doc.updated_at : '');
      if (!tenantId || !Number.isFinite(updatedAt)) {
        continue;
      }
      if (!latest || updatedAt > latest.updatedAt) {
        latest = { tenantId, updatedAt };
      }
    } catch {
      continue;
    }
  }

  return latest?.tenantId ?? null;
}

export function findLatestMarketingJobIdForTenant(tenantId: string): string | null {
  return collectMarketingJobRefsForTenant(tenantId)[0]?.jobId ?? null;
}

export function saveMarketingJobRuntime(jobId: string, doc: MarketingJobRuntimeDocument): string {
  assertMarketingRuntimeDocument(doc);
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
    approval_id: checkpoint.approval_id ?? null,
    workflow_name: checkpoint.workflow_name ?? null,
    workflow_step_id: checkpoint.workflow_step_id ?? null,
    title: checkpoint.title,
    message: checkpoint.message,
    requested_at: checkpoint.requested_at ?? nowIso(),
    resume_token: checkpoint.resume_token ?? null,
    action_label: checkpoint.action_label ?? null,
    publish_config: checkpoint.publish_config ?? null,
  };
  doc.approvals.history.push({
    stage,
    status: 'requested',
    at: doc.approvals.current.requested_at,
    approval_id: doc.approvals.current.approval_id ?? null,
    workflow_step_id: doc.approvals.current.workflow_step_id ?? null,
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
      approval_id: current.approval_id ?? null,
      workflow_step_id: current.workflow_step_id ?? null,
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
    approvalId?: string | null;
    workflowStepId?: string | null;
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
    approval_id: input.approvalId ?? doc.approvals.current?.approval_id ?? null,
    workflow_step_id: input.workflowStepId ?? doc.approvals.current?.workflow_step_id ?? null,
    approved_by: input.approvedBy,
    message: input.message ?? null,
    publish_config: input.stage === 'publish' ? doc.publish_config : null,
  });
}

export function recordApprovalDenied(
  doc: MarketingJobRuntimeDocument,
  input: {
    stage: Extract<MarketingStage, 'strategy' | 'production' | 'publish'>;
    deniedBy: string;
    message?: string;
    publishConfig?: Partial<MarketingPublishConfig>;
    approvalId?: string | null;
    workflowStepId?: string | null;
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
    status: 'denied',
    at: nowIso(),
    approval_id: input.approvalId ?? doc.approvals.current?.approval_id ?? null,
    workflow_step_id: input.workflowStepId ?? doc.approvals.current?.workflow_step_id ?? null,
    approved_by: input.deniedBy,
    message: input.message ?? null,
    publish_config: input.stage === 'publish' ? doc.publish_config : null,
  });
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
