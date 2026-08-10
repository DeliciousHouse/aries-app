import type { TenantContext } from '@/lib/tenant-context';
import { curateFinding } from './curator';
import type { CurateOptions } from './curator';
import type { TenantMemoryClient, PeerRef, SessionRef } from './honcho-client';
import type { ApprovedMessage, CandidateFinding, CuratorOutcome, PeerKind } from './types';

const CHARS_PER_TOKEN_HEURISTIC = 4;

export type ResearchMemoryContextEntry = {
  kind: ApprovedMessage['kind'];
  claim: string;
  confidence: number;
  approved_at: string;
  sources: ApprovedMessage['sources'];
  research_job_id: string;
};

export type LoadResearchMemoryContextInput = {
  peers: PeerRef[];
  tokenBudget: number;
};

export type LoadResearchMemoryContextResult = {
  memoryContext: ResearchMemoryContextEntry[];
  truncated: boolean;
};

/**
 * The compounding per-brand profile, rendered for prompt injection.
 * `text` is already token-capped; `truncated` says the cap bit.
 */
export type BrandProfileContext = {
  text: string;
  truncated: boolean;
};

export type LoadBrandProfileContextInput = {
  /** Approximate token cap for the composed block (4 chars ≈ 1 token). */
  tokenBudget: number;
};

/**
 * The two dialectic questions that make up the brand profile.
 *
 * Phrasing matters: Honcho answers from the peer's derived representation, so
 * we ask for evidence-backed specifics and explicitly license "unknown" — an
 * LLM asked "what do we know about this brand" with an empty representation
 * will otherwise happily invent an audience.
 */
export const BRAND_PROFILE_QUERY =
  'What do we know about this brand: who is the audience, and what content, topics, hooks or formats have performed well? '
  + 'Answer with concrete, evidence-backed points only; say "unknown" where nothing is known.';

export const BRAND_AVOID_QUERY =
  'What content, claims, topics or angles should be AVOIDED for this brand (constraints, rejected angles, denials)? '
  + 'Answer with concrete, evidence-backed points only; say "unknown" where nothing is known.';

/** An answer that is empty or a bare "unknown" carries no information. */
function isUninformativeAnswer(answer: string | null): boolean {
  if (!answer) return true;
  const normalized = answer.trim().toLowerCase().replace(/[.!\s]+$/g, '');
  return normalized.length === 0 || normalized === 'unknown' || normalized === 'i don\'t know';
}

export type AppendCuratedFindingInput = {
  jobId: string;
  finding: CandidateFinding;
  foreignTenantPseudonyms?: string[];
};

export type AppendCuratedFindingResult = {
  outcome: CuratorOutcome;
  messageId?: string;
};

type MinimalCtx = Pick<TenantContext, 'tenantId' | 'tenantSlug' | 'userId' | 'role'>;

function peerRefForKind(kind: PeerKind): PeerRef | null {
  if (kind === 'brand') return { kind: 'brand' };
  if (kind === 'policy') return { kind: 'policy' };
  return null;
}

export function createMemoryOrchestrator(client: TenantMemoryClient) {
  async function loadResearchMemoryContext(
    ctx: MinimalCtx,
    input: LoadResearchMemoryContextInput,
  ): Promise<LoadResearchMemoryContextResult> {
    const charBudget = input.tokenBudget * CHARS_PER_TOKEN_HEURISTIC;
    const allMessages: ApprovedMessage[] = [];

    for (const peer of input.peers) {
      const messages = await client.listApprovedMessages({
        ctx,
        peer,
        includeSuperseded: false,
      });
      allMessages.push(...messages);
    }

    const memoryContext: ResearchMemoryContextEntry[] = [];
    let charCount = 0;
    let truncated = false;

    for (const msg of allMessages) {
      const chars = msg.claim.length;
      if (charCount + chars > charBudget) {
        truncated = true;
        break;
      }
      charCount += chars;
      memoryContext.push({
        kind: msg.kind,
        claim: msg.claim,
        confidence: msg.confidence,
        approved_at: msg.approved_at,
        sources: msg.sources,
        research_job_id: msg.research_job_id,
      });
    }

    return { memoryContext, truncated };
  }

  /**
   * ITEM A READ LEG — the compounding per-brand (per-tenant-workspace) profile.
   *
   * Two dialectic queries, ONE per peer, issued CONCURRENTLY: `peer-brand`
   * ("what works") and `peer-policy` ("what to avoid"). Each is independently
   * caught, so a 500 on one never costs us the other, and both failing simply
   * yields `null` — the caller then renders no block at all (fail-open).
   *
   * Returns null rather than an empty string so the caller cannot accidentally
   * render an empty labelled section.
   */
  async function loadBrandProfileContext(
    ctx: MinimalCtx,
    input: LoadBrandProfileContextInput,
  ): Promise<BrandProfileContext | null> {
    const ask = async (peer: PeerRef, query: string, label: string): Promise<string | null> => {
      try {
        return await client.dialecticQuery({ ctx, peer, query, reasoningLevel: 'low' });
      } catch (err) {
        // Single warn line per failed call: deploy verification ("is the Brand
        // memory block present?") must be diagnosable, not a silent absence.
        console.warn('[memory-orchestrator] brand profile dialectic failed', {
          peer: label,
          tenant_id: ctx.tenantId,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    };

    const [brandAnswer, avoidAnswer] = await Promise.all([
      ask({ kind: 'brand' }, BRAND_PROFILE_QUERY, 'brand'),
      ask({ kind: 'policy' }, BRAND_AVOID_QUERY, 'policy'),
    ]);

    const sections: string[] = [];
    if (!isUninformativeAnswer(brandAnswer)) {
      sections.push(`Known about this brand:\n${brandAnswer!.trim()}`);
    }
    if (!isUninformativeAnswer(avoidAnswer)) {
      sections.push(`Avoid:\n${avoidAnswer!.trim()}`);
    }
    if (sections.length === 0) return null;

    const composed = sections.join('\n\n');
    const charBudget = Math.max(1, input.tokenBudget) * CHARS_PER_TOKEN_HEURISTIC;
    if (composed.length <= charBudget) {
      return { text: composed, truncated: false };
    }
    return { text: `${composed.slice(0, charBudget)}\n…[truncated]`, truncated: true };
  }

  async function appendCuratedFinding(
    ctx: MinimalCtx,
    input: AppendCuratedFindingInput,
  ): Promise<AppendCuratedFindingResult> {
    const curateOpts: CurateOptions = {
      jobId: input.jobId,
      foreignTenantPseudonyms: input.foreignTenantPseudonyms,
    };
    const outcome = curateFinding(input.finding, curateOpts);

    if (outcome.decision !== 'auto_approve') {
      return { outcome };
    }

    const peerRef = peerRefForKind(outcome.peer);
    if (!peerRef) {
      return { outcome: { decision: 'queue_for_review', peer: outcome.peer, reason: 'peer_requires_user_id' } };
    }

    const session: SessionRef = { kind: 'curated', jobId: input.jobId };
    const { messageId } = await client.appendApprovedMessage({
      ctx,
      peer: peerRef,
      session,
      message: outcome.approved,
    });

    return { outcome, messageId };
  }

  return { loadResearchMemoryContext, loadBrandProfileContext, appendCuratedFinding };
}
