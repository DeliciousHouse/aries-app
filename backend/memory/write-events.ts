import { createHash } from 'node:crypto';

import pool from '@/lib/db';
import type { TenantContext } from '@/lib/tenant-context';

import { curateFinding, isApprovalDenialReasonCode, type CurateOptions } from './curator';
import { HonchoHttpTransport } from './honcho-http-transport';
import { isHonchoEnabled, isHonchoWriteApprovalsEnabled } from './honcho-env';
import { TenantMemoryClient, type HonchoTransport, type PeerRef, type SessionRef } from './honcho-client';
import { pseudonymForUser } from './pseudonym';
import { ensureMarketingMemoryQueueJob, recordFinding } from './research-jobs';
import type { ApprovedMessage, CandidateFinding, CuratorOutcome, FindingSource } from './types';

const HONCHO_WRITE_FETCH_TIMEOUT_MS = 2000;

type MinimalTenantCtx = Pick<TenantContext, 'tenantId' | 'tenantSlug' | 'userId' | 'role'>;

export type MarketingApprovalMemoryStage = 'strategy' | 'production' | 'publish';

export type RecordApprovalHonchoEventInput = {
  tenantCtx: MinimalTenantCtx;
  memoryActorUserId: string;
  jobId: string;
  /** Phase 1 only persists strategy approvals to Honcho. */
  stage: MarketingApprovalMemoryStage;
  eventDateYmd: string;
};

export type RecordDenialHonchoEventInput = {
  tenantCtx: MinimalTenantCtx;
  memoryActorUserId: string;
  jobId: string;
  stage: MarketingApprovalMemoryStage;
  denialReasonCode?: string | null;
  eventDateYmd: string;
};

export type MarketingApprovalHonchoMirrorInput = {
  tenantCtx: MinimalTenantCtx;
  memoryActorUserId: string;
  jobId: string;
  stage: MarketingApprovalMemoryStage;
  resolution: 'approve' | 'deny';
  denialReasonCode?: string | null;
  eventDateYmd: string;
};

function fetchWithTimeout(ms: number): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    try {
      return await globalThis.fetch(input, { ...init, signal: c.signal });
    } finally {
      clearTimeout(t);
    }
  };
}

function idempotencyKey(parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

/**
 * Atomically claim an idempotency key. Returns `true` when this caller is the
 * unique winner (key inserted), `false` if another writer already claimed it.
 *
 * Uses INSERT … ON CONFLICT DO NOTHING RETURNING to atomically claim the key
 * in a single round-trip, eliminating the TOCTOU race of a separate SELECT
 * then INSERT. The table is created at startup by scripts/init-db.js — no
 * per-call DDL here.
 */
async function claimIdempotencyKey(key: string, client: typeof pool = pool): Promise<boolean> {
  const r = await client.query(
    `INSERT INTO honcho_write_idempotency_keys (key) VALUES ($1)
     ON CONFLICT (key) DO NOTHING
     RETURNING key`,
    [key],
  );
  return r.rows.length > 0;
}

function firstPartyAriesSource(): FindingSource {
  const base = (process.env.APP_BASE_URL ?? 'https://aries.example.com').replace(/\/$/, '');
  const url = `${base}/`;
  return { url, fetched_at: new Date().toISOString(), trust: 'first_party' };
}

function peerHintForDenialStage(stage: MarketingApprovalMemoryStage): 'brand' | 'policy' {
  return stage === 'strategy' ? 'brand' : 'policy';
}

function candidateToRaw(f: CandidateFinding): Record<string, unknown> {
  return {
    kind: f.kind,
    claim: f.claim,
    sources: f.sources,
    confidence: f.confidence,
    uncertainty: f.uncertainty,
    peerHint: f.peerHint,
  };
}

async function persistQueuedFinding(
  tenantId: string,
  jobId: string,
  finding: CandidateFinding,
  outcome: CuratorOutcome,
): Promise<void> {
  const queueJobId = await ensureMarketingMemoryQueueJob(tenantId, jobId);
  await recordFinding(queueJobId, candidateToRaw(finding), outcome, null);
}

async function appendHonchoApproved(args: {
  ctx: MinimalTenantCtx;
  client: TenantMemoryClient;
  peer: PeerRef;
  session: SessionRef;
  message: ApprovedMessage;
}): Promise<void> {
  await args.client.ensureWorkspace(args.ctx);
  await args.client.appendApprovedMessage({
    ctx: args.ctx,
    peer: args.peer,
    session: args.session,
    message: args.message,
  });
}

/**
 * Map a curator auto-approve outcome to a PeerRef for Honcho writes.
 *
 * Phase 1 supports only 'brand' and 'policy'. Unhandled peers throw so that
 * Phase 2/3 code that wires new peers without updating this function produces
 * a loud, visible error rather than a silent no-op.
 */
function peerRefForAutoApprove(outcome: Extract<CuratorOutcome, { decision: 'auto_approve' }>): PeerRef {
  if (outcome.peer === 'brand') return { kind: 'brand' };
  if (outcome.peer === 'policy') return { kind: 'policy' };
  throw new Error(
    `[honcho-write-events] peerRefForAutoApprove: peer '${outcome.peer}' not yet supported in Phase 1. Phase 2/3 must extend this.`,
  );
}

/**
 * Mirror a stage approval event into Honcho memory.
 *
 * All stages are valid inputs; Phase 1 scope filtering is handled by the
 * scheduler (`scheduleMarketingApprovalHonchoWrites`) before this function is
 * called, so callers should not assume stage filtering happens here.
 *
 * Phase 1: strategy approvals → Honcho `peer-brand` / `session-strategy-<jobId>`.
 */
export async function recordApprovalEvent(
  input: RecordApprovalHonchoEventInput,
  client = pool,
  opts?: { transport?: HonchoTransport },
): Promise<void> {
  if (!isHonchoEnabled() || !isHonchoWriteApprovalsEnabled()) return;
  const actor = input.memoryActorUserId?.trim();
  if (!actor) {
    console.warn('[honcho-write-events] recordApprovalEvent skipped: memoryActorUserId missing');
    return;
  }

  const userPseudonym = pseudonymForUser(actor);
  const key = idempotencyKey([input.jobId, input.stage, 'approve_strategy', userPseudonym, input.eventDateYmd]);
  const claimed = await claimIdempotencyKey(key, client);
  if (!claimed) return;

  const finding: CandidateFinding = {
    kind: 'fact',
    claim: JSON.stringify({
      event: 'strategy_stage_approved',
      research_job_id: input.jobId,
      stage: 'strategy',
    }),
    sources: [firstPartyAriesSource()],
    confidence: 0.9,
    peerHint: 'brand',
  };
  const curateOpts: CurateOptions = { jobId: input.jobId, approvedBy: userPseudonym };
  const outcome = curateFinding(finding, curateOpts);

  const transport = opts?.transport ?? new HonchoHttpTransport(process.env, fetchWithTimeout(HONCHO_WRITE_FETCH_TIMEOUT_MS));
  const mem = new TenantMemoryClient(transport);

  try {
    if (outcome.decision === 'auto_approve') {
      const peerRef = peerRefForAutoApprove(outcome);
      const session: SessionRef = { kind: 'strategy', jobId: input.jobId };
      await appendHonchoApproved({
        ctx: input.tenantCtx,
        client: mem,
        peer: peerRef,
        session,
        message: outcome.approved,
      });
      return;
    }
    if (outcome.decision === 'queue_for_review') {
      await persistQueuedFinding(String(input.tenantCtx.tenantId), input.jobId, finding, outcome);
    }
  } catch (err) {
    console.error('[honcho-write-events] recordApprovalEvent failed', err);
  }
}

/**
 * Denial → content `rejected_angle` on `peer-brand`/`peer-policy` + audit `fact` on `peer-approver-*`.
 *
 * Content and audit writes each use their own idempotency key; one can succeed
 * while the other is already claimed by a concurrent caller.
 */
export async function recordDenialEvent(
  input: RecordDenialHonchoEventInput,
  client = pool,
  opts?: { transport?: HonchoTransport },
): Promise<void> {
  if (!isHonchoEnabled() || !isHonchoWriteApprovalsEnabled()) return;
  const actor = input.memoryActorUserId?.trim();
  if (!actor) {
    console.warn('[honcho-write-events] recordDenialEvent skipped: memoryActorUserId missing');
    return;
  }

  const userPseudonym = pseudonymForUser(actor);
  const transport = opts?.transport ?? new HonchoHttpTransport(process.env, fetchWithTimeout(HONCHO_WRITE_FETCH_TIMEOUT_MS));
  const mem = new TenantMemoryClient(transport);

  const contentKey = idempotencyKey([input.jobId, input.stage, 'deny_rejected_angle', userPseudonym, input.eventDateYmd]);
  const auditKey = idempotencyKey([input.jobId, input.stage, 'deny_audit', userPseudonym, input.eventDateYmd]);

  const isoDate = new Date().toISOString().slice(0, 10);
  const reason =
    typeof input.denialReasonCode === 'string' && isApprovalDenialReasonCode(input.denialReasonCode)
      ? input.denialReasonCode
      : undefined;

  const contentClaim = JSON.stringify({
    denial_reason_code: reason,
    stage: input.stage,
    research_job_id: input.jobId,
  });

  const contentFinding: CandidateFinding = {
    kind: 'rejected_angle',
    claim: contentClaim,
    sources: [firstPartyAriesSource()],
    confidence: 0.9,
    peerHint: peerHintForDenialStage(input.stage),
  };

  const contentOpts: CurateOptions = { jobId: input.jobId, approvedBy: userPseudonym };
  const contentOutcome = curateFinding(contentFinding, contentOpts);

  const contentClaimed = await claimIdempotencyKey(contentKey, client);
  if (contentClaimed) {
    try {
      if (contentOutcome.decision === 'auto_approve') {
        const peerRef = peerRefForAutoApprove(contentOutcome);
        const session: SessionRef = { kind: 'curated', jobId: input.jobId };
        await appendHonchoApproved({
          ctx: input.tenantCtx,
          client: mem,
          peer: peerRef,
          session,
          message: contentOutcome.approved,
        });
      } else if (contentOutcome.decision === 'queue_for_review') {
        await persistQueuedFinding(String(input.tenantCtx.tenantId), input.jobId, contentFinding, contentOutcome);
      }
    } catch (err) {
      console.error('[honcho-write-events] recordDenialEvent content failed', err);
    }
  }

  const auditClaim = JSON.stringify({
    user_pseudonym: userPseudonym,
    research_job_id: input.jobId,
    stage: input.stage,
    date: isoDate,
  });
  const auditFinding: CandidateFinding = {
    kind: 'fact',
    claim: auditClaim,
    sources: [firstPartyAriesSource()],
    confidence: 0.9,
    peerHint: 'approver',
  };
  const auditOutcome = curateFinding(auditFinding, { jobId: input.jobId, approvedBy: 'system' });

  const auditClaimed = await claimIdempotencyKey(auditKey, client);
  if (auditClaimed) {
    try {
      if (auditOutcome.decision === 'auto_approve') {
        await appendHonchoApproved({
          ctx: input.tenantCtx,
          client: mem,
          peer: { kind: 'approver', userId: actor },
          session: { kind: 'curated', jobId: input.jobId },
          message: auditOutcome.approved,
        });
      } else if (auditOutcome.decision === 'queue_for_review') {
        await persistQueuedFinding(String(input.tenantCtx.tenantId), input.jobId, auditFinding, auditOutcome);
      }
    } catch (err) {
      console.error('[honcho-write-events] recordDenialEvent audit failed', err);
    }
  }
}

export function scheduleMarketingApprovalHonchoWrites(input: MarketingApprovalHonchoMirrorInput): void {
  if (!isHonchoEnabled() || !isHonchoWriteApprovalsEnabled()) return;
  if (!input.memoryActorUserId?.trim()) {
    console.warn('[honcho-write-events] schedule skipped: memoryActorUserId missing');
    return;
  }
  if (input.resolution === 'approve' && input.stage !== 'strategy') {
    // Phase 1 only mirrors strategy approvals. Production/publish approvals land in Phase 2.
    return;
  }
  setImmediate(() => {
    void (async () => {
      try {
        if (input.resolution === 'approve') {
          await recordApprovalEvent({
            tenantCtx: input.tenantCtx,
            memoryActorUserId: input.memoryActorUserId,
            jobId: input.jobId,
            stage: input.stage,
            eventDateYmd: input.eventDateYmd,
          });
        } else {
          await recordDenialEvent({
            tenantCtx: input.tenantCtx,
            memoryActorUserId: input.memoryActorUserId,
            jobId: input.jobId,
            stage: input.stage,
            denialReasonCode: input.denialReasonCode,
            eventDateYmd: input.eventDateYmd,
          });
        }
      } catch (err) {
        console.error('[honcho-write-events] scheduled flush failed', err);
      }
    })();
  });
}
