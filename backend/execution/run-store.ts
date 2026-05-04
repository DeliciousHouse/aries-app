import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { resolveDataPath } from '@/lib/runtime-paths';
import type { MarketingStage } from '@/backend/marketing/runtime-state';

export type ExecutionRunProvider = 'hermes' | 'legacy-openclaw';
export type ExecutionRunDomain = 'route' | 'marketing';
export type ExecutionRunAction = 'run' | 'resume' | 'cancel';
export type ExecutionRunStatus =
  | 'submitted'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

const CALLBACK_ADVANCED_STATUSES = new Set<ExecutionRunStatus>([
  'running',
  'awaiting_approval',
  'completed',
  'failed',
  'cancelled',
]);

export type ExecutionRunRecord = {
  schema_name: 'aries_execution_run';
  schema_version: '1.0.0';
  aries_run_id: string;
  provider: ExecutionRunProvider;
  domain: ExecutionRunDomain;
  workflow_key: string;
  action: ExecutionRunAction;
  tenant_id: string | null;
  marketing_job_id: string | null;
  approval_id: string | null;
  stage: MarketingStage | null;
  workflow_step_id: string | null;
  external_run_id: string | null;
  status: ExecutionRunStatus;
  event_ids: string[];
  created_at: string;
  updated_at: string;
  last_error: {
    code: string;
    message: string;
    retryable?: boolean;
  } | null;
  result: unknown | null;
};

export type CreateExecutionRunRecordInput = {
  provider: ExecutionRunProvider;
  domain: ExecutionRunDomain;
  workflowKey: string;
  action: ExecutionRunAction;
  tenantId?: string | null;
  marketingJobId?: string | null;
  approvalId?: string | null;
  stage?: MarketingStage | null;
  workflowStepId?: string | null;
};

export class ExecutionRunLockError extends Error {
  code = 'execution_run_locked' as const;
  ariesRunId: string;

  constructor(ariesRunId: string) {
    super(`execution run ${ariesRunId} is already being processed`);
    this.name = 'ExecutionRunLockError';
    this.ariesRunId = ariesRunId;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function executionRunsRoot(): string {
  return resolveDataPath('generated', 'draft', 'execution-runs');
}

export function executionRunPath(ariesRunId: string): string {
  const root = path.resolve(executionRunsRoot());
  const resolved = path.resolve(root, `${ariesRunId}.json`);
  if (!resolved.startsWith(root + path.sep)) {
    throw new Error(`invalid aries_run_id: path escapes execution-runs directory`);
  }
  return resolved;
}

function executionRunLockPath(ariesRunId: string): string {
  return `${executionRunPath(ariesRunId)}.lock`;
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function isExecutionRunRecord(value: unknown): value is ExecutionRunRecord {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as { schema_name?: unknown }).schema_name === 'aries_execution_run'
    && typeof (value as { aries_run_id?: unknown }).aries_run_id === 'string';
}

export function loadExecutionRunRecord(ariesRunId: string): ExecutionRunRecord | null {
  const filePath = executionRunPath(ariesRunId);
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    return isExecutionRunRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveExecutionRunRecord(record: ExecutionRunRecord): string {
  record.updated_at = nowIso();
  const filePath = executionRunPath(record.aries_run_id);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(record, null, 2));
  return filePath;
}

export function createExecutionRunRecord(input: CreateExecutionRunRecordInput): ExecutionRunRecord {
  const ts = nowIso();
  const record: ExecutionRunRecord = {
    schema_name: 'aries_execution_run',
    schema_version: '1.0.0',
    aries_run_id: `arun_${randomUUID()}`,
    provider: input.provider,
    domain: input.domain,
    workflow_key: input.workflowKey,
    action: input.action,
    tenant_id: nonEmpty(input.tenantId),
    marketing_job_id: nonEmpty(input.marketingJobId),
    approval_id: nonEmpty(input.approvalId),
    stage: input.stage ?? null,
    workflow_step_id: nonEmpty(input.workflowStepId),
    external_run_id: null,
    status: 'submitted',
    event_ids: [],
    created_at: ts,
    updated_at: ts,
    last_error: null,
    result: null,
  };
  saveExecutionRunRecord(record);
  return record;
}

export function markExecutionRunSubmitted(
  ariesRunId: string,
  input: { externalRunId?: string | null },
): ExecutionRunRecord | null {
  const record = loadExecutionRunRecord(ariesRunId);
  if (!record) {
    return null;
  }
  record.external_run_id = nonEmpty(input.externalRunId);
  if (!CALLBACK_ADVANCED_STATUSES.has(record.status)) {
    record.status = 'submitted';
  }
  saveExecutionRunRecord(record);
  return record;
}

export function markExecutionRunFailed(
  ariesRunId: string,
  error: ExecutionRunRecord['last_error'],
): ExecutionRunRecord | null {
  const record = loadExecutionRunRecord(ariesRunId);
  if (!record) {
    return null;
  }
  record.status = 'failed';
  record.last_error = error;
  saveExecutionRunRecord(record);
  return record;
}

export function hasExecutionRunEvent(ariesRunId: string, eventId: string): boolean {
  const record = loadExecutionRunRecord(ariesRunId);
  return !!record && record.event_ids.includes(eventId);
}

export function markExecutionRunEventApplied(
  ariesRunId: string,
  input: {
    eventId: string;
    status: ExecutionRunStatus;
    result?: unknown;
    error?: ExecutionRunRecord['last_error'];
    externalRunId?: string | null;
  },
): ExecutionRunRecord | null {
  const record = loadExecutionRunRecord(ariesRunId);
  if (!record) {
    return null;
  }
  if (record.event_ids.includes(input.eventId)) {
    return record;
  }

  record.event_ids.push(input.eventId);
  record.status = input.status;
  if (input.externalRunId !== undefined) {
    record.external_run_id = nonEmpty(input.externalRunId);
  }
  if (input.result !== undefined) {
    record.result = input.result;
  }
  record.last_error = input.error ?? null;
  saveExecutionRunRecord(record);
  return record;
}

function removeLockIfStale(lockPath: string, staleMs: number): void {
  try {
    const stats = statSync(lockPath);
    if ((Date.now() - stats.mtimeMs) > staleMs) {
      unlinkSync(lockPath);
    }
  } catch {}
}

export async function withExecutionRunLock<T>(
  ariesRunId: string,
  fn: () => Promise<T>,
  options: { staleMs?: number } = {},
): Promise<T> {
  const staleMs = Math.max(5_000, options.staleMs ?? 30_000);
  const lockPath = executionRunLockPath(ariesRunId);
  mkdirSync(path.dirname(lockPath), { recursive: true });
  removeLockIfStale(lockPath, staleMs);

  let fd: number | null = null;
  try {
    fd = openSync(lockPath, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') {
      throw new ExecutionRunLockError(ariesRunId);
    }
    throw error;
  }

  try {
    return await fn();
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
      try {
        unlinkSync(lockPath);
      } catch {}
    }
  }
}
