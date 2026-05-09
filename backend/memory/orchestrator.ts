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

  return { loadResearchMemoryContext, appendCuratedFinding };
}
