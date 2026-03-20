import { randomUUID } from 'node:crypto';

import { runAriesOpenClawWorkflow } from '../openclaw/aries-execution';
import { OpenClawGatewayError } from '../openclaw/gateway-client';
import {
  collectProductionFinalizeArtifacts,
  collectProductionReviewArtifacts,
  collectPublishFinalizeArtifacts,
  collectPublishReviewArtifacts,
  collectResearchStageArtifacts,
  collectStrategyFinalizeArtifacts,
  collectStrategyReviewArtifacts,
} from './artifact-collector';
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
  recordApproval,
  recordStageFailure,
  saveMarketingJobRuntime,
  setJobRunning,
  type MarketingApprovalCheckpoint,
  type MarketingJobRuntimeDocument,
  type MarketingPublishConfig,
  type MarketingStage,
} from './runtime-state';

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

function runtimeArtifactPath(jobId: string): string {
  return `generated/draft/marketing-jobs/${jobId}.json`;
}

function makeMarketingJobId(): string {
  return `mkt_${randomUUID()}`;
}

function toBase64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function mergeArtifacts(
  existing: MarketingJobRuntimeDocument['stages'][MarketingStage]['artifacts'],
  incoming: MarketingJobRuntimeDocument['stages'][MarketingStage]['artifacts']
): MarketingJobRuntimeDocument['stages'][MarketingStage]['artifacts'] {
  const entries = [...existing];
  for (const artifact of incoming) {
    const idx = entries.findIndex((entry) => entry.id === artifact.id);
    if (idx >= 0) {
      entries[idx] = artifact;
    } else {
      entries.push(artifact);
    }
  }
  return entries;
}

function ensureBrandCampaignInput(input: StartMarketingJobRequest): { brandUrl: string; competitorUrl: string } {
  const brandUrl = typeof input.payload?.brandUrl === 'string' ? input.payload.brandUrl.trim() : '';
  const competitorUrl = typeof input.payload?.competitorUrl === 'string' ? input.payload.competitorUrl.trim() : '';
  const missing: string[] = [];
  if (!brandUrl) missing.push('payload.brandUrl');
  if (!competitorUrl) missing.push('payload.competitorUrl');
  if (missing.length > 0) {
    throw new Error(`missing_required_fields:${missing.join(',')}`);
  }
  return { brandUrl, competitorUrl };
}

async function executeWorkflow(
  key: Parameters<typeof runAriesOpenClawWorkflow>[0],
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const executed = await runAriesOpenClawWorkflow(key, args);
  if (executed.kind === 'gateway_error') {
    throw executed.error;
  }
  if (executed.kind === 'not_implemented') {
    throw new Error(`${executed.payload.code}:${executed.payload.route}`);
  }
  return executed.primaryOutput ?? {};
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

function publishWorkflowArgs(doc: MarketingJobRuntimeDocument, productionHandoff: Record<string, unknown>): Record<string, unknown> {
  const config = defaultPublishConfig(doc.publish_config);
  const has = (platform: string, entries: string[]) => entries.includes(platform);
  return {
    brand_slug: doc.tenant_id,
    production_handoff_base64: toBase64(productionHandoff),
    platforms_csv: config.platforms.join(','),
    live_publish_platforms_csv: config.live_publish_platforms.join(','),
    video_render_platforms_csv: config.video_render_platforms.join(','),
    meta_ads_enabled: has('meta-ads', config.platforms),
    instagram_enabled: has('instagram', config.platforms),
    x_enabled: has('x', config.platforms),
    tiktok_enabled: has('tiktok', config.platforms),
    youtube_enabled: has('youtube', config.platforms),
    linkedin_enabled: has('linkedin', config.platforms),
    reddit_enabled: has('reddit', config.platforms),
    meta_ads_live_publish_requested: has('meta-ads', config.live_publish_platforms),
    instagram_live_publish_requested: has('instagram', config.live_publish_platforms),
    x_live_publish_requested: has('x', config.live_publish_platforms),
    linkedin_live_publish_requested: has('linkedin', config.live_publish_platforms),
    reddit_live_publish_requested: has('reddit', config.live_publish_platforms),
    tiktok_render_requested: has('tiktok', config.video_render_platforms),
    youtube_render_requested: has('youtube', config.video_render_platforms),
  };
}

function productionHandoffFromDoc(doc: MarketingJobRuntimeDocument): Record<string, unknown> | null {
  return (getStageRecord(doc, 'production').outputs.production_handoff as Record<string, unknown> | undefined) ?? null;
}

async function runResearchStage(doc: MarketingJobRuntimeDocument): Promise<void> {
  setJobRunning(doc, 'research', 'running research stage');
  markStageInProgress(doc, 'research');
  saveMarketingJobRuntime(doc.job_id, doc);

  const researchOutput = await executeWorkflow('marketing_stage1_research', {
    competitor: '',
    competitor_facebook_url: doc.inputs.competitor_url,
    strict_mode: true,
  });
  const capture = collectResearchStageArtifacts(researchOutput);
  markStageCompleted(doc, 'research', {
    runId: capture.runId,
    summary: capture.summary,
    primaryOutput: researchOutput,
    outputs: capture.outputs,
    artifacts: capture.artifacts,
  });
  appendHistory(doc, 'research stage completed', { stage: 'research' });
  saveMarketingJobRuntime(doc.job_id, doc);
}

async function runStrategyReviewStage(doc: MarketingJobRuntimeDocument): Promise<void> {
  setJobRunning(doc, 'strategy', 'running strategy stage');
  markStageInProgress(doc, 'strategy');
  saveMarketingJobRuntime(doc.job_id, doc);

  const researchPrimaryOutput = getStageRecord(doc, 'research').primary_output ?? {};
  const strategyReviewOutput = await executeWorkflow('marketing_stage2_strategy_review', {
    website_url: doc.inputs.brand_url,
    brand_slug: doc.tenant_id,
    stage1_summary_base64: toBase64(researchPrimaryOutput),
    strict_mode: true,
  });
  const capture = collectStrategyReviewArtifacts(strategyReviewOutput);
  const approvalPreview = (strategyReviewOutput.approval_preview as Record<string, unknown> | undefined) ?? {};
  const approval = stageApprovalMessage('strategy', stringValue(approvalPreview.message));
  markStageAwaitingApproval(
    doc,
    'strategy',
    {
      title: approval.title,
      message: approval.message,
      action_label: 'Review strategy',
    },
    {
      runId: capture.runId,
      summary: capture.summary,
      primaryOutput: strategyReviewOutput,
      outputs: capture.outputs,
      artifacts: capture.artifacts,
    }
  );
  appendHistory(doc, 'strategy stage is awaiting approval', { stage: 'strategy' });
  saveMarketingJobRuntime(doc.job_id, doc);
}

async function finalizeStrategyAndRunProductionReview(doc: MarketingJobRuntimeDocument): Promise<void> {
  const strategyStage = getStageRecord(doc, 'strategy');
  const strategyRunId = strategyStage.run_id;
  if (!strategyRunId) {
    throw new Error('missing_strategy_run_id');
  }

  const strategyFinalizeOutput = await executeWorkflow('marketing_stage2_strategy_finalize', {
    brand_slug: doc.tenant_id,
    run_id: strategyRunId,
  });
  const strategyFinalizeCapture = collectStrategyFinalizeArtifacts(strategyFinalizeOutput);
  markStageCompleted(doc, 'strategy', {
    runId: strategyFinalizeCapture.runId ?? strategyRunId,
    summary: strategyFinalizeCapture.summary ?? strategyStage.summary,
    primaryOutput: strategyFinalizeOutput,
    outputs: {
      ...strategyStage.outputs,
      ...strategyFinalizeCapture.outputs,
    },
    artifacts: mergeArtifacts(strategyStage.artifacts, strategyFinalizeCapture.artifacts),
  });
  appendHistory(doc, 'strategy stage approved and finalized', { stage: 'strategy' });
  saveMarketingJobRuntime(doc.job_id, doc);

  setJobRunning(doc, 'production', 'running production stage');
  markStageInProgress(doc, 'production');
  saveMarketingJobRuntime(doc.job_id, doc);

  const strategyHandoff = strategyFinalizeCapture.outputs.strategy_handoff ?? {};
  const productionReviewOutput = await executeWorkflow('marketing_stage3_production_review', {
    brand_slug: doc.tenant_id,
    strategy_handoff_base64: toBase64(strategyHandoff),
  });
  const productionCapture = collectProductionReviewArtifacts(productionReviewOutput);
  const approvalPreview = (productionReviewOutput.approval_preview as Record<string, unknown> | undefined) ?? {};
  const approval = stageApprovalMessage('production', stringValue(approvalPreview.message));
  markStageAwaitingApproval(
    doc,
    'production',
    {
      title: approval.title,
      message: approval.message,
      action_label: 'Review production',
    },
    {
      runId: productionCapture.runId,
      summary: productionCapture.summary,
      primaryOutput: productionReviewOutput,
      outputs: productionCapture.outputs,
      artifacts: productionCapture.artifacts,
    }
  );
  appendHistory(doc, 'production stage is awaiting approval', { stage: 'production' });
  saveMarketingJobRuntime(doc.job_id, doc);
}

async function finalizeProductionAndRunPublishReview(doc: MarketingJobRuntimeDocument): Promise<void> {
  const productionStage = getStageRecord(doc, 'production');
  const productionRunId = productionStage.run_id;
  if (!productionRunId) {
    throw new Error('missing_production_run_id');
  }

  const productionFinalizeOutput = await executeWorkflow('marketing_stage3_production_finalize', {
    brand_slug: doc.tenant_id,
    run_id: productionRunId,
  });
  const productionFinalizeCapture = collectProductionFinalizeArtifacts(productionFinalizeOutput);
  markStageCompleted(doc, 'production', {
    runId: productionFinalizeCapture.runId ?? productionRunId,
    summary: productionFinalizeCapture.summary ?? productionStage.summary,
    primaryOutput: productionFinalizeOutput,
    outputs: {
      ...productionStage.outputs,
      ...productionFinalizeCapture.outputs,
    },
    artifacts: mergeArtifacts(productionStage.artifacts, productionFinalizeCapture.artifacts),
  });
  appendHistory(doc, 'production stage approved and finalized', { stage: 'production' });
  saveMarketingJobRuntime(doc.job_id, doc);

  setJobRunning(doc, 'publish', 'running publish preflight stage');
  markStageInProgress(doc, 'publish');
  saveMarketingJobRuntime(doc.job_id, doc);

  const productionHandoff = productionFinalizeCapture.outputs.production_handoff ?? {};
  const publishReviewOutput = await executeWorkflow('marketing_stage4_publish_review', {
    brand_slug: doc.tenant_id,
    production_handoff_base64: toBase64(productionHandoff),
  });
  const publishCapture = collectPublishReviewArtifacts(publishReviewOutput);
  const approvalPreview = (publishReviewOutput.approval_preview as Record<string, unknown> | undefined) ?? {};
  const approval = stageApprovalMessage('publish', stringValue(approvalPreview.message));
  markStageAwaitingApproval(
    doc,
    'publish',
    {
      title: approval.title,
      message: approval.message,
      action_label: 'Approve launch',
      publish_config: doc.publish_config,
    },
    {
      runId: publishCapture.runId,
      summary: publishCapture.summary,
      primaryOutput: publishReviewOutput,
      outputs: publishCapture.outputs,
      artifacts: publishCapture.artifacts,
    }
  );
  appendHistory(doc, 'publish stage is awaiting approval', { stage: 'publish' });
  saveMarketingJobRuntime(doc.job_id, doc);
}

async function finalizePublish(doc: MarketingJobRuntimeDocument): Promise<void> {
  const publishStage = getStageRecord(doc, 'publish');
  const productionHandoff = productionHandoffFromDoc(doc);
  if (!productionHandoff) {
    throw new Error('missing_production_handoff');
  }

  setJobRunning(doc, 'publish', 'running publish finalize stage');
  markStageInProgress(doc, 'publish');
  saveMarketingJobRuntime(doc.job_id, doc);

  const publishFinalizeOutput = await executeWorkflow('marketing_stage4_publish_finalize', publishWorkflowArgs(doc, productionHandoff));
  const publishCapture = collectPublishFinalizeArtifacts(publishFinalizeOutput);
  markStageCompleted(doc, 'publish', {
    runId: publishCapture.runId ?? publishStage.run_id,
    summary: publishCapture.summary ?? publishStage.summary,
    primaryOutput: publishFinalizeOutput,
    outputs: {
      ...publishStage.outputs,
      ...publishCapture.outputs,
    },
    artifacts: mergeArtifacts(publishStage.artifacts, publishCapture.artifacts),
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
  ensureBrandCampaignInput(input);

  const jobId = makeMarketingJobId();
  const doc = createMarketingJobRuntimeDocument({
    jobId,
    tenantId: input.tenantId.trim(),
    payload: input.payload,
  });
  saveMarketingJobRuntime(jobId, doc);

  try {
    await runResearchStage(doc);
    await runStrategyReviewStage(doc);
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
      await finalizeStrategyAndRunProductionReview(doc);
      return {
        status: 'resumed',
        jobId: input.jobId,
        tenantId: input.tenantId,
        resumedStage: 'production',
        completed: false,
      };
    }

    if (checkpoint.stage === 'production') {
      await finalizeProductionAndRunPublishReview(doc);
      return {
        status: 'resumed',
        jobId: input.jobId,
        tenantId: input.tenantId,
        resumedStage: 'publish',
        completed: false,
      };
    }

    await finalizePublish(doc);
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
