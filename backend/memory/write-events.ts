import { createHash } from 'node:crypto';

import pool from '@/lib/db';
import type { TenantContext } from '@/lib/tenant-context';

import type { SocialContentJobRuntimeDocument } from '@/backend/marketing/runtime-state';

import { curateFinding, type CurateOptions } from './curator';
import { isApprovalDenialReasonCode } from '@/lib/marketing/approval-denial-reason-codes';
import { observationHorizonLabel } from './insights-513-contract';
import { HonchoHttpTransport } from './honcho-http-transport';
import {
  isHonchoEnabled,
  isHonchoWriteApprovalsEnabled,
  isHonchoWritePreferencesEnabled,
  isHonchoWritePublishEnabled,
} from './honcho-env';
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

/**
 * How long a performance lease may sit before another tick may take it over.
 *
 * A process killed between the lease and the append (OOM, deploy, SIGKILL)
 * leaves no completion marker behind. The mutable lease is operational state,
 * separate from the append-only `honcho_write_idempotency_keys` completion
 * ledger, so it may be released or taken over without mutating Honcho records.
 *
 * Two worker ticks (30 min each). Long enough that a slow-but-live append is
 * never stolen mid-flight; short enough that a crash costs one extra cycle
 * rather than the observation.
 */
const PERFORMANCE_CLAIM_LEASE_MS = 60 * 60 * 1000;

type PerformanceClaimDisposition = 'acquired' | 'completed' | 'in_flight';

/**
 * Atomically acquire a performance-write lease unless the completion ledger
 * already contains the key or another live writer owns the lease.
 *
 * The successful lease row is intentionally retained after completion. It
 * closes a snapshot race where a concurrent caller can observe neither a just-
 * committed completion nor a just-deleted lease and append twice.
 */
async function claimPerformanceWrite(
  key: string,
  client: typeof pool = pool,
): Promise<PerformanceClaimDisposition> {
  const result = await client.query(
    `WITH acquired AS (
       INSERT INTO memory_write_claim_leases (key, claimed_at)
       SELECT $1, NOW()
        WHERE NOT EXISTS (
          SELECT 1 FROM honcho_write_idempotency_keys WHERE key = $1
        )
       ON CONFLICT (key) DO UPDATE
         SET claimed_at = EXCLUDED.claimed_at
       WHERE memory_write_claim_leases.claimed_at
             < NOW() - ($2::bigint * INTERVAL '1 millisecond')
       RETURNING key
     )
     SELECT CASE
       WHEN EXISTS (SELECT 1 FROM honcho_write_idempotency_keys WHERE key = $1)
         THEN 'completed'
       WHEN EXISTS (SELECT 1 FROM acquired)
         THEN 'acquired'
       ELSE 'in_flight'
     END AS disposition`,
    [key, PERFORMANCE_CLAIM_LEASE_MS],
  );
  const disposition = result.rows[0]?.disposition;
  return disposition === 'completed' || disposition === 'acquired' ? disposition : 'in_flight';
}

/**
 * Append a final completion marker after the Honcho write succeeds.
 *
 * If this fails after a successful append, the caller still returns `appended`
 * and the worker still ledgers, so nothing is lost. The only cost is that a
 * later re-drive after the lease expires could append the observation twice.
 * A duplicate observation is visible and harmless; a dropped one is silent and
 * permanent — so this failure leans the safe way.
 */
async function completePerformanceWrite(key: string, client: typeof pool = pool): Promise<void> {
  try {
    await client.query(
      `INSERT INTO honcho_write_idempotency_keys (key) VALUES ($1)
       ON CONFLICT (key) DO NOTHING`,
      [key],
    );
  } catch (err) {
    console.error('[honcho-write-events] failed to mark idempotency key completed after a successful write', err);
  }
}

/** Release only the mutable operational lease after a caught append failure. */
async function releasePerformanceClaim(key: string, client: typeof pool = pool): Promise<void> {
  try {
    await client.query('DELETE FROM memory_write_claim_leases WHERE key = $1', [key]);
  } catch (err) {
    console.error('[honcho-write-events] failed to release performance lease after write failure', err);
  }
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
    metadata: f.metadata,
  };
}

async function persistQueuedFinding(
  tenantId: string,
  jobId: string,
  finding: CandidateFinding,
  outcome: CuratorOutcome,
  client: typeof pool = pool,
): Promise<void> {
  const queueJobId = await ensureMarketingMemoryQueueJob(tenantId, jobId, client);
  await recordFinding(queueJobId, candidateToRaw(finding), outcome, null, client);
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
function peerRefForAutoApprove(
  outcome: Extract<CuratorOutcome, { decision: 'auto_approve' }>,
  ctx?: { preferenceActorUserId?: string },
): PeerRef {
  if (outcome.peer === 'brand') return { kind: 'brand' };
  if (outcome.peer === 'policy') return { kind: 'policy' };
  if (outcome.peer === 'user') {
    const actor = ctx?.preferenceActorUserId?.trim();
    if (!actor) {
      throw new Error(
        `[honcho-write-events] peerRefForAutoApprove: peer 'user' requires preferenceActorUserId (Phase 3).`,
      );
    }
    return { kind: 'user', userId: actor };
  }
  throw new Error(
    `[honcho-write-events] peerRefForAutoApprove: peer '${outcome.peer}' not yet supported for Honcho append.`,
  );
}

/**
 * S6-5 / AA-118 — PeerRef for a peer kind read back off a STORED finding.
 *
 * `peerRefForAutoApprove` above cannot be reused: it takes an auto-approve
 * outcome, and it does not handle `market_signal` — which is exactly the peer
 * every performance finding carries (`curator.ts` maps `research_conclusion` →
 * `market_signal`). Promotion needs the inverse direction: a stored peer string
 * plus the topic it belongs to.
 */
export function peerRefFromStoredPeer(
  peer: string | null,
  opts: { topicPseudonym?: string | null; actorUserId?: string | null } = {},
): PeerRef | null {
  switch (peer) {
    case 'brand':
      return { kind: 'brand' };
    case 'policy':
      return { kind: 'policy' };
    case 'market_signal': {
      const topic = opts.topicPseudonym?.trim();
      // Without a topic the memory would have no bucket to live in; refuse
      // rather than invent one, so the caller can skip cleanly.
      return topic ? { kind: 'market_signal', topicPseudonym: topic } : null;
    }
    case 'user': {
      const actor = opts.actorUserId?.trim();
      return actor ? { kind: 'user', userId: actor } : null;
    }
    default:
      return null;
  }
}

/**
 * S6-5 / AA-118 — append an operator-approved finding to Honcho memory.
 *
 * The promotion route's one Honcho call. It lives HERE, beside the auto-approve
 * paths, so transport + client construction stays in the module that already
 * owns that pattern instead of being reassembled in a route handler.
 *
 * Self-gates on `isHonchoEnabled()`: with Honcho off this returns `false` and
 * the caller still flips the local decision, recording that the remote
 * promotion is pending rather than failing the operator's click.
 *
 * Never throws — a Honcho outage must not cost the operator their decision.
 */
export async function appendApprovedFindingToHoncho(input: {
  tenantCtx: MinimalTenantCtx;
  peer: PeerRef;
  session: SessionRef;
  message: ApprovedMessage;
  transport?: HonchoTransport;
}): Promise<boolean> {
  if (!isHonchoEnabled()) return false;
  try {
    const transport =
      input.transport ??
      new HonchoHttpTransport(process.env, fetchWithTimeout(HONCHO_WRITE_FETCH_TIMEOUT_MS));
    await appendHonchoApproved({
      ctx: input.tenantCtx,
      client: new TenantMemoryClient(transport),
      peer: input.peer,
      session: input.session,
      message: input.message,
    });
    return true;
  } catch (err) {
    console.error('[honcho-write-events] appendApprovedFindingToHoncho failed', err);
    return false;
  }
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
  if (input.stage !== 'strategy') {
    // Phase 1 only mirrors strategy approvals. Production/publish approvals
    // are handled by their own writers (Phase 2+) — refuse here so callers
    // cannot mislabel non-strategy events as `strategy_stage_approved`.
    return;
  }
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
      const peerRef = peerRefForAutoApprove(outcome, undefined);
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
      await persistQueuedFinding(String(input.tenantCtx.tenantId), input.jobId, finding, outcome, client);
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

  // eventDateYmd is YYYYMMDD — convert to YYYY-MM-DD for the audit record so the
  // audit date aligns with the idempotency key date across timezones and delayed flushes.
  const isoDate = /^\d{8}$/.test(input.eventDateYmd)
    ? `${input.eventDateYmd.slice(0, 4)}-${input.eventDateYmd.slice(4, 6)}-${input.eventDateYmd.slice(6, 8)}`
    : (console.warn('[honcho-write-events] eventDateYmd format unexpected, falling back to now'), new Date().toISOString().slice(0, 10));
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
        const peerRef = peerRefForAutoApprove(contentOutcome, undefined);
        const session: SessionRef = { kind: 'curated', jobId: input.jobId };
        await appendHonchoApproved({
          ctx: input.tenantCtx,
          client: mem,
          peer: peerRef,
          session,
          message: contentOutcome.approved,
        });
      } else if (contentOutcome.decision === 'queue_for_review') {
        await persistQueuedFinding(String(input.tenantCtx.tenantId), input.jobId, contentFinding, contentOutcome, client);
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
        await persistQueuedFinding(String(input.tenantCtx.tenantId), input.jobId, auditFinding, auditOutcome, client);
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

// ---------------------------------------------------------------------------
// Phase 2 — publish verification, schedule, Hermes publish performance
// ---------------------------------------------------------------------------

/** Stable hex pseudonym for `peer-market-signal-*` (Honcho peer id constraint). */
export function topicPseudonymHexForPerformanceMemory(jobId: string, competitorUrl?: string | null): string {
  const hint =
    typeof competitorUrl === 'string' && competitorUrl.trim().length > 0
      ? competitorUrl.trim()
      : `aries-job-topic:${jobId}`;
  return createHash('sha256').update(hint).digest('hex').slice(0, 32);
}

function publishVerificationThirdPartySource(provider: string): FindingSource {
  const raw = (process.env.META_GRAPH_API_VERSION || 'v21.0').trim();
  const ver = raw.startsWith('v') ? raw : `v${raw}`;
  const p = String(provider || 'facebook').toLowerCase();
  const base =
    p === 'instagram' || p === 'facebook' || p === 'meta'
      ? `https://graph.facebook.com/${ver}/`
      : `https://publish.local/platform/${encodeURIComponent(p)}`;
  return { url: base, fetched_at: new Date().toISOString(), trust: 'third_party' };
}

const PERF_SOURCE_KEYS = ['source_url', 'permalink', 'insights_url', 'metrics_url', 'canonical_url'] as const;

/**
 * Strip platform post identifiers from Hermes performance payloads before the curator.
 * Exported for unit tests (plan V11 scrub assertion).
 */
export function scrubPlatformIdsFromPerformancePayload(input: Record<string, unknown>): Record<string, unknown> {
  const stripKey = (k: string) => {
    const l = k.toLowerCase();
    return (
      l === 'platform_post_id'
      || l === 'post_id'
      || l === 'fb_post_id'
      || l === 'instagram_media_id'
      || l.endsWith('_post_id')
      || l.includes('platform_post')
    );
  };

  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      const o = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(o)) {
        if (stripKey(k)) continue;
        out[k] = walk(v);
      }
      return out;
    }
    if (typeof value === 'string' && /^\d{10,20}$/.test(value.trim())) {
      return '[redacted_numeric_id]';
    }
    return value;
  };

  const walked = walk(input) as Record<string, unknown>;
  return walked && typeof walked === 'object' && !Array.isArray(walked) ? walked : {};
}

export function extractPerformanceMetricsSourceUrl(input: Record<string, unknown>): string | null {
  for (const key of PERF_SOURCE_KEYS) {
    const v = input[key];
    if (typeof v === 'string' && /^https:\/\//i.test(v.trim())) {
      return v.trim();
    }
  }
  const nested = input.metrics;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return extractPerformanceMetricsSourceUrl(nested as Record<string, unknown>);
  }
  return null;
}

/**
 * Resolve `organizations.slug` for a tenant id, falling back to `tenant-<id>`.
 *
 * Exported for the autonomous auto-approve path (hermes-callbacks): the Honcho
 * approval mirror is guarded on a truthy `tenantSlug`, so an AI-driven approval
 * that omits it silently drops the approval half of the brand profile.
 */
export async function resolveTenantSlugForMemoryWrite(tenantId: string, client: typeof pool): Promise<string> {
  const id = Number.parseInt(tenantId, 10);
  if (!Number.isFinite(id) || id < 1) {
    return `tenant-${tenantId}`;
  }
  const r = await client.query<{ slug: string }>('SELECT slug FROM organizations WHERE id = $1 LIMIT 1', [id]);
  const slug = r.rows[0]?.slug?.trim();
  return slug && slug.length > 0 ? slug : `tenant-${tenantId}`;
}

export type RecordPublishVerificationHonchoWriteInput = {
  tenantCtx: MinimalTenantCtx;
  jobId: string;
  platform: string;
  /** UTC calendar day of publish verification (YYYYMMDD). */
  publishedAtYmd: string;
};

/**
 * Third-party publish verification succeeded → `constraint` on `peer-policy`, queued for review.
 */
export async function recordPublishEvent(
  input: RecordPublishVerificationHonchoWriteInput,
  client = pool,
  opts?: { transport?: HonchoTransport },
): Promise<void> {
  if (!isHonchoEnabled() || !isHonchoWritePublishEnabled()) return;
  const jobId = input.jobId?.trim();
  if (!jobId) {
    console.warn('[honcho-write-events] recordPublishEvent skipped: jobId missing');
    return;
  }
  const platform = String(input.platform || 'unknown').toLowerCase();
  const ymd = input.publishedAtYmd?.trim();
  if (!ymd || !/^\d{8}$/.test(ymd)) {
    console.warn('[honcho-write-events] recordPublishEvent skipped: invalid publishedAtYmd');
    return;
  }

  const key = idempotencyKey([jobId, 'publish_verification', platform, ymd]);
  const claimed = await claimIdempotencyKey(key, client);
  if (!claimed) return;

  const claim = JSON.stringify({
    event: 'publish_platform_verified',
    research_job_id: jobId,
    provider: platform,
  });
  const finding: CandidateFinding = {
    kind: 'constraint',
    claim,
    sources: [publishVerificationThirdPartySource(platform)],
    confidence: 0.88,
    peerHint: 'policy',
  };
  const outcome = curateFinding(finding, { jobId, approvedBy: 'system' });
  const transport = opts?.transport ?? new HonchoHttpTransport(process.env, fetchWithTimeout(HONCHO_WRITE_FETCH_TIMEOUT_MS));
  const mem = new TenantMemoryClient(transport);

  try {
    if (outcome.decision === 'queue_for_review') {
      await persistQueuedFinding(String(input.tenantCtx.tenantId), jobId, finding, outcome, client);
      return;
    }
    if (outcome.decision === 'auto_approve') {
      const peerRef = peerRefForAutoApprove(outcome, undefined);
      await appendHonchoApproved({
        ctx: input.tenantCtx,
        client: mem,
        peer: peerRef,
        session: { kind: 'curated', jobId },
        message: outcome.approved,
      });
    }
  } catch (err) {
    console.error('[honcho-write-events] recordPublishEvent failed', err);
  }
}

export function schedulePublishVerificationHonchoWrite(input: RecordPublishVerificationHonchoWriteInput): void {
  if (!isHonchoEnabled() || !isHonchoWritePublishEnabled()) return;
  setImmediate(() => {
    void (async () => {
      try {
        await recordPublishEvent(input);
      } catch (err) {
        console.error('[honcho-write-events] scheduled recordPublishEvent failed', err);
      }
    })();
  });
}

export type RecordScheduledPostHonchoWriteInput = {
  tenantCtx: MinimalTenantCtx;
  jobId: string;
  postId: string;
  platforms: string[];
  /** ISO 8601 scheduled time (used for idempotency day). */
  scheduledForIso: string;
};

/**
 * Operator scheduled a post → first-party `constraint` on `peer-policy`, auto-approved.
 */
export async function recordScheduleEvent(
  input: RecordScheduledPostHonchoWriteInput,
  client = pool,
  opts?: { transport?: HonchoTransport },
): Promise<void> {
  if (!isHonchoEnabled() || !isHonchoWritePublishEnabled()) return;
  const jobId = input.jobId?.trim();
  const postId = input.postId?.trim();
  if (!jobId || !postId) {
    console.warn('[honcho-write-events] recordScheduleEvent skipped: jobId or postId missing');
    return;
  }
  const day = input.scheduledForIso?.trim().slice(0, 10).replace(/-/g, '');
  if (!day || day.length !== 8) {
    console.warn('[honcho-write-events] recordScheduleEvent skipped: invalid scheduledForIso');
    return;
  }
  const platformsKey = [...input.platforms].map(p => String(p).toLowerCase()).sort().join(',');
  const key = idempotencyKey([jobId, 'schedule_post', postId, day, platformsKey]);
  const claimed = await claimIdempotencyKey(key, client);
  if (!claimed) return;

  const claim = JSON.stringify({
    event: 'social_post_scheduled',
    research_job_id: jobId,
    post_id: postId,
    platforms: input.platforms,
  });
  const finding: CandidateFinding = {
    kind: 'constraint',
    claim,
    sources: [firstPartyAriesSource()],
    confidence: 0.9,
    peerHint: 'policy',
  };
  const outcome = curateFinding(finding, { jobId, approvedBy: 'system' });
  const transport = opts?.transport ?? new HonchoHttpTransport(process.env, fetchWithTimeout(HONCHO_WRITE_FETCH_TIMEOUT_MS));
  const mem = new TenantMemoryClient(transport);

  try {
    if (outcome.decision === 'auto_approve') {
      const peerRef = peerRefForAutoApprove(outcome, undefined);
      await appendHonchoApproved({
        ctx: input.tenantCtx,
        client: mem,
        peer: peerRef,
        session: { kind: 'curated', jobId },
        message: outcome.approved,
      });
      return;
    }
    if (outcome.decision === 'queue_for_review') {
      await persistQueuedFinding(String(input.tenantCtx.tenantId), jobId, finding, outcome, client);
    }
  } catch (err) {
    console.error('[honcho-write-events] recordScheduleEvent failed', err);
  }
}

export function scheduleScheduledPostHonchoWrite(input: RecordScheduledPostHonchoWriteInput): void {
  if (!isHonchoEnabled() || !isHonchoWritePublishEnabled()) return;
  setImmediate(() => {
    void (async () => {
      try {
        await recordScheduleEvent(input);
      } catch (err) {
        console.error('[honcho-write-events] scheduled recordScheduleEvent failed', err);
      }
    })();
  });
}

export type RecordPublishPerformanceHonchoWriteInput = {
  tenantCtx: MinimalTenantCtx;
  jobId: string;
  /**
   * Legacy field from the market-signal design. Unused: observations are
   * written to `peer-brand` so the deriver folds them into the representation
   * the brand-profile dialectic reads back. Kept optional so the older Hermes
   * callback caller compiles unchanged.
   */
  topicPseudonymHex?: string;
  /** The post's UTC publish day (YYYYMMDD). */
  publishedAtYmd: string;
  /**
   * Horizon ANCHOR day (publish day + 1|7|28, YYYYMMDD) — the observation this
   * write represents. Folded into the idempotency key so each horizon writes
   * exactly once. Defaults to `publishedAtYmd` (single-shot) when absent, which
   * is the behaviour the legacy Hermes-callback caller wants.
   */
  observationDayYmd?: string;
  /** 1 | 7 | 28 — rendered as "24h"/"7d"/"28d" in the observation prose. */
  horizonDays?: number;
  platform: string;
  /** Metrics payload (from buildPerformancePayloadRecord, or a Hermes output record). */
  payloadRecord: Record<string, unknown> | null;
};

/**
 * What `recordPerformanceEvent` actually did. The worker ledgers ONLY on
 * `appended` / `skipped_idempotent`; anything else must stay due so the next
 * tick retries it.
 *
 * `skipped_idempotent` therefore carries a strong promise: the observation is
 * in Honcho. It is returned only for a key in the append-only completion
 * ledger, never for an operational lease by itself.
 */
export type RecordPerformanceOutcome =
  | 'appended'
  | 'skipped_idempotent'
  | 'skipped_gated'
  | 'skipped_invalid'
  | 'failed';

/** Metric keys we render, in display order, mapped to their prose label. */
const OBSERVATION_METRIC_LABELS: ReadonlyArray<readonly [string, string]> = [
  ['reach', 'reach'],
  ['views', 'views'],
  ['likes', 'likes'],
  ['comments', 'comments'],
  ['shares', 'shares'],
  ['saves', 'saves'],
];

/**
 * Render a performance observation as PLAIN PROSE.
 *
 * Deliberately not JSON: Honcho's deriver builds a peer's working
 * representation from message content, and a serialized blob derives into
 * nothing a dialectic query can answer with. Sentences are the interface.
 */
export function formatPerformanceObservation(input: {
  platform: string;
  mediaType: string | null;
  publishedAtYmd: string;
  horizonLabel: string | null;
  metrics: Record<string, unknown>;
  captionExcerpt: string | null;
  sourceUrl: string;
}): string {
  const parts: string[] = [];
  for (const [key, label] of OBSERVATION_METRIC_LABELS) {
    const v = input.metrics[key];
    if (typeof v === 'number' && Number.isFinite(v)) parts.push(`${label} ${v}`);
  }
  const descriptor = [input.platform, input.mediaType].filter(Boolean).join(' ');
  const when = input.horizonLabel ? `, measured ${input.horizonLabel} after publish` : '';
  const head =
    `Post performance observation (${descriptor}, published ${input.publishedAtYmd}${when}): `
    + (parts.length > 0 ? `${parts.join(', ')}.` : 'no metrics reported.');
  const caption = input.captionExcerpt ? ` Caption excerpt: "${input.captionExcerpt}".` : '';
  return `${head}${caption} Source: ${input.sourceUrl}`;
}

/** YYYYMMDD → YYYY-MM-DD. Callers validate the format first. */
function dashYmd(ymd: string): string {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

/**
 * A published post's real measured performance → a prose observation on
 * `peer-brand` / `session-performance-<jobId>`.
 *
 * WHY NOT THE CURATOR: the previous version curated this as a
 * `research_conclusion`, and `curator.shouldQueueForReview` returns true for
 * every `research_conclusion` unconditionally — so the write always landed in
 * the review queue and NEVER reached Honcho. Not once. The curator exists to
 * gate LLM-EXTRACTED claims about the outside world; these are deterministic
 * first-party numbers out of our own `insights_*` tables, joined to our own
 * `posts` rows. They need scrubbing (done — platform ids stripped, caption
 * token-redacted), not human adjudication.
 *
 * Writing prose onto `peer-brand` is what closes the loop:
 *   observation → deriver → peer representation → dialectic query →
 *   "Brand memory" block in the strategy prompt.
 *
 * Fail-open: every failure path returns an outcome instead of throwing, and a
 * failed append releases its operational lease so the next tick retries.
 */
export async function recordPerformanceEvent(
  input: RecordPublishPerformanceHonchoWriteInput,
  client = pool,
  opts?: { transport?: HonchoTransport },
): Promise<RecordPerformanceOutcome> {
  if (!isHonchoEnabled() || !isHonchoWritePublishEnabled()) return 'skipped_gated';
  const jobId = input.jobId?.trim();
  if (!jobId) return 'skipped_invalid';
  const ymd = input.publishedAtYmd?.trim();
  if (!ymd || !/^\d{8}$/.test(ymd)) {
    console.warn('[honcho-write-events] recordPerformanceEvent skipped: invalid publishedAtYmd');
    return 'skipped_invalid';
  }
  const observationYmd = input.observationDayYmd?.trim() || ymd;
  if (!/^\d{8}$/.test(observationYmd)) {
    console.warn('[honcho-write-events] recordPerformanceEvent skipped: invalid observationDayYmd');
    return 'skipped_invalid';
  }
  const platform = String(input.platform || 'unknown').toLowerCase();

  const raw = input.payloadRecord && typeof input.payloadRecord === 'object' ? input.payloadRecord : {};
  const scrubbed = scrubPlatformIdsFromPerformancePayload(raw);
  const sourceUrl = extractPerformanceMetricsSourceUrl(scrubbed) ?? extractPerformanceMetricsSourceUrl(raw);
  if (!sourceUrl || !/^https:\/\//i.test(sourceUrl)) {
    console.warn('[honcho-write-events] recordPerformanceEvent skipped: no verifiable https source_url');
    return 'skipped_invalid';
  }

  // Idempotency is per (job, platform, OBSERVATION horizon) — see the cadence
  // note in insights-513-contract.ts. Keying on the publish day alone would cap
  // a post at one observation for life while the ledger re-offered it daily.
  const key = idempotencyKey([jobId, 'publish', platform, ymd, observationYmd]);
  let disposition: PerformanceClaimDisposition;
  try {
    disposition = await claimPerformanceWrite(key, client);
  } catch (err) {
    console.error('[honcho-write-events] failed to claim performance lease', err);
    return 'failed';
  }
  if (disposition === 'completed') return 'skipped_idempotent';
  if (disposition === 'in_flight') return 'failed';

  const metricsBag =
    scrubbed.metrics && typeof scrubbed.metrics === 'object' && !Array.isArray(scrubbed.metrics)
      ? (scrubbed.metrics as Record<string, unknown>)
      : scrubbed;
  const captionExcerpt =
    typeof scrubbed.caption_excerpt === 'string' && scrubbed.caption_excerpt.trim()
      ? scrubbed.caption_excerpt.trim()
      : null;
  const mediaType = typeof scrubbed.media_type === 'string' ? scrubbed.media_type : null;
  const horizonLabel =
    typeof input.horizonDays === 'number' && Number.isFinite(input.horizonDays)
      ? observationHorizonLabel(input.horizonDays)
      : null;

  const content = formatPerformanceObservation({
    platform,
    mediaType,
    publishedAtYmd: dashYmd(ymd),
    horizonLabel,
    metrics: metricsBag,
    captionExcerpt,
    sourceUrl,
  });

  const transport = opts?.transport ?? new HonchoHttpTransport(process.env, fetchWithTimeout(HONCHO_WRITE_FETCH_TIMEOUT_MS));
  const mem = new TenantMemoryClient(transport);

  try {
    await mem.ensureWorkspace(input.tenantCtx);
    await mem.appendObservation({
      ctx: input.tenantCtx,
      peer: { kind: 'brand' },
      session: { kind: 'performance', jobId },
      content,
      metadata: {
        kind: 'performance_observation',
        platform,
        published_at_ymd: dashYmd(ymd),
        observation_day: dashYmd(observationYmd),
        ...(horizonLabel ? { observation_horizon: horizonLabel } : {}),
      },
    });
    // The append is done — record that in the append-only completion ledger.
    await completePerformanceWrite(key, client);
    return 'appended';
  } catch (err) {
    console.error('[honcho-write-events] recordPerformanceEvent failed', err);
    // Give the lease back so the next tick can retry immediately.
    await releasePerformanceClaim(key, client);
    return 'failed';
  }
}

export function scheduleHermesPublishPerformanceHonchoWrite(input: {
  doc: SocialContentJobRuntimeDocument;
  payloadRecord: Record<string, unknown> | null;
}): void {
  if (!isHonchoEnabled() || !isHonchoWritePublishEnabled()) return;
  setImmediate(() => {
    void (async () => {
      try {
        const tenantId = String(input.doc.tenant_id);
        const slug = await resolveTenantSlugForMemoryWrite(tenantId, pool);
        const topicHex = topicPseudonymHexForPerformanceMemory(
          input.doc.job_id,
          input.doc.inputs?.competitor_url ?? null,
        );
        const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const platform =
          typeof input.payloadRecord?.platform === 'string'
            ? input.payloadRecord.platform
            : typeof input.payloadRecord?.provider === 'string'
              ? input.payloadRecord.provider
              : 'aggregate';
        const tenantCtx: MinimalTenantCtx = {
          tenantId,
          tenantSlug: slug,
          // SYNTHETIC context: this scheduled performance write has no human
          // actor. Never pass the tenantId as userId — pseudonymForUser("15")
          // cannot distinguish tenant 15 from user 15, so under
          // multi-workspace a future refactor could merge a synthetic peer
          // with a real person's (plan Taste/Honcho verification hardening).
          // recordPerformanceEvent never reads ctx.userId today; the sentinel
          // keeps that safe by construction.
          userId: 'system',
          role: 'tenant_admin',
        };
        await recordPerformanceEvent({
          tenantCtx,
          jobId: input.doc.job_id,
          topicPseudonymHex: topicHex,
          publishedAtYmd: ymd,
          platform,
          payloadRecord: input.payloadRecord,
        });
      } catch (err) {
        console.error('[honcho-write-events] scheduled recordPerformanceEvent failed', err);
      }
    })();
  });
}

// ---------------------------------------------------------------------------
// Phase 3 — explicit operator creative voice / style preference (UI toggle)
// ---------------------------------------------------------------------------

/**
 * Common first-name denylist used by the v2 narrow redactor. Intentionally small
 * and high-frequency — the goal is to catch obvious `<FirstName> <LastName>`
 * patterns ("John Smith") without scrubbing legitimate operator-authored
 * creative descriptors ("Bold Minimalist", "Quiet Luxury", "Dark Academia").
 *
 * Keep entries lower-cased. The redactor matches Title-cased tokens
 * (`[A-Z][a-z]+`) and lowercases the first token before checking it against
 * this set, so "John Smith" and "Mary Jones" redact but "JOHN SMITH" and
 * "john smith" do not. Title-case is required by the surrounding regex.
 */
const COMMON_FIRST_NAMES_V2: ReadonlySet<string> = new Set([
  'john',
  'jane',
  'mary',
  'michael',
  'david',
  'sarah',
  'james',
  'robert',
  'william',
  'richard',
  'thomas',
  'charles',
  'joseph',
  'christopher',
  'daniel',
  'matthew',
  'anthony',
  'mark',
  'donald',
  'steven',
  'paul',
  'andrew',
  'joshua',
  'kenneth',
  'kevin',
  'brian',
  'george',
  'edward',
  'ronald',
  'timothy',
  'jason',
  'jeffrey',
  'ryan',
  'jacob',
  'gary',
  'nicholas',
  'eric',
  'jonathan',
  'stephen',
  'larry',
  'justin',
  'scott',
  'brandon',
  'benjamin',
  'samuel',
  'frank',
  'gregory',
  'patricia',
  'linda',
  'barbara',
  'elizabeth',
  'jennifer',
  'maria',
  'susan',
  'margaret',
  'dorothy',
  'lisa',
  'nancy',
  'karen',
  'betty',
  'helen',
  'sandra',
  'donna',
  'carol',
  'ruth',
  'sharon',
  'michelle',
  'laura',
  'emily',
  'kimberly',
  'deborah',
  'jessica',
  'shirley',
  'cynthia',
  'angela',
  'melissa',
  'amy',
  'rebecca',
  'virginia',
  'kathleen',
  'amanda',
  'ashley',
  'stephanie',
]);

function isLabelRedactionV2Enabled(): boolean {
  return process.env.ARIES_MEMORY_LABEL_REDACTION_V2 === '1';
}

/**
 * Redact obvious PII from free-text preference labels before they enter Honcho claims.
 *
 * Two modes:
 *  - Default (legacy): redact any pair of title-cased words via a broad regex.
 *    This over-scrubs aesthetic descriptors like "Bold Minimalist".
 *  - v2 (ARIES_MEMORY_LABEL_REDACTION_V2=1): only redact when the first token
 *    matches a curated denylist of common first names AND the second token is
 *    a title-cased word. This preserves creative descriptors while still
 *    catching `<FirstName> <LastName>` style PII.
 *
 * Email redaction is unchanged in both modes — that pattern is unambiguous.
 *
 * Security note: we do not log raw label values from this function. Callers
 * that want telemetry should log only the redaction decision flag.
 */
export function scrubPreferenceLabelForHoncho(label: string | null | undefined): string {
  let s = typeof label === 'string' ? label : '';
  s = s.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[redacted_email]');
  if (isLabelRedactionV2Enabled()) {
    s = s.replace(/\b([A-Z][a-z]+)\s+([A-Z][a-z]+)\b/g, (match, first: string, _second: string) => {
      return COMMON_FIRST_NAMES_V2.has(first.toLowerCase()) ? '[redacted_name]' : match;
    });
  } else {
    s = s.replace(/\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/g, '[redacted_name]');
  }
  return s;
}

export type RecordCreativeVoicePreferenceHonchoWriteInput = {
  tenantCtx: MinimalTenantCtx;
  memoryActorUserId: string;
  jobId: string;
  alwaysMatchCreativeVoice: boolean;
  voiceStyleLabel?: string | null;
  /** UTC calendar day (YYYYMMDD). */
  eventDateYmd: string;
  /** Must be true (explicit UI save); inferred paths must not call this writer. */
  explicitUserIntent: boolean;
};

/**
 * Persist explicit creative voice preference to Honcho `peer-user-*`, `session-curated-<jobId>`.
 */
export async function recordCreativeVoicePreferenceEvent(
  input: RecordCreativeVoicePreferenceHonchoWriteInput,
  client = pool,
  opts?: { transport?: HonchoTransport },
): Promise<void> {
  if (!isHonchoEnabled() || !isHonchoWritePreferencesEnabled()) return;
  if (!input.explicitUserIntent) return;

  const actor = input.memoryActorUserId?.trim();
  if (!actor) {
    console.warn('[honcho-write-events] recordCreativeVoicePreferenceEvent skipped: memoryActorUserId missing');
    return;
  }

  const jobId = input.jobId?.trim();
  if (!jobId) {
    console.warn('[honcho-write-events] recordCreativeVoicePreferenceEvent skipped: jobId missing');
    return;
  }

  const ymd = input.eventDateYmd?.trim();
  if (!ymd || !/^\d{8}$/.test(ymd)) {
    console.warn('[honcho-write-events] recordCreativeVoicePreferenceEvent skipped: invalid eventDateYmd');
    return;
  }

  const userPseudonym = pseudonymForUser(actor);
  const scrubbedLabel = scrubPreferenceLabelForHoncho(input.voiceStyleLabel ?? null);
  const labelPrint = scrubbedLabel.trim().length > 0 ? createHash('sha256').update(scrubbedLabel).digest('hex').slice(0, 16) : 'none';
  const enabledFlag = input.alwaysMatchCreativeVoice ? '1' : '0';
  const key = idempotencyKey([jobId, 'voice_pref', userPseudonym, enabledFlag, labelPrint, ymd]);
  const claimed = await claimIdempotencyKey(key, client);
  if (!claimed) return;

  const claimPayload: Record<string, unknown> = {
    event: 'creative_voice_style_preference',
    research_job_id: jobId,
    always_match_creative_voice: input.alwaysMatchCreativeVoice,
    explicit_user_intent: true,
  };
  if (scrubbedLabel.trim().length > 0) {
    claimPayload.creative_voice_style_label = scrubbedLabel.trim();
  }

  const finding: CandidateFinding = {
    kind: 'preference',
    claim: JSON.stringify(claimPayload),
    sources: [firstPartyAriesSource()],
    confidence: 0.92,
    peerHint: 'user',
    metadata: { explicit_user_intent: true },
  };

  const outcome = curateFinding(finding, { jobId, approvedBy: userPseudonym });
  const transport = opts?.transport ?? new HonchoHttpTransport(process.env, fetchWithTimeout(HONCHO_WRITE_FETCH_TIMEOUT_MS));
  const mem = new TenantMemoryClient(transport);

  try {
    if (outcome.decision === 'auto_approve') {
      const peerRef = peerRefForAutoApprove(outcome, { preferenceActorUserId: actor });
      await appendHonchoApproved({
        ctx: input.tenantCtx,
        client: mem,
        peer: peerRef,
        session: { kind: 'curated', jobId },
        message: outcome.approved,
      });
      return;
    }
    if (outcome.decision === 'queue_for_review') {
      await persistQueuedFinding(String(input.tenantCtx.tenantId), jobId, finding, outcome, client);
    }
  } catch (err) {
    console.error('[honcho-write-events] recordCreativeVoicePreferenceEvent failed', err);
  }
}

export function scheduleCreativeVoicePreferenceHonchoWrite(input: RecordCreativeVoicePreferenceHonchoWriteInput): void {
  if (!isHonchoEnabled() || !isHonchoWritePreferencesEnabled()) return;
  if (!input.memoryActorUserId?.trim()) {
    console.warn('[honcho-write-events] scheduleCreativeVoicePreferenceHonchoWrite skipped: memoryActorUserId missing');
    return;
  }
  setImmediate(() => {
    void (async () => {
      try {
        await recordCreativeVoicePreferenceEvent(input);
      } catch (err) {
        console.error('[honcho-write-events] scheduled recordCreativeVoicePreferenceEvent failed', err);
      }
    })();
  });
}

export type RecordOnboardingVariantTasteSignalHonchoWriteInput = {
  tenantCtx: MinimalTenantCtx;
  memoryActorUserId: string;
  /** Onboarding run id — used as the Honcho session-onboarding-<runId> id (and
   * the queue job id when not auto-approved). Must satisfy assertSlug:
   * /^[A-Za-z0-9_-]{1,128}$/. */
  jobId: string;
  /** Which of the board slots this signal is for (0-based; MVP = 0). */
  slotIndex: number;
  /** Stable id of the variant the signal is about. */
  variantId: string;
  /** Rating signal for the variant (e.g. a 1-5 string, or 'up'/'down'). */
  rating: string;
  /** Compact edit-operation tags applied to the variant; scrubbed + truncated. */
  editOps?: string | null;
  /** True when this variant was the one the user picked/shipped. */
  picked: boolean;
  /** UTC calendar day (YYYYMMDD). */
  eventDateYmd: string;
  /** Must be true (explicit board interaction); inferred paths must not call this. */
  explicitUserIntent: boolean;
};

/**
 * Persist an explicit onboarding variant-board taste signal to Honcho
 * `peer-user-*`, `session-onboarding-<runId>`. Mirrors
 * recordCreativeVoicePreferenceEvent: kind='preference', confidence 0.92,
 * explicit_user_intent → curator auto-approves; idempotent on
 * [jobId, 'variant_taste', variantId, rating, userPseudonym, ymd]; gated on
 * isHonchoWritePreferencesEnabled() (the variant board is a preference signal,
 * so it reuses the preferences write flag — no separate flag).
 */
export async function recordOnboardingVariantTasteSignalEvent(
  input: RecordOnboardingVariantTasteSignalHonchoWriteInput,
  client = pool,
  opts?: { transport?: HonchoTransport },
): Promise<void> {
  if (!isHonchoEnabled() || !isHonchoWritePreferencesEnabled()) return;
  if (!input.explicitUserIntent) return;

  const actor = input.memoryActorUserId?.trim();
  if (!actor) {
    console.warn('[honcho-write-events] recordOnboardingVariantTasteSignalEvent skipped: memoryActorUserId missing');
    return;
  }

  const jobId = input.jobId?.trim();
  if (!jobId) {
    console.warn('[honcho-write-events] recordOnboardingVariantTasteSignalEvent skipped: jobId missing');
    return;
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) {
    // jobId becomes session-onboarding-<runId>; assertSlug throws downstream AFTER
    // the idempotency key is claimed, which would permanently drop the write on
    // retry. Fail fast before claiming so a corrected re-fire can still land.
    console.warn('[honcho-write-events] recordOnboardingVariantTasteSignalEvent skipped: jobId is not slug-safe');
    return;
  }

  const variantId = input.variantId?.trim();
  if (!variantId) {
    console.warn('[honcho-write-events] recordOnboardingVariantTasteSignalEvent skipped: variantId missing');
    return;
  }

  const ymd = input.eventDateYmd?.trim();
  if (!ymd || !/^\d{8}$/.test(ymd)) {
    console.warn('[honcho-write-events] recordOnboardingVariantTasteSignalEvent skipped: invalid eventDateYmd');
    return;
  }

  const userPseudonym = pseudonymForUser(actor);
  const rating = String(input.rating ?? '').trim().slice(0, 16);
  const slotIndex = Number.isFinite(input.slotIndex) ? Math.trunc(input.slotIndex) : -1;
  // Scrub any free-text edit ops the same way labels are scrubbed; cap length so
  // the serialized claim stays well under the 200-char self-imposed budget.
  const scrubbedEditOps = scrubPreferenceLabelForHoncho(input.editOps ?? null).trim().slice(0, 64);
  // Fingerprint the mutable signal fields into the idempotency key so genuinely
  // distinct signals (a re-rate, an edit, or a rate→pick transition on the same
  // variant/day) each get a fresh key, while an identical re-fire still dedupes.
  // Mirrors the reference writer folding enabledFlag + labelPrint into its key.
  const editOpsPrint = scrubbedEditOps.length > 0
    ? createHash('sha256').update(scrubbedEditOps).digest('hex').slice(0, 16)
    : 'none';
  const pickedFlag = input.picked ? '1' : '0';

  const key = idempotencyKey([
    jobId,
    'variant_taste',
    variantId,
    rating,
    pickedFlag,
    editOpsPrint,
    String(slotIndex),
    userPseudonym,
    ymd,
  ]);
  const claimed = await claimIdempotencyKey(key, client);
  if (!claimed) return;

  const claim = JSON.stringify({
    event: 'variant_taste_signal',
    schema_version: 1,
    slot_index: slotIndex,
    variant_id: variantId.slice(0, 48),
    rating,
    edit_ops: scrubbedEditOps,
    picked: input.picked,
  });

  const finding: CandidateFinding = {
    kind: 'preference',
    claim,
    sources: [firstPartyAriesSource()],
    confidence: 0.92,
    peerHint: 'user',
    metadata: { explicit_user_intent: true },
  };

  const outcome = curateFinding(finding, { jobId, approvedBy: userPseudonym });
  const transport = opts?.transport ?? new HonchoHttpTransport(process.env, fetchWithTimeout(HONCHO_WRITE_FETCH_TIMEOUT_MS));
  const mem = new TenantMemoryClient(transport);

  try {
    if (outcome.decision === 'auto_approve') {
      const peerRef = peerRefForAutoApprove(outcome, { preferenceActorUserId: actor });
      await appendHonchoApproved({
        ctx: input.tenantCtx,
        client: mem,
        peer: peerRef,
        session: { kind: 'onboarding', runId: jobId },
        message: outcome.approved,
      });
      return;
    }
    if (outcome.decision === 'queue_for_review') {
      await persistQueuedFinding(String(input.tenantCtx.tenantId), jobId, finding, outcome, client);
    }
  } catch (err) {
    console.error('[honcho-write-events] recordOnboardingVariantTasteSignalEvent failed', err);
  }
}

export function scheduleOnboardingVariantTasteSignalHoncho(input: RecordOnboardingVariantTasteSignalHonchoWriteInput): void {
  if (!isHonchoEnabled() || !isHonchoWritePreferencesEnabled()) return;
  if (!input.memoryActorUserId?.trim()) {
    console.warn('[honcho-write-events] scheduleOnboardingVariantTasteSignalHoncho skipped: memoryActorUserId missing');
    return;
  }
  setImmediate(() => {
    void (async () => {
      try {
        await recordOnboardingVariantTasteSignalEvent(input);
      } catch (err) {
        console.error('[honcho-write-events] scheduled recordOnboardingVariantTasteSignalEvent failed', err);
      }
    })();
  });
}
