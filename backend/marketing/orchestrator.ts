import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { resolveCodePath, resolveCodeRoot } from '@/lib/runtime-paths';
import {
  OpenClawGatewayError,
  describeLobsterResumeToken,
  isOpenClawLobsterResumeStateMissing,
  resolveOpenClawLobsterRuntimeContext,
  resumeOpenClawLobsterWorkflow,
  runOpenClawLobsterWorkflow,
  type LobsterEnvelope,
} from '../openclaw/gateway-client';
import {
  MarketingApprovalLockError,
  createMarketingApprovalRecord,
  findLatestMarketingApprovalRecord,
  loadMarketingApprovalRecord,
  saveMarketingApprovalRecord,
  withMarketingApprovalLock,
  type MarketingApprovalRecord,
  type MarketingApprovalResolution,
} from './approval-store';
import {
  appendHistory,
  assertMarketingRuntimeSchemas,
  clearApprovalCheckpoint,
  createMarketingJobRuntimeDocument,
  defaultPublishConfig,
  getStageRecord,
  markStageAwaitingApproval,
  markStageCompleted,
  markStageInProgress,
  nowIso,
  recordApproval,
  recordApprovalDenied,
  recordStageFailure,
  saveMarketingJobRuntime,
  setJobRunning,
  type MarketingApprovalCheckpoint,
  type MarketingJobRuntimeDocument,
  type MarketingPublishConfig,
  type MarketingStageArtifact,
  type MarketingStageRecord,
  type MarketingStage,
} from './runtime-state';
import {
  extractAndSaveTenantBrandKit,
  loadTenantBrandKit,
  tenantBrandKitPath,
  type TenantBrandKit,
} from './brand-kit';

export type StartMarketingJobRequest = {
  tenantId: string;
  jobType: 'brand_campaign';
  payload: {
    brandUrl?: unknown;
    competitorUrl?: unknown;
    competitorFacebookUrl?: unknown;
    [key: string]: unknown;
  };
};

export type StartMarketingJobResponse = {
  status: 'accepted';
  jobId: string;
  tenantId: string;
  jobType: 'brand_campaign';
  runtimeArtifactPath: string;
  approvalRequired: boolean;
  currentStage: MarketingStage;
  approval: MarketingApprovalCheckpoint | null;
};

export type ApproveMarketingJobRequest = {
  jobId: string;
  tenantId: string;
  approvedBy: string;
  approvedStages?: Array<'research' | 'strategy' | 'production' | 'publish'>;
  approvalId?: string;
  resumePublishIfNeeded?: boolean;
  publishConfig?: Partial<MarketingPublishConfig>;
};

export type ApproveMarketingJobResponse = {
  status: 'resumed' | 'already_resolved' | 'denied' | 'error';
  jobId: string;
  tenantId: string;
  resumedStage: MarketingStage | null;
  completed: boolean;
  approvalId?: string | null;
  reason?: string;
};

export type DenyMarketingJobRequest = {
  jobId: string;
  tenantId: string;
  deniedBy: string;
  approvalId?: string;
  note?: string;
  publishConfig?: Partial<MarketingPublishConfig>;
};

type WorkflowApprovalStepId =
  | 'approve_stage_2'
  | 'approve_stage_3'
  | 'approve_stage_4'
  | 'approve_stage_4_publish';

function runtimeBrandKitReference(
  brandKit: TenantBrandKit,
  filePath: string
): MarketingJobRuntimeDocument['brand_kit'] {
  return {
    path: filePath,
    source_url: brandKit.source_url,
    canonical_url: brandKit.canonical_url,
    brand_name: brandKit.brand_name,
    logo_urls: brandKit.logo_urls,
    colors: brandKit.colors,
    font_families: brandKit.font_families,
    external_links: brandKit.external_links,
    extracted_at: brandKit.extracted_at,
  };
}

async function ensureRuntimeBrandKit(doc: MarketingJobRuntimeDocument): Promise<void> {
  if (doc.brand_kit) {
    return;
  }

  const brandUrl = doc.inputs.brand_url?.trim();
  if (!brandUrl) {
    return;
  }

  const existingBrandKit = loadTenantBrandKit(doc.tenant_id);
  if (existingBrandKit && existingBrandKit.source_url === brandUrl) {
    doc.brand_kit = runtimeBrandKitReference(existingBrandKit, tenantBrandKitPath(doc.tenant_id));
    return;
  }

  const { brandKit, filePath } = await extractAndSaveTenantBrandKit({
    tenantId: doc.tenant_id,
    brandUrl,
  });
  doc.brand_kit = runtimeBrandKitReference(brandKit, filePath);
}

function runtimeArtifactPath(jobId: string): string {
  return `generated/draft/marketing-jobs/${jobId}.json`;
}

function makeMarketingJobId(): string {
  return `mkt_${randomUUID()}`;
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function ensureBrandCampaignInput(input: StartMarketingJobRequest): { brandUrl: string; competitorUrl: string } {
  const brandUrl = stringValue(input.payload?.brandUrl);
  const competitorUrl = stringValue(input.payload?.competitorUrl);
  const missing: string[] = [];
  if (!brandUrl) missing.push('payload.brandUrl');
  if (!competitorUrl) missing.push('payload.competitorUrl');
  if (missing.length > 0) {
    throw new Error(`missing_required_fields:${missing.join(',')}`);
  }
  return { brandUrl, competitorUrl };
}

const MARKETING_PIPELINE_FILE = 'marketing-pipeline.lobster';
const MARKETING_WORKFLOW_NAME = 'marketing-pipeline';
const DEFAULT_MARKETING_WORKFLOW_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_MARKETING_WORKFLOW_MAX_STDOUT_BYTES = 8 * 1024 * 1024;

function positiveIntegerEnv(key: string, fallback: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function marketingPipelineCwd(): string {
  const explicit = process.env.OPENCLAW_LOBSTER_CWD?.trim();
  if (explicit) {
    return explicit;
  }
  return resolveCodeRoot() === '/app' ? 'aries-app/lobster' : resolveCodePath('lobster');
}

function marketingPipelineArgs(doc: MarketingJobRuntimeDocument): Record<string, unknown> {
  return {
    brand_url: doc.inputs.brand_url ?? '',
    competitor: doc.inputs.competitor_url ?? '',
    competitor_facebook_url: doc.inputs.competitor_facebook_url ?? '',
    brand_slug: doc.tenant_id,
    agent_id: process.env.OPENCLAW_SESSION_KEY?.trim() || 'main',
  };
}

function marketingPipelinePath(): string {
  return path.join(marketingPipelineCwd(), MARKETING_PIPELINE_FILE);
}

function marketingWorkflowTimeoutMs(): number {
  return positiveIntegerEnv(
    'OPENCLAW_MARKETING_WORKFLOW_TIMEOUT_MS',
    DEFAULT_MARKETING_WORKFLOW_TIMEOUT_MS,
  );
}

function marketingWorkflowMaxStdoutBytes(): number {
  return positiveIntegerEnv(
    'OPENCLAW_MARKETING_WORKFLOW_MAX_STDOUT_BYTES',
    DEFAULT_MARKETING_WORKFLOW_MAX_STDOUT_BYTES,
  );
}

function marketingWorkflowRuntimeContext() {
  const runtime = resolveOpenClawLobsterRuntimeContext({ cwd: marketingPipelineCwd() });
  return {
    workflowName: MARKETING_WORKFLOW_NAME,
    pipelinePath: marketingPipelinePath(),
    runtime,
  };
}

function approvalLifecycleLog(
  event:
    | 'workflow-run'
    | 'approval-created'
    | 'approval-read'
    | 'approval-resume-requested'
    | 'approval-resume-succeeded'
    | 'approval-resume-failed',
  input: Record<string, unknown>,
): void {
  console.info('[marketing-approval]', {
    event,
    ...input,
  });
}

function primaryOutputRecord(envelope: LobsterEnvelope): Record<string, unknown> {
  const first = Array.isArray(envelope.output) ? envelope.output[0] : null;
  return first && typeof first === 'object' && !Array.isArray(first)
    ? (first as Record<string, unknown>)
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
}

function runIdFromPrimaryOutput(primaryOutput: Record<string, unknown>): string | null {
  return stringValue(primaryOutput.run_id) || null;
}

function approvalPrompt(envelope: LobsterEnvelope, fallback: string): string {
  return stringValue(envelope.requiresApproval?.prompt) || fallback;
}

function summarizeResearch(primaryOutput: Record<string, unknown>) {
  const executiveSummary = (primaryOutput.executive_summary as Record<string, unknown> | undefined) ?? {};
  return {
    summary:
      stringValue(executiveSummary.market_positioning) ||
      'Competitive research completed and the strongest marketing angle was captured.',
    highlight: stringValue(executiveSummary.campaign_takeaway) || null,
  };
}

function summarizeStrategy(primaryOutput: Record<string, unknown>) {
  const strategyHandoff = (primaryOutput.strategy_handoff as Record<string, unknown> | undefined) ?? primaryOutput;
  return {
    summary:
      stringValue(strategyHandoff.core_message) ||
      'Strategy handoff is approved and ready for production.',
    highlight: stringValue(strategyHandoff.primary_cta) || null,
    handoff: strategyHandoff,
  };
}

function summarizeProduction(primaryOutput: Record<string, unknown>) {
  const productionHandoff =
    (primaryOutput.production_handoff as Record<string, unknown> | undefined) ?? primaryOutput;
  const productionBrief =
    (productionHandoff.production_brief as Record<string, unknown> | undefined) ?? {};
  const contractHandoffs =
    (productionHandoff.contract_handoffs as Record<string, unknown> | undefined) ?? {};
  const staticHandoff = (contractHandoffs.static as Record<string, unknown> | undefined) ?? {};
  const videoHandoff = (contractHandoffs.video as Record<string, unknown> | undefined) ?? {};
  return {
    summary:
      stringValue(productionBrief.core_message) ||
      'Production handoff is approved and ready for publish review.',
    highlight: `Static contracts: ${stringArray(staticHandoff.platform_contract_paths).length}, Video contracts: ${stringArray(videoHandoff.platform_contract_paths).length}`,
    handoff: productionHandoff,
  };
}

function summarizePublish(primaryOutput: Record<string, unknown>) {
  const summary = (primaryOutput.summary as Record<string, unknown> | undefined) ?? {};
  return {
    summary:
      stringValue(summary.message) ||
      'Publish-ready assets were generated successfully.',
    highlight: null,
  };
}

async function runMarketingPipeline(doc: MarketingJobRuntimeDocument): Promise<LobsterEnvelope> {
  return runOpenClawLobsterWorkflow({
    pipeline: MARKETING_PIPELINE_FILE,
    cwd: marketingPipelineCwd(),
    argsJson: JSON.stringify(marketingPipelineArgs(doc)),
    timeoutMs: marketingWorkflowTimeoutMs(),
    maxStdoutBytes: marketingWorkflowMaxStdoutBytes(),
  });
}

async function resumeMarketingPipeline(resumeToken: string, approve = true): Promise<LobsterEnvelope> {
  return resumeOpenClawLobsterWorkflow({
    token: resumeToken,
    approve,
    cwd: marketingPipelineCwd(),
    timeoutMs: marketingWorkflowTimeoutMs(),
    maxStdoutBytes: marketingWorkflowMaxStdoutBytes(),
  });
}

function stageApprovalMessage(
  stage: Extract<MarketingStage, 'strategy' | 'production' | 'publish'>,
  fallback: string
): { title: string; message: string } {
  if (stage === 'strategy') {
    return {
      title: 'Strategy approval required',
      message: fallback || 'Stage 2 strategy outputs are ready for approval before production can begin.',
    };
  }
  if (stage === 'production') {
    return {
      title: 'Production approval required',
      message: fallback || 'Stage 3 production outputs are ready for approval before publishing can begin.',
    };
  }
  return {
    title: 'Launch approval required',
    message: fallback || 'Stage 4 launch review is waiting on approval before publish-ready assets are generated.',
  };
}

function publishPausedApprovalMessage(fallback: string): { title: string; message: string } {
  return {
    title: 'Publish to Meta (paused) approval required',
    message: fallback || 'Stage 4 pre-flight is complete. Approve creation of Meta campaigns, ad sets, and ads as paused.',
  };
}

function checkpointSummary(
  title: string,
  message: string,
  highlight: string | null | undefined,
): MarketingStageRecord['summary'] {
  return {
    summary: message,
    highlight: highlight ?? null,
  };
}

function approvalRecordPreviewPayload(envelope: LobsterEnvelope): unknown {
  const previewItems = Array.isArray(envelope.requiresApproval?.items) ? envelope.requiresApproval?.items : [];
  if (previewItems && previewItems.length > 0) {
    return previewItems;
  }
  const primaryOutput = primaryOutputRecord(envelope);
  return Object.keys(primaryOutput).length > 0 ? primaryOutput : null;
}

function createAndPersistApprovalCheckpoint(
  doc: MarketingJobRuntimeDocument,
  input: {
    stage: Extract<MarketingStage, 'strategy' | 'production' | 'publish'>;
    workflowStepId: WorkflowApprovalStepId;
    title: string;
    message: string;
    actionLabel: string;
    resumeToken: string;
    envelope: LobsterEnvelope;
    runId: string | null;
    highlight?: string | null;
    primaryOutput?: Record<string, unknown> | null;
    outputs?: Record<string, unknown>;
    artifacts?: MarketingStageArtifact[];
    publishConfig?: MarketingPublishConfig | null;
  },
): MarketingApprovalRecord {
  const { workflowName, pipelinePath, runtime } = marketingWorkflowRuntimeContext();
  const descriptor = describeLobsterResumeToken(input.resumeToken);
  const approvalRecord = createMarketingApprovalRecord({
    tenantId: doc.tenant_id,
    marketingJobId: doc.job_id,
    workflowName,
    workflowStepId: input.workflowStepId,
    marketingStage: input.stage,
    lobsterResumeToken: input.resumeToken,
    lobsterResumeStateKeys: descriptor.stateKeys,
    approvalPrompt: input.message,
    approvalPreviewPayload: approvalRecordPreviewPayload(input.envelope),
    runtimeContext: {
      pipelinePath,
      cwd: runtime.cwd,
      stateDir: runtime.stateDir,
      sessionKey: runtime.sessionKey,
      gatewayUrl: runtime.gatewayUrl,
    },
    publishConfig: input.publishConfig ?? null,
  });
  saveMarketingApprovalRecord(approvalRecord);
  approvalLifecycleLog('approval-created', {
    jobId: doc.job_id,
    tenantId: doc.tenant_id,
    stage: input.stage,
    workflowStepId: input.workflowStepId,
    approvalId: approvalRecord.approval_id,
    correlationId: approvalRecord.correlation_id,
    traceId: approvalRecord.trace_id,
    tokenFingerprint: approvalRecord.lobster_resume_token_fingerprint,
    tokenStateKeys: approvalRecord.lobster_resume_state_keys,
    sessionKey: approvalRecord.runtime_context.session_key,
    cwd: approvalRecord.runtime_context.cwd,
    stateDir: approvalRecord.runtime_context.state_dir,
    pipelinePath: approvalRecord.runtime_context.pipeline_path,
  });

  markStageAwaitingApproval(
    doc,
    input.stage,
    {
      approval_id: approvalRecord.approval_id,
      workflow_name: approvalRecord.workflow_name,
      workflow_step_id: approvalRecord.workflow_step_id,
      title: input.title,
      message: input.message,
      action_label: input.actionLabel,
      publish_config: input.publishConfig ?? null,
      resume_token: input.resumeToken,
    },
    {
      runId: input.runId,
      summary: checkpointSummary(input.title, input.message, input.highlight),
      primaryOutput: input.primaryOutput ?? null,
      outputs: {
        ...(input.outputs ?? {}),
        resume_token: input.resumeToken,
        approval_id: approvalRecord.approval_id,
        workflow_step_id: input.workflowStepId,
      },
      artifacts: input.artifacts ?? [],
    },
  );

  return approvalRecord;
}

async function replayMarketingPipelineToApprovalCheckpoint(
  doc: MarketingJobRuntimeDocument,
  workflowStepId: WorkflowApprovalStepId,
): Promise<string> {
  let envelope = await runMarketingPipeline(doc);
  let resumeToken = envelope.requiresApproval?.resumeToken?.trim() || '';
  if (!resumeToken) {
    throw new Error(`marketing_pipeline_missing_resume_token:${workflowStepId}`);
  }

  if (workflowStepId === 'approve_stage_2') {
    return resumeToken;
  }

  envelope = await resumeMarketingPipeline(resumeToken, true);
  resumeToken = envelope.requiresApproval?.resumeToken?.trim() || '';
  if (!resumeToken) {
    throw new Error(`marketing_pipeline_missing_resume_token:${workflowStepId}`);
  }

  if (workflowStepId === 'approve_stage_3') {
    return resumeToken;
  }

  envelope = await resumeMarketingPipeline(resumeToken, true);
  resumeToken = envelope.requiresApproval?.resumeToken?.trim() || '';
  if (!resumeToken) {
    throw new Error(`marketing_pipeline_missing_resume_token:${workflowStepId}`);
  }

  if (workflowStepId === 'approve_stage_4') {
    return resumeToken;
  }

  envelope = await resumeMarketingPipeline(resumeToken, true);
  resumeToken = envelope.requiresApproval?.resumeToken?.trim() || '';
  if (!resumeToken) {
    throw new Error(`marketing_pipeline_missing_resume_token:${workflowStepId}`);
  }

  return resumeToken;
}

async function reseedMarketingApprovalResumeToken(
  doc: MarketingJobRuntimeDocument,
  checkpoint: MarketingApprovalCheckpoint,
  record: MarketingApprovalRecord,
): Promise<string> {
  const workflowStepId = inferredWorkflowStepId(checkpoint);
  approvalLifecycleLog('approval-resume-requested', {
    jobId: doc.job_id,
    tenantId: doc.tenant_id,
    stage: checkpoint.stage,
    workflowStepId,
    approvalId: record.approval_id,
    resolution: 'reseed',
    attemptCount: record.attempt_count,
    correlationId: record.correlation_id,
    traceId: record.trace_id,
    tokenFingerprint: record.lobster_resume_token_fingerprint,
    tokenStateKeys: record.lobster_resume_state_keys,
    reason: 'workflow_resume_state_missing',
  });

  const freshResumeToken = await replayMarketingPipelineToApprovalCheckpoint(doc, workflowStepId);
  const descriptor = describeLobsterResumeToken(freshResumeToken);
  record.lobster_resume_token = freshResumeToken;
  record.lobster_resume_token_fingerprint = descriptor.fingerprint;
  record.lobster_resume_state_keys = descriptor.stateKeys;
  record.status = 'pending';
  record.resolution = null;
  record.resolved_at = null;
  record.resolution_result = null;
  record.last_error = null;
  saveMarketingApprovalRecord(record);

  checkpoint.resume_token = freshResumeToken;
  checkpoint.workflow_name = record.workflow_name;
  checkpoint.workflow_step_id = workflowStepId;
  checkpoint.approval_id = record.approval_id;

  const stageRecord = getStageRecord(doc, checkpoint.stage);
  stageRecord.outputs = {
    ...stageRecord.outputs,
    resume_token: freshResumeToken,
    approval_id: record.approval_id,
    workflow_step_id: workflowStepId,
  };

  saveMarketingJobRuntime(doc.job_id, doc);

  approvalLifecycleLog('approval-read', {
    jobId: doc.job_id,
    tenantId: doc.tenant_id,
    stage: checkpoint.stage,
    workflowStepId,
    approvalId: record.approval_id,
    status: record.status,
    attemptCount: record.attempt_count,
    tokenFingerprint: record.lobster_resume_token_fingerprint,
    tokenStateKeys: record.lobster_resume_state_keys,
    reseeded: true,
  });

  return freshResumeToken;
}

function replacePublishApprovalArtifacts(
  artifacts: MarketingStageArtifact[] | undefined,
  replacement?: MarketingStageArtifact,
): MarketingStageArtifact[] {
  const nextArtifacts = Array.isArray(artifacts)
    ? artifacts.filter((artifact) => artifact.category !== 'approval')
    : [];

  if (replacement) {
    nextArtifacts.push(replacement);
  }

  return nextArtifacts;
}

function activeApprovalRecord(
  doc: MarketingJobRuntimeDocument,
  input: { approvalId?: string | null } = {},
): MarketingApprovalRecord | null {
  const checkpoint = doc.approvals.current;
  const approvalId = input.approvalId?.trim() || checkpoint?.approval_id?.trim() || '';
  const record = findLatestMarketingApprovalRecord({
    marketingJobId: doc.job_id,
    tenantId: doc.tenant_id,
    approvalId: approvalId || undefined,
    workflowStepId: checkpoint?.workflow_step_id ?? null,
    marketingStage: checkpoint?.stage ?? null,
    statuses: ['pending', 'failed', 'approved', 'denied', 'consumed'],
  });

  if (record) {
    approvalLifecycleLog('approval-read', {
      jobId: doc.job_id,
      tenantId: doc.tenant_id,
      stage: record.marketing_stage,
      workflowStepId: record.workflow_step_id,
      approvalId: record.approval_id,
      status: record.status,
      attemptCount: record.attempt_count,
      tokenFingerprint: record.lobster_resume_token_fingerprint,
      tokenStateKeys: record.lobster_resume_state_keys,
    });
  }

  return record;
}


async function runResearchStage(doc: MarketingJobRuntimeDocument): Promise<void> {
  setJobRunning(doc, 'research', 'running research stage');
  markStageInProgress(doc, 'research');
  saveMarketingJobRuntime(doc.job_id, doc);

  const { runtime, pipelinePath } = marketingWorkflowRuntimeContext();
  approvalLifecycleLog('workflow-run', {
    jobId: doc.job_id,
    tenantId: doc.tenant_id,
    stage: 'research',
    workflowName: MARKETING_WORKFLOW_NAME,
    pipelinePath,
    sessionKey: runtime.sessionKey,
    cwd: runtime.cwd,
    stateDir: runtime.stateDir,
    timeoutMs: marketingWorkflowTimeoutMs(),
    maxStdoutBytes: marketingWorkflowMaxStdoutBytes(),
  });

  const envelope = await runMarketingPipeline(doc);
  const primaryOutput = primaryOutputRecord(envelope);
  const summary = summarizeResearch(primaryOutput);
  const runId = runIdFromPrimaryOutput(primaryOutput);
  markStageCompleted(doc, 'research', {
    runId,
    summary,
    primaryOutput,
    outputs: {
      envelope,
    },
    artifacts: [
      {
        id: 'research-summary',
        stage: 'research',
        title: 'Competitor research summary',
        category: 'analysis',
        status: 'completed',
        summary: summary.summary,
        details: [
          `Competitor URL: ${doc.inputs.competitor_url ?? 'n/a'}`,
          `Brand URL: ${doc.inputs.brand_url ?? 'n/a'}`,
        ],
      },
    ],
  });
  appendHistory(doc, 'research stage completed', { stage: 'research' });
  saveMarketingJobRuntime(doc.job_id, doc);

  if (!envelope.requiresApproval?.resumeToken) {
    throw new Error('marketing_pipeline_missing_resume_token:strategy');
  }

  const approval = stageApprovalMessage(
    'strategy',
    approvalPrompt(envelope, 'Research is complete. Approve the strategy step to continue.')
  );
  createAndPersistApprovalCheckpoint(doc, {
    stage: 'strategy',
    workflowStepId: 'approve_stage_2',
    title: approval.title,
    message: approval.message,
    actionLabel: 'Review strategy',
    resumeToken: envelope.requiresApproval.resumeToken,
    envelope,
    runId,
    highlight: summary.highlight,
    primaryOutput,
    artifacts: [
      {
        id: 'strategy-review',
        stage: 'strategy',
        title: 'Strategy approval checkpoint',
        category: 'approval',
        status: 'awaiting_approval',
        summary: approval.message,
        details: [],
      },
    ],
  });
  appendHistory(doc, 'strategy stage is awaiting approval', { stage: 'strategy' });
  saveMarketingJobRuntime(doc.job_id, doc);
}

async function finalizeStrategyAndRunProductionReview(
  doc: MarketingJobRuntimeDocument,
  resumeToken: string
): Promise<void> {
  if (!resumeToken) {
    throw new Error('missing_strategy_resume_token');
  }

  const envelope = await resumeMarketingPipeline(resumeToken);
  const primaryOutput = primaryOutputRecord(envelope);
  const strategy = summarizeStrategy(primaryOutput);
  markStageCompleted(doc, 'strategy', {
    runId: runIdFromPrimaryOutput(primaryOutput) ?? getStageRecord(doc, 'research').run_id,
    summary: {
      summary: strategy.summary,
      highlight: strategy.highlight,
    },
    primaryOutput,
    outputs: {
      strategy_handoff: strategy.handoff,
    },
    artifacts: [],
  });
  appendHistory(doc, 'strategy stage approved and finalized', { stage: 'strategy' });
  saveMarketingJobRuntime(doc.job_id, doc);

  if (!envelope.requiresApproval?.resumeToken) {
    throw new Error('marketing_pipeline_missing_resume_token:production');
  }

  const approval = stageApprovalMessage(
    'production',
    approvalPrompt(envelope, 'Strategy is complete. Approve production to continue.')
  );
  createAndPersistApprovalCheckpoint(doc, {
    stage: 'production',
    workflowStepId: 'approve_stage_3',
    title: approval.title,
    message: approval.message,
    actionLabel: 'Review production',
    resumeToken: envelope.requiresApproval.resumeToken,
    envelope,
    runId: runIdFromPrimaryOutput(primaryOutput) ?? getStageRecord(doc, 'strategy').run_id,
    highlight: strategy.highlight,
    primaryOutput,
    artifacts: [
      {
        id: 'production-review',
        stage: 'production',
        title: 'Production approval checkpoint',
        category: 'approval',
        status: 'awaiting_approval',
        summary: approval.message,
        details: [],
      },
    ],
  });
  appendHistory(doc, 'production stage is awaiting approval', { stage: 'production' });
  saveMarketingJobRuntime(doc.job_id, doc);
}

async function finalizeProductionAndRunPublishReview(
  doc: MarketingJobRuntimeDocument,
  resumeToken: string
): Promise<void> {
  if (!resumeToken) {
    throw new Error('missing_production_resume_token');
  }

  const envelope = await resumeMarketingPipeline(resumeToken);
  const primaryOutput = primaryOutputRecord(envelope);
  const production = summarizeProduction(primaryOutput);
  markStageCompleted(doc, 'production', {
    runId: runIdFromPrimaryOutput(primaryOutput) ?? getStageRecord(doc, 'strategy').run_id,
    summary: {
      summary: production.summary,
      highlight: production.highlight,
    },
    primaryOutput,
    outputs: {
      production_handoff: production.handoff,
    },
    artifacts: [],
  });
  appendHistory(doc, 'production stage approved and finalized', { stage: 'production' });
  saveMarketingJobRuntime(doc.job_id, doc);

  if (!envelope.requiresApproval?.resumeToken) {
    throw new Error('marketing_pipeline_missing_resume_token:publish');
  }

  const approval = stageApprovalMessage(
    'publish',
    approvalPrompt(envelope, 'Production is complete. Approve publish to continue.')
  );
  createAndPersistApprovalCheckpoint(doc, {
    stage: 'publish',
    workflowStepId: 'approve_stage_4',
    title: approval.title,
    message: approval.message,
    actionLabel: 'Approve launch review',
    resumeToken: envelope.requiresApproval.resumeToken,
    envelope,
    runId: runIdFromPrimaryOutput(primaryOutput) ?? getStageRecord(doc, 'production').run_id,
    highlight: production.highlight,
    primaryOutput,
    publishConfig: doc.publish_config,
    artifacts: [
      {
        id: 'launch-review',
        stage: 'publish',
        title: 'Launch approval checkpoint',
        category: 'approval',
        status: 'awaiting_approval',
        summary: approval.message,
        details: [],
      },
    ],
  });
  appendHistory(doc, 'publish stage is awaiting approval', { stage: 'publish' });
  saveMarketingJobRuntime(doc.job_id, doc);
}

async function advancePublishStage(doc: MarketingJobRuntimeDocument, resumeToken: string): Promise<void> {
  const publishStage = getStageRecord(doc, 'publish');
  if (!resumeToken) {
    throw new Error('missing_publish_resume_token');
  }

  setJobRunning(doc, 'publish', 'running publish finalize stage');
  markStageInProgress(doc, 'publish');
  saveMarketingJobRuntime(doc.job_id, doc);

  const envelope = await resumeMarketingPipeline(resumeToken);
  const primaryOutput = primaryOutputRecord(envelope);
  const publish = summarizePublish(primaryOutput);
  if (envelope.requiresApproval?.resumeToken) {
    const approval = publishPausedApprovalMessage(
      approvalPrompt(envelope, 'Stage 4 pre-flight is complete. Approve creation of Meta campaigns, ad sets, and ads as paused.')
    );
    createAndPersistApprovalCheckpoint(doc, {
      stage: 'publish',
      workflowStepId: 'approve_stage_4_publish',
      title: approval.title,
      message: approval.message,
      actionLabel: 'Approve paused publish',
      resumeToken: envelope.requiresApproval.resumeToken,
      envelope,
      runId: runIdFromPrimaryOutput(primaryOutput) ?? publishStage.run_id,
      highlight: publish.highlight,
      primaryOutput,
      publishConfig: doc.publish_config,
      outputs: {
        envelope,
      },
      artifacts: replacePublishApprovalArtifacts(publishStage.artifacts, {
        id: 'publish-paused-review',
        stage: 'publish',
        title: 'Publish to Meta (paused) approval checkpoint',
        category: 'approval',
        status: 'awaiting_approval',
        summary: approval.message,
        details: [],
      }),
    });
    appendHistory(doc, 'publish stage is awaiting paused-publish approval', { stage: 'publish' });
    saveMarketingJobRuntime(doc.job_id, doc);
    return;
  }

  markStageCompleted(doc, 'publish', {
    runId: runIdFromPrimaryOutput(primaryOutput) ?? publishStage.run_id,
    summary: {
      summary: publish.summary,
      highlight: publish.highlight,
    },
    primaryOutput,
    outputs: {
      envelope,
    },
    artifacts: replacePublishApprovalArtifacts(publishStage.artifacts),
  });

  doc.state = 'completed';
  doc.status = 'completed';
  doc.current_stage = 'publish';
  clearApprovalCheckpoint(doc, 'publish approval cleared');
  appendHistory(doc, 'publish stage completed', { stage: 'publish', state: 'completed', status: 'completed' });
  saveMarketingJobRuntime(doc.job_id, doc);
}

function handleFailure(
  doc: MarketingJobRuntimeDocument,
  stage: MarketingStage,
  error: unknown
): never {
  if (error instanceof OpenClawGatewayError) {
    recordStageFailure(doc, stage, {
      code: error.code,
      message: error.message,
      retryable: error.code === 'openclaw_gateway_unreachable',
      details: { status: error.status ?? null },
    });
  } else {
    const message = error instanceof Error ? error.message : String(error);
    const [code, detail] = message.split(':', 2);
    recordStageFailure(doc, stage, {
      code: code || 'marketing_stage_failed',
      message: detail || message,
      retryable: false,
    });
  }
  saveMarketingJobRuntime(doc.job_id, doc);
  throw error;
}

export async function startMarketingJob(input: StartMarketingJobRequest): Promise<StartMarketingJobResponse> {
  assertMarketingRuntimeSchemas();

  if (!input?.tenantId || typeof input.tenantId !== 'string' || input.tenantId.trim().length === 0) {
    throw new Error('missing_required_fields:tenantId');
  }
  if (input.jobType !== 'brand_campaign') {
    throw new Error(`unsupported_job_type:${input.jobType}`);
  }
  const brandCampaignInput = ensureBrandCampaignInput(input);

  const jobId = makeMarketingJobId();
  const { brandKit, filePath } = await extractAndSaveTenantBrandKit({
    tenantId: input.tenantId.trim(),
    brandUrl: brandCampaignInput.brandUrl,
  });
  const doc = createMarketingJobRuntimeDocument({
    jobId,
    tenantId: input.tenantId.trim(),
    payload: input.payload,
    brandKit: runtimeBrandKitReference(brandKit, filePath),
  });
  saveMarketingJobRuntime(jobId, doc);

  try {
    await runResearchStage(doc);
  } catch (error) {
    handleFailure(doc, doc.current_stage, error);
  }

  return {
    status: 'accepted',
    jobId,
    tenantId: doc.tenant_id,
    jobType: doc.job_type,
    runtimeArtifactPath: runtimeArtifactPath(jobId),
    approvalRequired: !!doc.approvals.current,
    currentStage: doc.current_stage,
    approval: doc.approvals.current,
  };
}

function inferredWorkflowStepId(checkpoint: MarketingApprovalCheckpoint): WorkflowApprovalStepId {
  if (checkpoint.workflow_step_id === 'approve_stage_2' || checkpoint.workflow_step_id === 'approve_stage_3' || checkpoint.workflow_step_id === 'approve_stage_4' || checkpoint.workflow_step_id === 'approve_stage_4_publish') {
    return checkpoint.workflow_step_id;
  }
  if (checkpoint.stage === 'strategy') {
    return 'approve_stage_2';
  }
  if (checkpoint.stage === 'production') {
    return 'approve_stage_3';
  }
  if (/paused/i.test(checkpoint.message) || /paused/i.test(checkpoint.title)) {
    return 'approve_stage_4_publish';
  }
  return 'approve_stage_4';
}

function terminalApprovalResponse(
  input: { jobId: string; tenantId: string },
  record: MarketingApprovalRecord,
): ApproveMarketingJobResponse {
  return {
    status: 'already_resolved',
    jobId: input.jobId,
    tenantId: input.tenantId,
    resumedStage: record.resolution_result?.resumed_stage ?? record.marketing_stage,
    completed: record.resolution_result?.completed ?? false,
    approvalId: record.approval_id,
    reason:
      record.status === 'denied'
        ? 'already_denied'
        : record.status === 'consumed'
          ? 'already_consumed'
          : 'already_resolved',
  };
}

function cloneApprovalCheckpoint(
  checkpoint: MarketingApprovalCheckpoint,
): MarketingApprovalCheckpoint {
  return {
    ...checkpoint,
    publish_config: checkpoint.publish_config
      ? {
          ...checkpoint.publish_config,
          platforms: [...checkpoint.publish_config.platforms],
          live_publish_platforms: [...checkpoint.publish_config.live_publish_platforms],
          video_render_platforms: [...checkpoint.publish_config.video_render_platforms],
        }
      : null,
  };
}

function markApprovalResolutionInProgress(
  doc: MarketingJobRuntimeDocument,
  checkpoint: MarketingApprovalCheckpoint,
  actedBy: string,
): void {
  const record = markStageInProgress(doc, checkpoint.stage);
  record.artifacts = record.artifacts.map((artifact) =>
    artifact.category === 'approval'
      ? {
          ...artifact,
          status: 'in_progress',
        }
      : artifact,
  );
  doc.approvals.current = null;
  appendHistory(doc, `${checkpoint.stage} approval is being processed by ${actedBy}`, {
    stage: checkpoint.stage,
    state: 'running',
    status: 'running',
  });
}

function restoreApprovalCheckpointAfterFailure(
  doc: MarketingJobRuntimeDocument,
  checkpoint: MarketingApprovalCheckpoint,
): void {
  if (doc.approvals.current) {
    return;
  }
  doc.approvals.current = cloneApprovalCheckpoint(checkpoint);
}

async function waitForApprovalRecordResolution(approvalId: string, timeoutMs = 4_000): Promise<MarketingApprovalRecord | null> {
  const started = Date.now();
  while ((Date.now() - started) < timeoutMs) {
    const record = loadMarketingApprovalRecord(approvalId);
    if (record && (record.status === 'approved' || record.status === 'denied' || record.status === 'consumed')) {
      return record;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return loadMarketingApprovalRecord(approvalId);
}

function backfillApprovalRecordFromCheckpoint(doc: MarketingJobRuntimeDocument, checkpoint: MarketingApprovalCheckpoint): MarketingApprovalRecord | null {
  const resumeToken = checkpoint.resume_token?.trim() || '';
  if (!resumeToken) {
    return null;
  }
  const { workflowName, pipelinePath, runtime } = marketingWorkflowRuntimeContext();
  const descriptor = describeLobsterResumeToken(resumeToken);
  const record = createMarketingApprovalRecord({
    approvalId: checkpoint.approval_id ?? undefined,
    tenantId: doc.tenant_id,
    marketingJobId: doc.job_id,
    workflowName: checkpoint.workflow_name?.trim() || workflowName,
    workflowStepId: inferredWorkflowStepId(checkpoint),
    marketingStage: checkpoint.stage,
    lobsterResumeToken: resumeToken,
    lobsterResumeStateKeys: descriptor.stateKeys,
    approvalPrompt: checkpoint.message,
    runtimeContext: {
      pipelinePath,
      cwd: runtime.cwd,
      stateDir: runtime.stateDir,
      sessionKey: runtime.sessionKey,
      gatewayUrl: runtime.gatewayUrl,
    },
    publishConfig: checkpoint.publish_config ?? null,
  });
  saveMarketingApprovalRecord(record);
  checkpoint.approval_id = record.approval_id;
  checkpoint.workflow_name = record.workflow_name;
  checkpoint.workflow_step_id = record.workflow_step_id;
  saveMarketingJobRuntime(doc.job_id, doc);
  return record;
}

function activeOrBackfilledApprovalRecord(
  doc: MarketingJobRuntimeDocument,
  input: { approvalId?: string | null } = {},
): MarketingApprovalRecord | null {
  const existing = activeApprovalRecord(doc, input);
  if (existing) {
    return existing;
  }
  if (!doc.approvals.current) {
    return null;
  }
  return backfillApprovalRecordFromCheckpoint(doc, doc.approvals.current);
}

async function resolveMarketingApproval(
  input: {
    jobId: string;
    tenantId: string;
    actedBy: string;
    approvedStages?: Array<'research' | 'strategy' | 'production' | 'publish'>;
    approvalId?: string;
    publishConfig?: Partial<MarketingPublishConfig>;
    resolution: MarketingApprovalResolution;
  },
  doc: MarketingJobRuntimeDocument,
): Promise<ApproveMarketingJobResponse> {
  assertMarketingRuntimeSchemas();

  if (!input.actedBy?.trim()) {
    return {
      status: 'error',
      jobId: input.jobId,
      tenantId: input.tenantId,
      resumedStage: null,
      completed: false,
      reason: 'missing_approved_by',
    };
  }
  if (doc.tenant_id !== input.tenantId) {
    return {
      status: 'error',
      jobId: input.jobId,
      tenantId: input.tenantId,
      resumedStage: null,
      completed: false,
      reason: 'tenant_mismatch',
    };
  }

  await ensureRuntimeBrandKit(doc);

  const checkpoint = doc.approvals.current;
  const targetedRecord =
    activeOrBackfilledApprovalRecord(doc, { approvalId: input.approvalId }) ||
    findLatestMarketingApprovalRecord({
      marketingJobId: input.jobId,
      tenantId: input.tenantId,
      approvalId: input.approvalId,
      statuses: ['approved', 'denied', 'consumed'],
    });

  if (!checkpoint) {
    if (targetedRecord) {
      return terminalApprovalResponse(input, targetedRecord);
    }
    return {
      status: 'error',
      jobId: input.jobId,
      tenantId: input.tenantId,
      resumedStage: null,
      completed: false,
      reason: 'approval_not_available',
    };
  }
  if (input.approvalId?.trim() && checkpoint.approval_id?.trim() && input.approvalId.trim() !== checkpoint.approval_id.trim()) {
    if (targetedRecord) {
      return terminalApprovalResponse(input, targetedRecord);
    }
    return {
      status: 'error',
      jobId: input.jobId,
      tenantId: input.tenantId,
      resumedStage: null,
      completed: false,
      reason: 'approval_not_available',
    };
  }
  if (Array.isArray(input.approvedStages) && input.approvedStages.length > 0 && !input.approvedStages.includes(checkpoint.stage)) {
    return {
      status: 'error',
      jobId: input.jobId,
      tenantId: input.tenantId,
      resumedStage: null,
      completed: false,
      reason: 'approval_stage_not_selected',
    };
  }

  const approvalRecord = activeOrBackfilledApprovalRecord(doc, { approvalId: input.approvalId });
  if (!approvalRecord) {
    return {
      status: 'error',
      jobId: input.jobId,
      tenantId: input.tenantId,
      resumedStage: null,
      completed: false,
      reason: 'approval_not_available',
    };
  }

  if (approvalRecord.status === 'approved' || approvalRecord.status === 'denied' || approvalRecord.status === 'consumed') {
    return terminalApprovalResponse(input, approvalRecord);
  }

  const resumeToken = approvalRecord.lobster_resume_token.trim() || checkpoint.resume_token?.trim() || '';
  const checkpointSnapshot = cloneApprovalCheckpoint(checkpoint);
  try {
    return await withMarketingApprovalLock(approvalRecord.approval_id, async () => {
      const currentRecord = loadMarketingApprovalRecord(approvalRecord.approval_id);
      if (!currentRecord) {
        return {
          status: 'error',
          jobId: input.jobId,
          tenantId: input.tenantId,
          resumedStage: null,
          completed: false,
          reason: 'approval_not_available',
        } satisfies ApproveMarketingJobResponse;
      }

      if (currentRecord.status === 'approved' || currentRecord.status === 'denied' || currentRecord.status === 'consumed') {
        return terminalApprovalResponse(input, currentRecord);
      }

      currentRecord.attempt_count += 1;
      currentRecord.last_error = null;
      saveMarketingApprovalRecord(currentRecord);

      if (input.resolution === 'approve') {
        markApprovalResolutionInProgress(doc, checkpoint, input.actedBy.trim());
        saveMarketingJobRuntime(doc.job_id, doc);
      }

      approvalLifecycleLog('approval-resume-requested', {
        jobId: doc.job_id,
        tenantId: doc.tenant_id,
        stage: checkpoint.stage,
        workflowStepId: currentRecord.workflow_step_id,
        approvalId: currentRecord.approval_id,
        resolution: input.resolution,
        attemptCount: currentRecord.attempt_count,
        correlationId: currentRecord.correlation_id,
        traceId: currentRecord.trace_id,
        tokenFingerprint: currentRecord.lobster_resume_token_fingerprint,
        tokenStateKeys: currentRecord.lobster_resume_state_keys,
        timeoutMs: marketingWorkflowTimeoutMs(),
        maxStdoutBytes: marketingWorkflowMaxStdoutBytes(),
      });

      const applyResolution = async (
        activeResumeToken: string,
      ): Promise<{ resumedStage: MarketingStage | null; completed: boolean }> => {
        if (input.resolution === 'deny') {
          const envelope = await resumeMarketingPipeline(activeResumeToken, false);
          if (envelope.status !== 'cancelled') {
            throw new Error('workflow_deny_failed:workflow_did_not_cancel');
          }
          recordApprovalDenied(doc, {
            stage: checkpoint.stage,
            deniedBy: input.actedBy.trim(),
            message: checkpoint.message,
            publishConfig: checkpoint.stage === 'publish' ? input.publishConfig : undefined,
            approvalId: checkpoint.approval_id ?? currentRecord.approval_id,
            workflowStepId: checkpoint.workflow_step_id ?? currentRecord.workflow_step_id,
          });
          clearApprovalCheckpoint(doc, `${checkpoint.stage} approval denied by ${input.actedBy.trim()}`);
          doc.state = 'failed';
          doc.status = 'failed';
          saveMarketingJobRuntime(doc.job_id, doc);
          return {
            resumedStage: checkpoint.stage,
            completed: false,
          };
        }

        let resumedStage: MarketingStage | null = null;
        if (checkpoint.stage === 'strategy') {
          await finalizeStrategyAndRunProductionReview(doc, activeResumeToken);
          resumedStage = 'production';
        } else if (checkpoint.stage === 'production') {
          await finalizeProductionAndRunPublishReview(doc, activeResumeToken);
          resumedStage = 'publish';
        } else {
          await advancePublishStage(doc, activeResumeToken);
          resumedStage = 'publish';
        }

        const completed = doc.state === 'completed';
        recordApproval(doc, {
          stage: checkpoint.stage,
          approvedBy: input.actedBy.trim(),
          message: checkpoint.message,
          publishConfig: checkpoint.stage === 'publish' ? input.publishConfig : undefined,
          approvalId: checkpoint.approval_id ?? currentRecord.approval_id,
          workflowStepId: checkpoint.workflow_step_id ?? currentRecord.workflow_step_id,
        });
        appendHistory(doc, `${checkpoint.stage} approval received from ${input.actedBy.trim()}`, {
          stage: checkpoint.stage,
          state: completed ? 'completed' : doc.state,
          status: completed ? 'completed' : doc.status,
        });
        saveMarketingJobRuntime(doc.job_id, doc);
        return { resumedStage, completed };
      };

      let resumedStage: MarketingStage | null = null;
      let completed = false;

      try {
        ({ resumedStage, completed } = await applyResolution(resumeToken));
      } catch (error) {
        if (!isOpenClawLobsterResumeStateMissing(error)) {
          throw error;
        }

        const freshResumeToken = await reseedMarketingApprovalResumeToken(
          doc,
          checkpointSnapshot,
          currentRecord,
        );
        checkpointSnapshot.resume_token = freshResumeToken;
        ({ resumedStage, completed } = await applyResolution(freshResumeToken));
      }

      currentRecord.status = input.resolution === 'approve' ? 'approved' : 'denied';
      currentRecord.resolution = input.resolution;
      currentRecord.resolved_at = nowIso();
      currentRecord.resolution_result = {
        resumed_stage: resumedStage,
        completed,
        outcome: input.resolution === 'approve' ? 'workflow_resumed' : 'workflow_cancelled',
      };
      currentRecord.last_error = null;
      saveMarketingApprovalRecord(currentRecord);

      approvalLifecycleLog('approval-resume-succeeded', {
        jobId: doc.job_id,
        tenantId: doc.tenant_id,
        stage: checkpoint.stage,
        workflowStepId: currentRecord.workflow_step_id,
        approvalId: currentRecord.approval_id,
        resolution: input.resolution,
        resumedStage,
        completed,
        attemptCount: currentRecord.attempt_count,
        tokenFingerprint: currentRecord.lobster_resume_token_fingerprint,
      });

      return {
        status: input.resolution === 'approve' ? 'resumed' : 'denied',
        jobId: input.jobId,
        tenantId: input.tenantId,
        resumedStage,
        completed,
        approvalId: currentRecord.approval_id,
      } satisfies ApproveMarketingJobResponse;
    });
  } catch (error) {
    if (error instanceof MarketingApprovalLockError) {
      const settled = await waitForApprovalRecordResolution(error.approvalId);
      if (settled && (settled.status === 'approved' || settled.status === 'denied' || settled.status === 'consumed')) {
        return terminalApprovalResponse(input, settled);
      }
      return {
        status: 'error',
        jobId: input.jobId,
        tenantId: input.tenantId,
        resumedStage: null,
        completed: false,
        approvalId: error.approvalId,
        reason: 'approval_resolution_in_progress',
      };
    }

    if (input.resolution === 'approve') {
      restoreApprovalCheckpointAfterFailure(doc, checkpointSnapshot);
    }

    const record = loadMarketingApprovalRecord(approvalRecord.approval_id);
    if (record) {
      record.status = 'failed';
      record.last_error = {
        code: error instanceof OpenClawGatewayError ? error.code : 'approval_resume_failed',
        message: error instanceof Error ? error.message : String(error),
        at: nowIso(),
      };
      saveMarketingApprovalRecord(record);
      approvalLifecycleLog('approval-resume-failed', {
        jobId: doc.job_id,
        tenantId: doc.tenant_id,
        stage: checkpoint.stage,
        workflowStepId: record.workflow_step_id,
        approvalId: record.approval_id,
        resolution: input.resolution,
        attemptCount: record.attempt_count,
        tokenFingerprint: record.lobster_resume_token_fingerprint,
        reason: record.last_error.message,
      });
    }
    handleFailure(doc, checkpoint.stage, error);
  }
}

export async function approveMarketingJob(
  input: ApproveMarketingJobRequest,
  doc: MarketingJobRuntimeDocument
): Promise<ApproveMarketingJobResponse> {
  return resolveMarketingApproval({
    jobId: input.jobId,
    tenantId: input.tenantId,
    actedBy: input.approvedBy,
    approvedStages: input.approvedStages,
    approvalId: input.approvalId,
    publishConfig: input.publishConfig,
    resolution: 'approve',
  }, doc);
}

export async function denyMarketingJob(
  input: DenyMarketingJobRequest,
  doc: MarketingJobRuntimeDocument,
): Promise<ApproveMarketingJobResponse> {
  return resolveMarketingApproval({
    jobId: input.jobId,
    tenantId: input.tenantId,
    actedBy: input.deniedBy,
    approvalId: input.approvalId,
    publishConfig: input.publishConfig,
    resolution: 'deny',
  }, doc);
}
