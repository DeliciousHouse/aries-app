import { createHash } from 'node:crypto';

import pool from '@/lib/db';
import type { TenantContext } from '@/lib/tenant-context';

import type { MarketingJobRuntimeDocument } from '@/backend/marketing/runtime-state';

import { curateFinding, type CurateOptions } from './curator';
import { isApprovalDenialReasonCode } from '@/lib/marketing/approval-denial-reason-codes';
import { HonchoHttpTransport } from './honcho-http-transport';
import { isHonchoEnabled, isHonchoWriteApprovalsEnabled, isHonchoWritePublishEnabled } from './honcho-env';
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

async function resolveTenantSlugForMemoryWrite(tenantId: string, client: typeof pool): Promise<string> {
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
      const peerRef = peerRefForAutoApprove(outcome);
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
      const peerRef = peerRefForAutoApprove(outcome);
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
  /** Hex topic pseudonym for `peer-market-signal-*`. */
  topicPseudonymHex: string;
  /** Calendar day for idempotency (YYYYMMDD, UTC). */
  publishedAtYmd: string;
  platform: string;
  /** First output record from Hermes callback (metrics, etc.). */
  payloadRecord: Record<string, unknown> | null;
};

/**
 * Hermes publish stage completed with performance-shaped output → `research_conclusion` on market-signal peer (queued).
 */
export async function recordPerformanceEvent(
  input: RecordPublishPerformanceHonchoWriteInput,
  client = pool,
): Promise<void> {
  if (!isHonchoEnabled() || !isHonchoWritePublishEnabled()) return;
  const jobId = input.jobId?.trim();
  if (!jobId) return;
  const ymd = input.publishedAtYmd?.trim();
  if (!ymd || !/^\d{8}$/.test(ymd)) {
    console.warn('[honcho-write-events] recordPerformanceEvent skipped: invalid publishedAtYmd');
    return;
  }
  const platform = String(input.platform || 'unknown').toLowerCase();
  const topic = input.topicPseudonymHex?.trim();
  if (!topic || !/^[a-f0-9]{8,64}$/i.test(topic)) {
    console.warn('[honcho-write-events] recordPerformanceEvent skipped: invalid topicPseudonymHex');
    return;
  }

  const raw = input.payloadRecord && typeof input.payloadRecord === 'object' ? input.payloadRecord : {};
  const scrubbed = scrubPlatformIdsFromPerformancePayload(raw);
  const sourceUrl = extractPerformanceMetricsSourceUrl(scrubbed) ?? extractPerformanceMetricsSourceUrl(raw);
  if (!sourceUrl || !/^https:\/\//i.test(sourceUrl)) {
    console.warn('[honcho-write-events] recordPerformanceEvent skipped: no verifiable https source_url');
    return;
  }

  const key = idempotencyKey([jobId, 'publish', platform, ymd]);
  const claimed = await claimIdempotencyKey(key, client);
  if (!claimed) return;

  const claim = JSON.stringify({
    event: 'publish_stage_performance',
    research_job_id: jobId,
    provider: platform,
    metrics: scrubbed,
    source_url: sourceUrl,
  });
  const finding: CandidateFinding = {
    kind: 'research_conclusion',
    claim,
    sources: [{ url: sourceUrl, fetched_at: new Date().toISOString(), trust: 'third_party' }],
    confidence: 0.88,
    peerHint: 'market_signal',
  };
  const outcome = curateFinding(finding, { jobId, approvedBy: 'system' });

  try {
    if (outcome.decision === 'queue_for_review') {
      await persistQueuedFinding(String(input.tenantCtx.tenantId), jobId, finding, outcome, client);
    }
  } catch (err) {
    console.error('[honcho-write-events] recordPerformanceEvent failed', err);
  }
}

export function scheduleHermesPublishPerformanceHonchoWrite(input: {
  doc: MarketingJobRuntimeDocument;
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
          userId: tenantId,
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
