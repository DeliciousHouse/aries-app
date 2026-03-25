import { randomUUID } from 'node:crypto';

import { resolveCodePath, resolveCodeRoot } from '@/lib/runtime-paths';
import {
  OpenClawGatewayError,
  resumeOpenClawLobsterWorkflow,
  runOpenClawLobsterWorkflow,
  type LobsterEnvelope,
} from '../openclaw/gateway-client';
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
  recordStageFailure,
  saveMarketingJobRuntime,
  setJobRunning,
  type MarketingApprovalCheckpoint,
  type MarketingJobRuntimeDocument,
  type MarketingPublishConfig,
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
  resumePublishIfNeeded?: boolean;
  publishConfig?: Partial<MarketingPublishConfig>;
};

export type ApproveMarketingJobResponse = {
  status: 'resumed' | 'error';
  jobId: string;
  tenantId: string;
  resumedStage: MarketingStage | null;
  completed: boolean;
  reason?: string;
};

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
    brand_slug: doc.tenant_id,
  };
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
  });
}

async function resumeMarketingPipeline(resumeToken: string): Promise<LobsterEnvelope> {
  return resumeOpenClawLobsterWorkflow({
    token: resumeToken,
    approve: true,
    cwd: marketingPipelineCwd(),
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


async function runResearchStage(doc: MarketingJobRuntimeDocument): Promise<void> {
  setJobRunning(doc, 'research', 'running research stage');
  markStageInProgress(doc, 'research');
  saveMarketingJobRuntime(doc.job_id, doc);

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
  markStageAwaitingApproval(
    doc,
    'strategy',
    {
      title: approval.title,
      message: approval.message,
      action_label: 'Review strategy',
      resume_token: envelope.requiresApproval.resumeToken,
    },
    {
      runId,
      summary: {
        summary: approval.message,
        highlight: summary.highlight,
      },
      primaryOutput,
      outputs: {
        resume_token: envelope.requiresApproval.resumeToken,
      },
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
    }
  );
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
  markStageAwaitingApproval(
    doc,
    'production',
    {
      title: approval.title,
      message: approval.message,
      action_label: 'Review production',
      resume_token: envelope.requiresApproval.resumeToken,
    },
    {
      runId: runIdFromPrimaryOutput(primaryOutput) ?? getStageRecord(doc, 'strategy').run_id,
      summary: {
        summary: approval.message,
        highlight: strategy.highlight,
      },
      primaryOutput,
      outputs: {
        resume_token: envelope.requiresApproval.resumeToken,
      },
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
    }
  );
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
  markStageAwaitingApproval(
    doc,
    'publish',
    {
      title: approval.title,
      message: approval.message,
      action_label: 'Approve launch',
      publish_config: doc.publish_config,
      resume_token: envelope.requiresApproval.resumeToken,
    },
    {
      runId: runIdFromPrimaryOutput(primaryOutput) ?? getStageRecord(doc, 'production').run_id,
      summary: {
        summary: approval.message,
        highlight: production.highlight,
      },
      primaryOutput,
      outputs: {
        resume_token: envelope.requiresApproval.resumeToken,
      },
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
    }
  );
  appendHistory(doc, 'publish stage is awaiting approval', { stage: 'publish' });
  saveMarketingJobRuntime(doc.job_id, doc);
}

async function finalizePublish(doc: MarketingJobRuntimeDocument, resumeToken: string): Promise<void> {
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
    artifacts: publishStage.artifacts,
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

export async function approveMarketingJob(
  input: ApproveMarketingJobRequest,
  doc: MarketingJobRuntimeDocument
): Promise<ApproveMarketingJobResponse> {
  assertMarketingRuntimeSchemas();

  if (!input.approvedBy?.trim()) {
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

  const checkpoint = doc.approvals.current;
  if (!checkpoint) {
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
  const resumeToken = checkpoint.resume_token?.trim() || '';

  await ensureRuntimeBrandKit(doc);

  recordApproval(doc, {
    stage: checkpoint.stage,
    approvedBy: input.approvedBy.trim(),
    message: checkpoint.message,
    publishConfig: checkpoint.stage === 'publish' ? input.publishConfig : undefined,
  });
  appendHistory(doc, `${checkpoint.stage} approval received from ${input.approvedBy.trim()}`, {
    stage: checkpoint.stage,
    state: 'running',
    status: 'running',
  });
  saveMarketingJobRuntime(doc.job_id, doc);

  try {
    if (checkpoint.stage === 'strategy') {
      await finalizeStrategyAndRunProductionReview(doc, resumeToken);
      return {
        status: 'resumed',
        jobId: input.jobId,
        tenantId: input.tenantId,
        resumedStage: 'production',
        completed: false,
      };
    }

    if (checkpoint.stage === 'production') {
      await finalizeProductionAndRunPublishReview(doc, resumeToken);
      return {
        status: 'resumed',
        jobId: input.jobId,
        tenantId: input.tenantId,
        resumedStage: 'publish',
        completed: false,
      };
    }

    await finalizePublish(doc, resumeToken);
    return {
      status: 'resumed',
      jobId: input.jobId,
      tenantId: input.tenantId,
      resumedStage: 'publish',
      completed: true,
    };
  } catch (error) {
    handleFailure(doc, checkpoint.stage, error);
  }
}
