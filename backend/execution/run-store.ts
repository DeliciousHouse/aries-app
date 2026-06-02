import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { resolveDataPath } from '@/lib/runtime-paths';
import type { MarketingStage } from '@/backend/marketing/runtime-state';

export type ExecutionRunProvider = 'hermes';
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
const TERMINAL_EXECUTION_STATUSES = new Set<ExecutionRunStatus>(['completed', 'failed', 'cancelled']);

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
  /**
   * The Hermes target profile this run was SUBMITTED to (so a reconciler polls
   * the same gateway). null = default gateway (HERMES_GATEWAY_URL, e.g.
   * submitRawRun); a profile name = that per-profile gateway (invoke path).
   * Optional/absent on records written before profile persistence shipped —
   * the reconciler falls back to deriving the profile from `stage` for those.
   */
  target_profile?: string | null;
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
  // Reject anything that could escape the execution-runs directory at the
  // input boundary. `path.join` would silently normalize values like
  // `/etc/passwd` or `../foo` into a path that still resolves under root,
  // so we must inspect the raw id before joining.
  if (
    !ariesRunId
    || ariesRunId.includes('/')
    || ariesRunId.includes('\\')
    || ariesRunId.includes('\0')
    || ariesRunId === '.'
    || ariesRunId === '..'
  ) {
    throw new Error(`invalid ariesRunId: path traversal detected`);
  }
  const root = executionRunsRoot();
  const filePath = path.join(root, `${ariesRunId}.json`);
  // Defense-in-depth: resolved path must stay within the execution-runs directory.
  if (!path.resolve(filePath).startsWith(path.resolve(root) + path.sep)) {
    throw new Error(`invalid ariesRunId: path traversal detected`);
  }
  return filePath;
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

/**
 * True when the record's status is terminal (no further callbacks expected).
 * Exposed so out-of-process sweepers (e.g. the Hermes reconciler worker) can
 * filter in-flight runs without re-deriving the terminal set.
 */
export function isTerminalExecutionStatus(status: ExecutionRunStatus): boolean {
  return TERMINAL_EXECUTION_STATUSES.has(status);
}

/**
 * Enumerate execution-run records on disk. The store is one JSON file per run
 * under DATA_ROOT/generated/draft/execution-runs/<aries_run_id>.json (there is
 * no SQL index), so callers that need to scan runs — the Hermes reconciler in
 * particular — must list the directory. Unreadable / non-record files are
 * skipped silently; a missing directory yields an empty array.
 *
 * `modifiedWithinMs` bounds the cost on aged volumes: when set, a cheap
 * statSync mtime check skips files untouched since the cutoff WITHOUT the
 * readFile+JSON.parse. saveExecutionRunRecord stamps updated_at (→ mtime) on
 * every write, and a run needing reconciliation is always recent (Hermes
 * finishes in minutes; the stale-run reaper fails stalled jobs within 90 min),
 * so a generous window never skips a reconcilable run — it only avoids parsing
 * ancient terminal records every tick. This caps the hot-path cost at ~one
 * window of runs instead of O(all runs ever created). (Disk-level retention of
 * old terminal files is a separate, sign-off-gated GC.)
 */
export function listExecutionRunRecords(
  options: { modifiedWithinMs?: number } = {},
): ExecutionRunRecord[] {
  const root = executionRunsRoot();
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const cutoffMs =
    typeof options.modifiedWithinMs === 'number' && options.modifiedWithinMs > 0
      ? Date.now() - options.modifiedWithinMs
      : null;
  const records: ExecutionRunRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) {
      continue;
    }
    const ariesRunId = entry.slice(0, -'.json'.length);
    try {
      if (cutoffMs !== null) {
        const stat = statSync(path.join(root, entry));
        if (stat.mtimeMs < cutoffMs) {
          continue;
        }
      }
      const record = loadExecutionRunRecord(ariesRunId);
      if (record) {
        records.push(record);
      }
    } catch {
      // Malformed filename (path-traversal guard) or unreadable file — skip.
      continue;
    }
  }
  return records;
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
  input: { externalRunId?: string | null; targetProfile?: string | null },
): ExecutionRunRecord | null {
  const record = loadExecutionRunRecord(ariesRunId);
  if (!record) {
    return null;
  }
  record.external_run_id = nonEmpty(input.externalRunId);
  // Record which gateway the run was submitted to so a later reconcile polls the
  // same one. Only overwrite when the caller supplies it (undefined = leave as-is).
  if (input.targetProfile !== undefined) {
    record.target_profile = input.targetProfile;
  }
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
  // Terminal records are immutable — never overwrite a completed/cancelled (or
  // already-failed) run with a late failure (e.g. a reconciler/bridge race where
  // the run completed between the candidate check and the poll).
  if (TERMINAL_EXECUTION_STATUSES.has(record.status)) {
    return record;
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
    stage?: string;
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
  const currentIsTerminal = TERMINAL_EXECUTION_STATUSES.has(record.status);
  const shouldKeepCurrentStatus = (
    // Once terminal, the run record is immutable for status/result/error.
    currentIsTerminal
    // Avoid regressing from awaiting approval to running due to out-of-order callbacks.
    || (record.status === 'awaiting_approval' && input.status === 'running')
  );
  if (!shouldKeepCurrentStatus) {
    record.status = input.status;
  }
  if (input.externalRunId !== undefined) {
    record.external_run_id = nonEmpty(input.externalRunId);
  }
  if (input.result !== undefined && !shouldKeepCurrentStatus) {
    record.result = input.result;
  }
  if (input.error !== undefined && !shouldKeepCurrentStatus) {
    record.last_error = input.error ?? null;
  } else if (!shouldKeepCurrentStatus) {
    record.last_error = null;
  }
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
