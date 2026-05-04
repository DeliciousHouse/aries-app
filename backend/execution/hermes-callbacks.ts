import {
  ExecutionRunLockError,
  hasExecutionRunEvent,
  loadExecutionRunRecord,
  markExecutionRunEventApplied,
  type ExecutionRunStatus,
  type ExecutionRunRecord,
  withExecutionRunLock,
} from './run-store';
import { applyHermesMarketingCallback } from '../marketing/hermes-callbacks';

export type HermesRunCallbackStatus =
  | 'running'
  | 'requires_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type HermesRunCallbackPayload = {
  event_id: string;
  aries_run_id: string;
  hermes_run_id?: string;
  status: HermesRunCallbackStatus;
  output?: Record<string, unknown> | Record<string, unknown>[];
  artifacts?: unknown[];
  approval?: {
    stage: 'strategy' | 'production' | 'publish';
    workflow_step_id: 'approve_stage_2' | 'approve_stage_3' | 'approve_stage_4' | 'approve_stage_4_publish';
    prompt: string;
    resume_token?: string;
  };
  error?: { code?: string; message: string; retryable?: boolean };
};

export type HermesRunCallbackResult =
  | { status: 'accepted'; ariesRunId: string; duplicate: boolean }
  | { status: 'error'; reason: string };

type HermesRunApproval = NonNullable<HermesRunCallbackPayload['approval']>;

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isCallbackStatus(value: string): value is HermesRunCallbackStatus {
  return value === 'running'
    || value === 'requires_approval'
    || value === 'completed'
    || value === 'failed'
    || value === 'cancelled';
}

function isApprovalStage(value: string): value is HermesRunApproval['stage'] {
  return value === 'strategy' || value === 'production' || value === 'publish';
}

function isApprovalWorkflowStep(value: string): value is HermesRunApproval['workflow_step_id'] {
  return value === 'approve_stage_2'
    || value === 'approve_stage_3'
    || value === 'approve_stage_4'
    || value === 'approve_stage_4_publish';
}

function approvalMatchesStage(
  stage: HermesRunApproval['stage'],
  workflowStepId: HermesRunApproval['workflow_step_id'],
): boolean {
  if (stage === 'strategy') return workflowStepId === 'approve_stage_2';
  if (stage === 'production') return workflowStepId === 'approve_stage_3';
  return workflowStepId === 'approve_stage_4' || workflowStepId === 'approve_stage_4_publish';
}

function parseApproval(value: unknown): HermesRunCallbackPayload['approval'] | undefined {
  const record = recordValue(value);
  if (!record) {
    return undefined;
  }
  const stage = stringValue(record.stage);
  const workflowStepId = stringValue(record.workflow_step_id);
  const prompt = stringValue(record.prompt);
  const resumeToken = stringValue(record.resume_token);
  if (
    !isApprovalStage(stage)
    || !isApprovalWorkflowStep(workflowStepId)
    || !approvalMatchesStage(stage, workflowStepId)
    || !prompt
  ) {
    return undefined;
  }
  return {
    stage,
    workflow_step_id: workflowStepId,
    prompt,
    resume_token: resumeToken || undefined,
  };
}

function parseCallbackError(value: unknown): HermesRunCallbackPayload['error'] | undefined {
  const record = recordValue(value);
  if (!record) {
    return undefined;
  }
  const message = stringValue(record.message);
  if (!message) {
    return undefined;
  }
  const code = stringValue(record.code);
  return {
    code: code || undefined,
    message,
    retryable: typeof record.retryable === 'boolean' ? record.retryable : undefined,
  };
}

function executionStatus(status: HermesRunCallbackStatus): ExecutionRunStatus {
  return status === 'requires_approval' ? 'awaiting_approval' : status;
}

export function parseHermesRunCallbackPayload(value: unknown): HermesRunCallbackPayload | null {
  const record = recordValue(value);
  if (!record) {
    return null;
  }
  const eventId = stringValue(record.event_id);
  const ariesRunId = stringValue(record.aries_run_id);
  const status = stringValue(record.status);
  if (!eventId || !ariesRunId || !isCallbackStatus(status)) {
    return null;
  }

  return {
    event_id: eventId,
    aries_run_id: ariesRunId,
    hermes_run_id: stringValue(record.hermes_run_id) || undefined,
    status,
    output: Array.isArray(record.output) || recordValue(record.output)
      ? (record.output as HermesRunCallbackPayload['output'])
      : undefined,
    artifacts: Array.isArray(record.artifacts) ? record.artifacts : undefined,
    approval: parseApproval(record.approval),
    error: parseCallbackError(record.error),
  };
}

function validateRunCorrelation(
  run: ExecutionRunRecord,
  payload: HermesRunCallbackPayload,
): HermesRunCallbackResult | null {
  if (!run.external_run_id) {
    return null;
  }
  if (!payload.hermes_run_id) {
    return { status: 'error', reason: 'missing_hermes_run_id' };
  }
  if (payload.hermes_run_id !== run.external_run_id) {
    return { status: 'error', reason: 'hermes_run_id_mismatch' };
  }
  return null;
}

function validateApprovalTransition(
  run: ExecutionRunRecord,
  payload: HermesRunCallbackPayload,
): HermesRunCallbackResult | null {
  if (payload.status !== 'requires_approval') {
    return null;
  }
  if (!payload.approval) {
    return { status: 'error', reason: 'missing_approval_payload' };
  }
  if (run.domain !== 'marketing') {
    return { status: 'error', reason: 'approval_not_supported_for_domain' };
  }
  if (run.stage === 'research' && payload.approval.stage !== 'strategy') {
    return { status: 'error', reason: 'approval_stage_mismatch' };
  }
  if (run.stage === 'strategy' && payload.approval.stage !== 'production') {
    return { status: 'error', reason: 'approval_stage_mismatch' };
  }
  if (run.stage === 'production' && payload.approval.stage !== 'publish') {
    return { status: 'error', reason: 'approval_stage_mismatch' };
  }
  return null;
}

export async function handleHermesRunCallback(
  payload: HermesRunCallbackPayload,
): Promise<HermesRunCallbackResult> {
  try {
    return await withExecutionRunLock(payload.aries_run_id, async () => {
      const run = loadExecutionRunRecord(payload.aries_run_id);
      if (!run) {
        return { status: 'error', reason: 'execution_run_not_found' };
      }

      if (hasExecutionRunEvent(payload.aries_run_id, payload.event_id)) {
        return {
          status: 'accepted',
          ariesRunId: payload.aries_run_id,
          duplicate: true,
        };
      }

      const correlationError = validateRunCorrelation(run, payload);
      if (correlationError) {
        return correlationError;
      }

      const approvalError = validateApprovalTransition(run, payload);
      if (approvalError) {
        return approvalError;
      }

      if (run.domain === 'marketing') {
        await applyHermesMarketingCallback(run, payload);
      }

      markExecutionRunEventApplied(payload.aries_run_id, {
        eventId: payload.event_id,
        status: executionStatus(payload.status),
        result: payload.output ?? payload.approval ?? null,
        externalRunId: payload.hermes_run_id,
        error: payload.error
          ? {
              code: payload.error.code ?? 'hermes_callback_error',
              message: payload.error.message,
              retryable: payload.error.retryable,
            }
          : null,
      });

      return {
        status: 'accepted',
        ariesRunId: payload.aries_run_id,
        duplicate: false,
      };
    });
  } catch (error) {
    if (error instanceof ExecutionRunLockError) {
      return { status: 'error', reason: 'execution_run_locked' };
    }
    throw error;
  }
}
