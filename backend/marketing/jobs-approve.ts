import { resumeOpenClawLobsterWorkflow, type LobsterEnvelope } from '../openclaw/gateway-client';
import {
  asRecord,
  asString,
  assertMarketingRuntimeSchemas,
  ensureRuntimeHistory,
  ensureRuntimeOpenClaw,
  ensureRuntimeOutputs,
  ensureRuntimeStageStatus,
  ensureStructuredStatusUpdates,
  loadMarketingJobRuntime,
  nowIso,
  saveMarketingJobRuntime,
} from './runtime-state';

export type ApproveMarketingJobRequest = {
  jobId: string;
  tenantId: string;
  approvedBy: string;
  approvedStages?: Array<"research" | "strategy" | "production" | "publish">;
  resumePublishIfNeeded?: boolean;
};

export type ApproveMarketingJobResponse = {
  status: "resumed" | "error";
  jobId: string;
  tenantId: string;
  resumedStage: string | null;
  completed: boolean;
  wiring: "openclaw_gateway";
  reason?: string;
};

function primaryOutputRecord(envelope: LobsterEnvelope): Record<string, unknown> | null {
  if (!Array.isArray(envelope.output) || envelope.output.length === 0) {
    return null;
  }
  const first = envelope.output[0];
  return first && typeof first === 'object' && !Array.isArray(first)
    ? (first as Record<string, unknown>)
    : null;
}

function markStageCompleted(stageStatus: Record<string, string>, stage: string): void {
  stageStatus[stage] = 'completed';
}

export async function approveMarketingJob(input: ApproveMarketingJobRequest): Promise<ApproveMarketingJobResponse> {
  assertMarketingRuntimeSchemas();

  if (!input.approvedBy?.trim()) {
    return {
      status: "error",
      jobId: input.jobId,
      tenantId: input.tenantId,
      resumedStage: null,
      completed: false,
      wiring: "openclaw_gateway",
      reason: 'missing_approved_by',
    };
  }

  const job = loadMarketingJobRuntime(input.jobId);
  if (!job) {
    return {
      status: "error",
      jobId: input.jobId,
      tenantId: input.tenantId,
      resumedStage: null,
      completed: false,
      wiring: "openclaw_gateway",
      reason: 'job_not_found',
    };
  }
  if (typeof job.tenant_id !== 'string' || job.tenant_id !== input.tenantId) {
    return {
      status: "error",
      jobId: input.jobId,
      tenantId: input.tenantId,
      resumedStage: null,
      completed: false,
      wiring: "openclaw_gateway",
      reason: 'tenant_mismatch',
    };
  }

  const openclaw = ensureRuntimeOpenClaw(job);
  const resumeToken = asString(openclaw.resume_token);
  if (!resumeToken) {
    return {
      status: "error",
      jobId: input.jobId,
      tenantId: input.tenantId,
      resumedStage: null,
      completed: false,
      wiring: "openclaw_gateway",
      reason: 'approval_not_available',
    };
  }

  const envelope = await resumeOpenClawLobsterWorkflow({
    token: resumeToken,
    approve: input.resumePublishIfNeeded ?? true,
  });
  const primaryOutput = primaryOutputRecord(envelope);
  const outputs = ensureRuntimeOutputs(job);
  const stageStatus = ensureRuntimeStageStatus(job);
  const statusUpdates = ensureStructuredStatusUpdates(job);
  const history = ensureRuntimeHistory(job);
  const ts = nowIso();

  markStageCompleted(stageStatus, 'research');
  markStageCompleted(stageStatus, 'strategy');
  markStageCompleted(stageStatus, 'production');
  stageStatus.publish = envelope.requiresApproval?.resumeToken ? 'awaiting_approval' : 'completed';

  outputs.current_stage = 'publish';
  openclaw.envelope_status = envelope.status;
  openclaw.resume_token = envelope.requiresApproval?.resumeToken ?? null;
  if (!openclaw.run_id && typeof primaryOutput?.run_id === 'string') {
    openclaw.run_id = primaryOutput.run_id;
  }
  if (!openclaw.initial_primary_output && openclaw.primary_output) {
    openclaw.initial_primary_output = openclaw.primary_output;
  }
  openclaw.primary_output = primaryOutput;
  openclaw.last_resume_output = primaryOutput;
  openclaw.resumed_by = input.approvedBy.trim();
  openclaw.resumed_at = ts;

  job.state = envelope.requiresApproval?.resumeToken ? 'approval_required' : 'completed';
  job.status = envelope.requiresApproval?.resumeToken ? 'awaiting_approval' : 'completed';
  job.updated_at = ts;

  statusUpdates.push({
    at: ts,
    state: job.state,
    status: job.status,
    step: 'publish',
    details: {
      source: 'openclaw_gateway_resume',
      envelope_status: envelope.status,
      approved_by: input.approvedBy.trim(),
      approved_stages: input.approvedStages || [],
    },
  });
  history.push({
    at: ts,
    state: job.state,
    status: job.status,
    note: envelope.requiresApproval?.resumeToken
      ? 'marketing job resumed but is still awaiting approval'
      : 'marketing job completed after launch approval',
  });

  saveMarketingJobRuntime(input.jobId, job);
  return {
    status: "resumed",
    jobId: input.jobId,
    tenantId: input.tenantId,
    resumedStage: "publish",
    completed: !envelope.requiresApproval?.resumeToken,
    wiring: "openclaw_gateway"
  };
}
