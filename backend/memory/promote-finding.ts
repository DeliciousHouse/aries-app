/**
 * backend/memory/promote-finding.ts
 *
 * S6-5 / AA-118 (gap F8) — Approve / Edit / Reject a queued memory candidate.
 *
 * Queued findings have been write-only: `recordPerformanceEvent` curates a
 * performance finding into `aries_research_findings` with
 * `curator_decision='queue_for_review'`, and the review-queue endpoint reads
 * them back — but nothing ever promoted one, so a finding sat in the queue
 * forever and never became memory the planner could use. That is the entire
 * point of `queue_for_review`, and it was missing.
 *
 * HUMAN-ONLY. There is no AI caller and no autonomous path: the route above this
 * is tenant_admin-gated, and nothing else imports these functions. AI never
 * approves its own learning (CLAUDE.md guardrail).
 *
 * Ordering, and why: the local decision is written FIRST only on reject (no
 * remote effect), but on approve the Honcho append happens first. A local flip
 * followed by a failed append would leave a finding marked approved that exists
 * nowhere — invisible in the queue and absent from memory. Appending first means
 * the worst case is a delivered memory whose local row still says
 * queue_for_review, which the operator can simply approve again; the Honcho side
 * is idempotent on its own claim key.
 */

import type { PoolClient } from 'pg';

import {
  getResearchFindingForTenant,
  setFindingCuratorDecision,
  type TenantResearchFinding,
} from './research-jobs';
import {
  appendApprovedFindingToHoncho,
  peerRefFromStoredPeer,
  topicPseudonymHexForPerformanceMemory,
} from './write-events';
import type { ApprovedMessage, FindingSource } from './types';
import type { TenantContext } from '@/lib/tenant-context';

export const PROMOTION_ACTIONS = ['approve', 'edit', 'reject'] as const;
export type PromotionAction = (typeof PROMOTION_ACTIONS)[number];

/** Bound on an operator-supplied claim. Long enough for a real finding, short
 *  enough that the memory surface cannot be used as free storage. */
export const MAX_EDITED_CLAIM_LENGTH = 2000;

export function isPromotionAction(value: unknown): value is PromotionAction {
  return typeof value === 'string' && (PROMOTION_ACTIONS as readonly string[]).includes(value);
}

export type PromotionOutcome =
  | { status: 'not_found' }
  | { status: 'invalid'; reason: string }
  | { status: 'already_resolved'; decision: string }
  | {
      status: 'ok';
      findingId: string;
      decision: 'approved' | 'rejected';
      /** False when Honcho is off or the append failed — promotion is pending. */
      memoryWritten: boolean;
    };

type Queryable = Pick<PoolClient, 'query'>;

function stringField(raw: Record<string, unknown>, key: string): string | null {
  const value = raw[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Rebuild the approved message from the STORED candidate.
 *
 * `raw` is `candidateToRaw(finding)` — {kind, claim, sources, confidence,
 * uncertainty, peerHint, metadata}. An ApprovedMessage additionally needs the
 * approver, the timestamp and the job id, which only the promotion knows.
 */
export function buildApprovedMessageFromFinding(
  finding: TenantResearchFinding,
  args: { approvedBy: string; claimOverride?: string | null; now?: Date },
): ApprovedMessage | null {
  const claim = args.claimOverride?.trim() || stringField(finding.raw, 'claim');
  if (!claim) return null;

  const kind = stringField(finding.raw, 'kind');
  if (!kind) return null;

  const sources = Array.isArray(finding.raw.sources)
    ? (finding.raw.sources as FindingSource[])
    : [];
  const confidenceRaw = Number(finding.raw.confidence);
  const confidence = Number.isFinite(confidenceRaw) ? confidenceRaw : 0.5;

  return {
    kind: kind as ApprovedMessage['kind'],
    claim,
    sources,
    confidence,
    approved_by: args.approvedBy,
    approved_at: (args.now ?? new Date()).toISOString(),
    supersedes: null,
    research_job_id: finding.job_id,
  };
}

/**
 * Topic bucket for a market-signal memory.
 *
 * The pseudonym is NOT stored on the finding, so it is re-derived from the
 * marketing job the queue row was attached to (`task_spec.marketing_job_id`,
 * written by ensureMarketingMemoryQueueJob). A finding whose original write used
 * a competitor-url hint would derive a different bucket than it did then; that
 * hint is not recoverable, and the bucket is a pseudonymous grouping rather than
 * an identifier, so re-deriving is safe — it just may not co-locate with a
 * competitor-hinted memory from the same job.
 */
export function topicPseudonymForFinding(finding: TenantResearchFinding): string | null {
  const marketingJobId =
    typeof finding.job_task_spec.marketing_job_id === 'string'
      ? finding.job_task_spec.marketing_job_id.trim()
      : '';
  const jobId = marketingJobId || finding.job_id;
  return jobId ? topicPseudonymHexForPerformanceMemory(jobId, null) : null;
}

export interface ResolveFindingInput {
  findingId: string;
  tenantCtx: Pick<TenantContext, 'tenantId' | 'tenantSlug' | 'userId' | 'role'>;
  action: PromotionAction;
  editedClaim?: string | null;
}

export interface ResolveFindingDeps {
  db?: Queryable;
  loadFinding?: typeof getResearchFindingForTenant;
  setDecision?: typeof setFindingCuratorDecision;
  appendToHoncho?: typeof appendApprovedFindingToHoncho;
  now?: Date;
}

/**
 * Resolve one queued finding. Returns a typed outcome; never throws for an
 * expected condition (missing, already settled, unusable input).
 */
export async function resolveQueuedFinding(
  input: ResolveFindingInput,
  deps: ResolveFindingDeps = {},
): Promise<PromotionOutcome> {
  const loadFinding = deps.loadFinding ?? getResearchFindingForTenant;
  const setDecision = deps.setDecision ?? setFindingCuratorDecision;
  const appendToHoncho = deps.appendToHoncho ?? appendApprovedFindingToHoncho;

  const findingId = input.findingId?.trim();
  if (!findingId) return { status: 'invalid', reason: 'missing_finding_id' };

  if (input.action === 'edit') {
    const edited = input.editedClaim?.trim() ?? '';
    if (!edited) return { status: 'invalid', reason: 'edited_claim_required' };
    if (edited.length > MAX_EDITED_CLAIM_LENGTH) {
      return { status: 'invalid', reason: 'edited_claim_too_long' };
    }
  }

  // Tenant scoping happens in the query — a finding owned by another tenant is
  // reported as not_found, never as forbidden, so its existence is not confirmed.
  const finding = await loadFinding(findingId, input.tenantCtx.tenantId, deps.db);
  if (!finding) return { status: 'not_found' };

  // Idempotent: a finding already settled reports its state and performs no
  // second Honcho write.
  if (finding.curator_decision !== 'queue_for_review') {
    return { status: 'already_resolved', decision: finding.curator_decision };
  }

  if (input.action === 'reject') {
    const changed = await setDecision(findingId, 'rejected', null, deps.db);
    if (!changed) {
      // Lost a race with a concurrent resolve; re-read to report the truth.
      const current = await loadFinding(findingId, input.tenantCtx.tenantId, deps.db);
      return { status: 'already_resolved', decision: current?.curator_decision ?? 'rejected' };
    }
    return { status: 'ok', findingId, decision: 'rejected', memoryWritten: false };
  }

  const message = buildApprovedMessageFromFinding(finding, {
    approvedBy: String(input.tenantCtx.userId ?? 'operator'),
    claimOverride: input.action === 'edit' ? input.editedClaim : null,
    now: deps.now,
  });
  if (!message) return { status: 'invalid', reason: 'finding_not_promotable' };

  const peer = peerRefFromStoredPeer(finding.peer, {
    topicPseudonym: topicPseudonymForFinding(finding),
    actorUserId: input.tenantCtx.userId ? String(input.tenantCtx.userId) : null,
  });
  if (!peer) return { status: 'invalid', reason: 'unsupported_peer' };

  // Append BEFORE the local flip — see the ordering note at the top of the file.
  const memoryWritten = await appendToHoncho({
    tenantCtx: input.tenantCtx,
    peer,
    session: { kind: 'curated', jobId: finding.job_id },
    message,
  });

  const changed = await setDecision(findingId, 'approved', null, deps.db);
  if (!changed) {
    const current = await loadFinding(findingId, input.tenantCtx.tenantId, deps.db);
    return { status: 'already_resolved', decision: current?.curator_decision ?? 'approved' };
  }

  return { status: 'ok', findingId, decision: 'approved', memoryWritten };
}
