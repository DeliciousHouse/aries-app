import { randomUUID, createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { resolveDataPath } from '@/lib/runtime-paths';
import type { MarketingPublishConfig, MarketingStage } from './runtime-state';
import type { SocialContentApprovalStep } from '@/backend/social-content/types';

export type MarketingApprovalStatus = 'pending' | 'approved' | 'denied' | 'consumed' | 'expired' | 'failed';

export type MarketingApprovalResolution = 'approve' | 'deny';

export type MarketingApprovalRecord = {
  schema_name: 'marketing_approval_record';
  schema_version: '1.0.0';
  approval_id: string;
  tenant_id: string;
  marketing_job_id: string;
  workflow_name: string;
  workflow_step_id: string;
  social_content_approval_step: SocialContentApprovalStep | null;
  marketing_stage: Extract<MarketingStage, 'strategy' | 'production' | 'publish'>;
  execution_provider: 'hermes';
  execution_resume_token: string;
  execution_resume_token_fingerprint: string;
  execution_resume_state_keys: string[];
  approval_prompt: string;
  approval_preview_payload: unknown | null;
  runtime_context: {
    pipeline_path: string;
    cwd: string;
    state_dir: string | null;
    session_key: string;
    gateway_url: string | null;
  };
  publish_config: MarketingPublishConfig | null;
  /**
   * Tracks which platforms have already consumed this approval.
   * Used for multi-platform publish flows so each platform can independently
   * claim the approval without blocking the other.
   * When all platforms from publish_config.live_publish_platforms are consumed,
   * status is also flipped to 'consumed'.
   */
  consumed_platforms: string[];
  status: MarketingApprovalStatus;
  resolution: MarketingApprovalResolution | null;
  resolved_at: string | null;
  attempt_count: number;
  correlation_id: string;
  trace_id: string;
  last_error: {
    code: string;
    message: string;
    at: string;
  } | null;
  resolution_result: {
    resumed_stage: MarketingStage | null;
    completed: boolean;
    outcome: string | null;
    /** Present when resolution was deny; stored in Aries only, not sent to Honcho. */
    denial_reason_code?: string | null;
    denial_note?: string | null;
  } | null;
  created_at: string;
  updated_at: string;
};

export class MarketingApprovalLockError extends Error {
  code = 'approval_locked' as const;
  approvalId: string;

  constructor(approvalId: string) {
    super(`approval ${approvalId} is already being resolved`);
    this.name = 'MarketingApprovalLockError';
    this.approvalId = approvalId;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function approvalsRoot(): string {
  return resolveDataPath('generated', 'draft', 'marketing-approvals');
}

export function marketingApprovalPath(approvalId: string): string {
  return path.join(approvalsRoot(), `${approvalId}.json`);
}

function approvalLockPath(approvalId: string): string {
  return `${marketingApprovalPath(approvalId)}.lock`;
}

export function fingerprintApprovalToken(token: string): string {
  return createHash('sha1').update(token).digest('hex').slice(0, 12);
}

export function createMarketingApprovalRecord(input: {
  approvalId?: string;
  tenantId: string;
  marketingJobId: string;
  workflowName: string;
  workflowStepId: string;
  socialContentApprovalStep?: SocialContentApprovalStep | null;
  marketingStage: Extract<MarketingStage, 'strategy' | 'production' | 'publish'>;
  executionResumeToken?: string;
  executionResumeStateKeys?: string[];
  approvalPrompt: string;
  approvalPreviewPayload?: unknown;
  runtimeContext: {
    pipelinePath: string;
    cwd: string;
    stateDir?: string | null;
    sessionKey: string;
    gatewayUrl?: string | null;
  };
  publishConfig?: MarketingPublishConfig | null;
  correlationId?: string;
  traceId?: string;
}): MarketingApprovalRecord {
  const ts = nowIso();
  const executionResumeToken = input.executionResumeToken ?? '';
  const executionResumeStateKeys = input.executionResumeStateKeys ?? [];
  const tokenFingerprint = fingerprintApprovalToken(executionResumeToken);
  return {
    schema_name: 'marketing_approval_record',
    schema_version: '1.0.0',
    approval_id: input.approvalId?.trim() || `mkta_${randomUUID()}`,
    tenant_id: input.tenantId,
    marketing_job_id: input.marketingJobId,
    workflow_name: input.workflowName,
    workflow_step_id: input.workflowStepId,
    social_content_approval_step: input.socialContentApprovalStep ?? null,
    marketing_stage: input.marketingStage,
    execution_provider: 'hermes',
    execution_resume_token: executionResumeToken,
    execution_resume_token_fingerprint: tokenFingerprint,
    execution_resume_state_keys: executionResumeStateKeys,
    approval_prompt: input.approvalPrompt,
    approval_preview_payload: input.approvalPreviewPayload ?? null,
    runtime_context: {
      pipeline_path: input.runtimeContext.pipelinePath,
      cwd: input.runtimeContext.cwd,
      state_dir: input.runtimeContext.stateDir ?? null,
      session_key: input.runtimeContext.sessionKey,
      gateway_url: input.runtimeContext.gatewayUrl ?? null,
    },
    publish_config: input.publishConfig ?? null,
    consumed_platforms: [],
    status: 'pending',
    resolution: null,
    resolved_at: null,
    attempt_count: 0,
    correlation_id: input.correlationId?.trim() || randomUUID(),
    trace_id: input.traceId?.trim() || randomUUID(),
    last_error: null,
    resolution_result: null,
    created_at: ts,
    updated_at: ts,
  };
}

function isApprovalRecord(value: unknown): value is MarketingApprovalRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && (value as { schema_name?: unknown }).schema_name === 'marketing_approval_record'
    && typeof (value as { approval_id?: unknown }).approval_id === 'string'
    && typeof (value as { marketing_job_id?: unknown }).marketing_job_id === 'string'
    && typeof (value as { tenant_id?: unknown }).tenant_id === 'string';
}

function normalizeMarketingApprovalRecord(record: MarketingApprovalRecord): MarketingApprovalRecord {
  // Records persisted before the Hermes-only cutover may carry pre-migration
  // resume token field names. Read them defensively so old approval rows load.
  const legacy = record as unknown as {
    lobster_resume_token?: unknown;
    lobster_resume_token_fingerprint?: unknown;
    lobster_resume_state_keys?: unknown;
  };
  const legacyToken = typeof legacy.lobster_resume_token === 'string' ? legacy.lobster_resume_token : '';
  const token = typeof record.execution_resume_token === 'string'
    ? record.execution_resume_token
    : legacyToken;
  const stateKeys = Array.isArray(record.execution_resume_state_keys)
    ? record.execution_resume_state_keys
    : Array.isArray(legacy.lobster_resume_state_keys)
      ? (legacy.lobster_resume_state_keys as string[])
      : [];
  const fingerprint = typeof record.execution_resume_token_fingerprint === 'string'
    ? record.execution_resume_token_fingerprint
    : typeof legacy.lobster_resume_token_fingerprint === 'string'
      ? legacy.lobster_resume_token_fingerprint
      : fingerprintApprovalToken(token);

  record.execution_provider = 'hermes';
  record.execution_resume_token = token;
  record.execution_resume_token_fingerprint = fingerprint;
  record.execution_resume_state_keys = stateKeys;
  // Backfill consumed_platforms for records created before this field existed.
  if (!Array.isArray(record.consumed_platforms)) {
    record.consumed_platforms = [];
  }
  if (
    record.social_content_approval_step !== 'approve_weekly_plan'
    && record.social_content_approval_step !== 'approve_post_copy'
    && record.social_content_approval_step !== 'approve_image_creatives'
    && record.social_content_approval_step !== 'approve_video_script'
    && record.social_content_approval_step !== 'approve_video_render'
    && record.social_content_approval_step !== 'approve_publish'
  ) {
    record.social_content_approval_step = null;
  }
  return record;
}

export function loadMarketingApprovalRecord(approvalId: string): MarketingApprovalRecord | null {
  const filePath = marketingApprovalPath(approvalId);
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    if (!isApprovalRecord(parsed)) {
      return null;
    }
    return normalizeMarketingApprovalRecord(parsed);
  } catch {
    return null;
  }
}

export function saveMarketingApprovalRecord(record: MarketingApprovalRecord): string {
  const filePath = marketingApprovalPath(record.approval_id);
  mkdirSync(path.dirname(filePath), { recursive: true });
  record.updated_at = nowIso();
  writeFileSync(filePath, JSON.stringify(record, null, 2));
  return filePath;
}

export function listMarketingApprovalRecordsForJob(marketingJobId: string): MarketingApprovalRecord[] {
  const root = approvalsRoot();
  if (!existsSync(root)) {
    return [];
  }

  const records: MarketingApprovalRecord[] = [];
  for (const entry of readdirSync(root)) {
    if (!entry.endsWith('.json')) {
      continue;
    }
    const record = loadMarketingApprovalRecord(path.basename(entry, '.json'));
    if (!record || record.marketing_job_id !== marketingJobId) {
      continue;
    }
    records.push(record);
  }

  return records.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
}

export function findLatestMarketingApprovalRecord(input: {
  marketingJobId: string;
  tenantId?: string;
  approvalId?: string | null;
  workflowStepId?: string | null;
  marketingStage?: Extract<MarketingStage, 'strategy' | 'production' | 'publish'> | null;
  statuses?: MarketingApprovalStatus[];
}): MarketingApprovalRecord | null {
  if (input.approvalId?.trim()) {
    const record = loadMarketingApprovalRecord(input.approvalId.trim());
    if (!record) {
      return null;
    }
    if (input.tenantId && record.tenant_id !== input.tenantId) {
      return null;
    }
    return record;
  }

  const statuses = input.statuses ? new Set(input.statuses) : null;
  return listMarketingApprovalRecordsForJob(input.marketingJobId).find((record) => {
    if (input.tenantId && record.tenant_id !== input.tenantId) {
      return false;
    }
    if (input.workflowStepId && record.workflow_step_id !== input.workflowStepId) {
      return false;
    }
    if (input.marketingStage && record.marketing_stage !== input.marketingStage) {
      return false;
    }
    if (statuses && !statuses.has(record.status)) {
      return false;
    }
    return true;
  }) ?? null;
}

export function mutateMarketingApprovalRecord(
  approvalId: string,
  mutate: (record: MarketingApprovalRecord) => MarketingApprovalRecord | void,
): MarketingApprovalRecord | null {
  const existing = loadMarketingApprovalRecord(approvalId);
  if (!existing) {
    return null;
  }
  const next = mutate(existing) ?? existing;
  saveMarketingApprovalRecord(next);
  return next;
}

function removeLockIfStale(lockPath: string, staleMs: number): void {
  try {
    const stats = statSync(lockPath);
    if ((Date.now() - stats.mtimeMs) > staleMs) {
      unlinkSync(lockPath);
    }
  } catch {}
}

/**
 * Roll back a single platform's claim on a publish approval record.
 *
 * The publish handlers claim a platform in `consumed_platforms[]` before the
 * Meta publish call so two concurrent requests can't double-post. When the
 * publish call itself fails, that claim would otherwise be stuck forever and
 * permanently block a retry of that platform. This helper reverses the claim:
 * it removes the platform from `consumed_platforms` and, if this platform's
 * claim had flipped the whole record to 'consumed' (i.e. it was the last
 * platform), restores the record to 'approved' so the retry can proceed.
 *
 * Idempotent: a no-op when the platform is not currently claimed.
 */
export async function releaseMarketingApprovalPlatformClaim(
  approvalId: string,
  platformKey: string,
): Promise<void> {
  await withMarketingApprovalLock(approvalId, async () => {
    const record = loadMarketingApprovalRecord(approvalId);
    if (!record || !record.consumed_platforms.includes(platformKey)) {
      return;
    }
    record.consumed_platforms = record.consumed_platforms.filter((p) => p !== platformKey);
    // If this platform was the last to publish, its claim had flipped the
    // record to 'consumed'. Restore it so the remaining publish can retry.
    if (record.status === 'consumed') {
      record.status = 'approved';
      record.resolved_at = null;
    }
    saveMarketingApprovalRecord(record);
  });
}

export async function withMarketingApprovalLock<T>(
  approvalId: string,
  fn: () => Promise<T>,
  options: { staleMs?: number } = {},
): Promise<T> {
  const staleMs = Math.max(5_000, options.staleMs ?? 30_000);
  const lockPath = approvalLockPath(approvalId);
  mkdirSync(path.dirname(lockPath), { recursive: true });
  removeLockIfStale(lockPath, staleMs);

  let fd: number | null = null;
  try {
    fd = openSync(lockPath, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') {
      throw new MarketingApprovalLockError(approvalId);
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
      try {
        rmSync(lockPath, { force: true });
      } catch {}
    }
  }
}
