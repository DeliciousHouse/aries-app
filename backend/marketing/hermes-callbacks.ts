import type { HermesRunCallbackPayload } from '@/backend/execution/hermes-callbacks';
import type { ExecutionRunRecord } from '@/backend/execution/run-store';

import {
  createMarketingApprovalRecord,
  saveMarketingApprovalRecord,
} from './approval-store';
import {
  clearApprovalCheckpoint,
  loadMarketingJobRuntime,
  markStageAwaitingApproval,
  markStageCompleted,
  recordStageFailure,
  saveMarketingJobRuntime,
  type MarketingJobRuntimeDocument,
  type MarketingStage,
} from './runtime-state';

function firstOutputRecord(payload: HermesRunCallbackPayload): Record<string, unknown> | null {
  if (Array.isArray(payload.output)) {
    const first = payload.output[0];
    return first && typeof first === 'object' && !Array.isArray(first)
      ? (first as Record<string, unknown>)
      : null;
  }
  return payload.output && typeof payload.output === 'object' && !Array.isArray(payload.output)
    ? payload.output
    : null;
}

function outputSummary(payload: HermesRunCallbackPayload): { summary: string } | null {
  const output = firstOutputRecord(payload);
  const summary = typeof output?.summary === 'string' && output.summary.trim().length > 0
    ? output.summary.trim()
    : '';
  return summary ? { summary } : null;
}

function outputRunId(payload: HermesRunCallbackPayload, fallback: string | null): string | null {
  const output = firstOutputRecord(payload);
  return typeof output?.run_id === 'string' && output.run_id.trim().length > 0
    ? output.run_id.trim()
    : fallback;
}

function approvalTitle(stage: 'strategy' | 'production' | 'publish'): string {
  return stage === 'strategy'
    ? 'Approve campaign strategy'
    : stage === 'production'
      ? 'Approve production plan'
      : 'Approve publishing plan';
}

function actionLabel(stage: 'strategy' | 'production' | 'publish'): string {
  return stage === 'strategy'
    ? 'Approve strategy'
    : stage === 'production'
      ? 'Approve production'
      : 'Approve publishing';
}

function markJobCompleted(doc: MarketingJobRuntimeDocument, stage: MarketingStage, payload: HermesRunCallbackPayload): void {
  markStageCompleted(doc, stage, {
    runId: outputRunId(payload, payload.hermes_run_id ?? null),
    summary: outputSummary(payload),
    primaryOutput: firstOutputRecord(payload),
  });
  clearApprovalCheckpoint(doc, `${stage} completed from Hermes callback`);
  if (stage === 'publish') {
    doc.state = 'completed';
    doc.status = 'completed';
    doc.current_stage = 'publish';
  }
}

function createApprovalCheckpoint(
  doc: MarketingJobRuntimeDocument,
  run: ExecutionRunRecord,
  payload: HermesRunCallbackPayload,
): void {
  const approval = payload.approval;
  if (!approval) {
    return;
  }

  const approvalRecord = createMarketingApprovalRecord({
    tenantId: doc.tenant_id,
    marketingJobId: doc.job_id,
    workflowName: run.workflow_key,
    workflowStepId: approval.workflow_step_id,
    marketingStage: approval.stage,
    executionProvider: 'hermes',
    executionResumeToken: approval.resume_token ?? '',
    approvalPrompt: approval.prompt,
    runtimeContext: {
      pipelinePath: run.workflow_key,
      cwd: 'hermes',
      sessionKey: 'marketing',
    },
  });
  saveMarketingApprovalRecord(approvalRecord);

  markStageAwaitingApproval(
    doc,
    approval.stage,
    {
      approval_id: approvalRecord.approval_id,
      workflow_name: run.workflow_key,
      workflow_step_id: approval.workflow_step_id,
      title: approvalTitle(approval.stage),
      message: approval.prompt,
      resume_token: approval.resume_token ?? null,
      action_label: actionLabel(approval.stage),
    },
    {
      runId: outputRunId(payload, payload.hermes_run_id ?? null),
      summary: outputSummary(payload),
      primaryOutput: firstOutputRecord(payload),
    },
  );
}

export async function applyHermesMarketingCallback(
  run: ExecutionRunRecord,
  payload: HermesRunCallbackPayload,
): Promise<void> {
  if (!run.marketing_job_id || !run.stage) {
    return;
  }

  const doc = await loadMarketingJobRuntime(run.marketing_job_id);
  if (!doc) {
    return;
  }

  if (payload.status === 'failed' || payload.status === 'cancelled') {
    recordStageFailure(doc, run.stage, {
      code: payload.error?.code ?? `hermes_${payload.status}`,
      message: payload.error?.message ?? `Hermes ${payload.status} the ${run.stage} stage.`,
      retryable: payload.error?.retryable,
    });
    saveMarketingJobRuntime(doc.job_id, doc);
    return;
  }

  if (payload.status === 'requires_approval') {
    markStageCompleted(doc, run.stage, {
      runId: outputRunId(payload, payload.hermes_run_id ?? null),
      summary: outputSummary(payload),
      primaryOutput: firstOutputRecord(payload),
    });
    createApprovalCheckpoint(doc, run, payload);
    saveMarketingJobRuntime(doc.job_id, doc);
    return;
  }

  if (payload.status === 'completed') {
    markJobCompleted(doc, run.stage, payload);
    saveMarketingJobRuntime(doc.job_id, doc);
  }
}
