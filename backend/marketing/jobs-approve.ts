import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { resolveCodePath } from '@/lib/runtime-paths';
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

const execFileAsync = promisify(execFile);

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

async function runLocalStage4Compat(runId: string, brandSlug: string): Promise<LobsterEnvelope> {
  const compatPath = resolveCodePath('lobster', 'bin', 'stage4-publish-compat');
  const { stdout } = await execFileAsync(
    compatPath,
    ['--json', '--brand-slug', brandSlug, '--run-id', runId],
    {
      cwd: resolveCodePath('lobster'),
      maxBuffer: 1024 * 1024 * 8,
    },
  );
  return {
    ok: true,
    status: 'ok',
    output: [JSON.parse(stdout) as Record<string, unknown>],
    requiresApproval: null,
    compatibilityMode: 'stage4-publish-compat',
  } as LobsterEnvelope;
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
  const existingPrimaryOutput = asRecord(openclaw.primary_output);
  const localCompatEligible = !resumeToken && asString(existingPrimaryOutput?.type) === 'launch_review_preview';
  let envelope: LobsterEnvelope;
  if (resumeToken) {
    envelope = await resumeOpenClawLobsterWorkflow({
      token: resumeToken,
      approve: input.resumePublishIfNeeded ?? true,
    });
  } else if (localCompatEligible) {
    const runId = asString(openclaw.run_id) ?? asString(existingPrimaryOutput?.run_id);
    const brandSlug = asString(existingPrimaryOutput?.brand_slug) ?? asString(job.tenant_id) ?? 'client-brand';
    if (!runId) {
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
    envelope = await runLocalStage4Compat(runId, brandSlug);
  } else {
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
      compatibility_mode: (envelope as Record<string, unknown>).compatibilityMode ?? null,
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
