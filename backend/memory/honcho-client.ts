import type { TenantContext } from '@/lib/tenant-context';
import type { ApprovedMessage, PeerKind } from './types';
import { MemoryError } from './errors';
import {
  ARIES_TENANT_WORKSPACE_PREFIX,
  isAriesTenantWorkspace,
  pseudonymForUser,
  workspaceIdForTenant,
} from './pseudonym';

type MinimalTenantContext = Pick<TenantContext, 'tenantId' | 'tenantSlug' | 'userId' | 'role'>;

export type PeerRef =
  | { kind: 'brand' }
  | { kind: 'policy' }
  | { kind: 'user'; userId: string | number }
  | { kind: 'approver'; userId: string | number }
  | { kind: 'competitor'; competitorPseudonym: string }
  | { kind: 'audience'; segmentId: string }
  | { kind: 'market_signal'; topicPseudonym: string };

export type SessionRef =
  | { kind: 'curated'; jobId: string }
  | { kind: 'onboarding'; runId: string }
  | { kind: 'strategy'; jobId: string }
  /**
   * Post-performance observations for one marketing job (ITEM A write leg).
   * Separate from `curated` so the deriver sees a coherent thread of "how did
   * this job's posts actually do" rather than interleaving it with research.
   */
  | { kind: 'performance'; jobId: string };

/** Honcho dialectic reasoning levels (v3 `DialecticOptions.reasoning_level`). */
export type DialecticReasoningLevel = 'minimal' | 'low' | 'medium' | 'high' | 'max';

export type DialecticQueryInput = {
  ctx: MinimalTenantContext;
  peer: PeerRef;
  /** Natural-language question, 1..10000 chars (Honcho v3 hard limit). */
  query: string;
  reasoningLevel?: DialecticReasoningLevel;
};

export type AppendObservationInput = {
  ctx: MinimalTenantContext;
  peer: PeerRef;
  session: SessionRef;
  /** Plain natural-language prose — the deriver digests sentences, not JSON. */
  content: string;
  metadata?: Record<string, unknown>;
};

/** Honcho v3 `DialecticOptions.query` maxLength. */
const DIALECTIC_QUERY_MAX_CHARS = 10_000;

export type AppendApprovedMessageInput = {
  ctx: MinimalTenantContext;
  peer: PeerRef;
  session: SessionRef;
  message: ApprovedMessage;
};

export type ListApprovedMessagesInput = {
  ctx: MinimalTenantContext;
  peer: PeerRef;
  session?: SessionRef;
  includeSuperseded?: boolean;
};

export interface HonchoTransport {
  request<T>(args: {
    method: 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH';
    path: string;
    workspaceId: string;
    body?: unknown;
    query?: Record<string, string | number | boolean | undefined>;
  }): Promise<T>;
}

function requireTenantContext(ctx: MinimalTenantContext | null | undefined): MinimalTenantContext {
  if (!ctx || !ctx.tenantId) {
    throw new MemoryError(
      'tenant_context_required',
      'TenantContext required for tenant memory operations.',
      401,
    );
  }
  return ctx;
}

function peerIdFor(peer: PeerRef): string {
  switch (peer.kind) {
    case 'brand':
      return 'peer-brand';
    case 'policy':
      return 'peer-policy';
    case 'user':
      return `peer-user-${pseudonymForUser(peer.userId)}`;
    case 'approver':
      return `peer-approver-${pseudonymForUser(peer.userId)}`;
    case 'competitor':
      return `peer-competitor-${assertPseudonym(peer.competitorPseudonym)}`;
    case 'audience':
      return `peer-audience-${assertSlug(peer.segmentId)}`;
    case 'market_signal':
      return `peer-market-signal-${assertPseudonym(peer.topicPseudonym)}`;
    default: {
      const exhaustive: never = peer;
      throw new MemoryError('invalid_request', `Unknown peer ref: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function sessionIdFor(s: SessionRef): string {
  switch (s.kind) {
    case 'curated':
      return `session-curated-${assertSlug(s.jobId)}`;
    case 'onboarding':
      return `session-onboarding-${assertSlug(s.runId)}`;
    case 'strategy':
      return `session-strategy-${assertSlug(s.jobId)}`;
    case 'performance':
      return `session-performance-${assertSlug(s.jobId)}`;
  }
}

function assertSlug(s: string): string {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_\-]{1,128}$/.test(s)) {
    throw new MemoryError('invalid_request', `Invalid id segment: ${s}`);
  }
  return s;
}

function assertPseudonym(s: string): string {
  if (typeof s !== 'string' || !/^[a-f0-9]{8,64}$/.test(s)) {
    throw new MemoryError('invalid_request', `Invalid pseudonym: ${s}`);
  }
  return s;
}

export class TenantMemoryClient {
  constructor(private readonly transport: HonchoTransport) {}

  workspaceId(ctx: MinimalTenantContext): string {
    const wsid = workspaceIdForTenant(requireTenantContext(ctx).tenantId);
    if (!isAriesTenantWorkspace(wsid)) {
      throw new MemoryError(
        'workspace_lockin_violation',
        `Computed workspace id ${wsid} is outside ${ARIES_TENANT_WORKSPACE_PREFIX}* namespace.`,
        500,
      );
    }
    return wsid;
  }

  async ensureWorkspace(ctx: MinimalTenantContext): Promise<{ workspaceId: string }> {
    const workspaceId = this.workspaceId(ctx);
    await this.transport.request({
      method: 'POST',
      path: `/v3/workspaces`,
      workspaceId,
      body: { id: workspaceId },
    });
    return { workspaceId };
  }

  async appendApprovedMessage(input: AppendApprovedMessageInput): Promise<{ messageId: string }> {
    const workspaceId = this.workspaceId(input.ctx);
    const peer = peerIdFor(input.peer);
    const session = sessionIdFor(input.session);
    // Honcho v3 POST /sessions/{sid}/messages takes a batched body
    // ({ messages: [...] }, schema MessageBatchCreate) and returns an array of
    // Message. The flat single-object body that v1/v2 accepted is rejected as
    // 422 "missing body.messages" against any v3 server, which means writes
    // silently no-op when the transport's caller catches and logs the error.
    // See OpenAPI: MessageBatchCreate requires `messages` (1..100 items).
    const res = await this.transport.request<Array<{ id: string }> | { id: string }>({
      method: 'POST',
      path: `/v3/workspaces/${workspaceId}/sessions/${session}/messages`,
      workspaceId,
      body: {
        messages: [
          {
            peer_id: peer,
            content: JSON.stringify(input.message),
            metadata: {
              kind: input.message.kind,
              confidence: input.message.confidence,
              approved_by: input.message.approved_by,
              research_job_id: input.message.research_job_id,
              supersedes: input.message.supersedes,
            },
          },
        ],
      },
    });
    const messageId = Array.isArray(res) ? res[0]?.id : res?.id;
    return { messageId: String(messageId ?? '') };
  }

  /**
   * Append a plain-prose observation to a session on behalf of a peer.
   *
   * Same batched v3 `MessageBatchCreate` body as `appendApprovedMessage`, but
   * the content is natural language rather than a JSON-serialized
   * `ApprovedMessage`. That is deliberate: the deriver builds a peer's working
   * representation by reading message CONTENT, and a JSON blob derives into
   * nothing useful. Prose on `peer-brand` is what later shows up in the
   * dialectic answers `dialecticQuery` reads back.
   */
  async appendObservation(input: AppendObservationInput): Promise<{ messageId: string }> {
    const workspaceId = this.workspaceId(input.ctx);
    const peer = peerIdFor(input.peer);
    const session = sessionIdFor(input.session);
    const content = typeof input.content === 'string' ? input.content.trim() : '';
    if (!content) {
      throw new MemoryError('invalid_request', 'appendObservation requires non-empty content.');
    }
    const res = await this.transport.request<Array<{ id: string }> | { id: string }>({
      method: 'POST',
      path: `/v3/workspaces/${workspaceId}/sessions/${session}/messages`,
      workspaceId,
      body: {
        messages: [
          {
            peer_id: peer,
            content,
            ...(input.metadata ? { metadata: input.metadata } : {}),
          },
        ],
      },
    });
    const messageId = Array.isArray(res) ? res[0]?.id : res?.id;
    return { messageId: String(messageId ?? '') };
  }

  /**
   * Ask Honcho's dialectic endpoint a natural-language question about a peer's
   * accumulated representation (Honcho v3 `POST /peers/{peer}/chat`, schema
   * `DialecticOptions` → `DialecticResponse { content: string | null }`).
   *
   * This is the READ half of the compounding per-brand profile: everything the
   * write legs append (approvals, denials, performance observations) is folded
   * by the deriver into the peer's representation, and this is how we get it
   * back out. It replaces the session-less `listApprovedMessages` path, which
   * has no v3 endpoint and always returned [].
   *
   * The call is LLM-backed inside honcho-api and can be slow — callers must
   * supply a timeout-wrapped transport and treat failure as "no context".
   */
  async dialecticQuery(input: DialecticQueryInput): Promise<string | null> {
    const workspaceId = this.workspaceId(input.ctx);
    const peer = peerIdFor(input.peer);
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    if (!query) {
      throw new MemoryError('invalid_request', 'dialecticQuery requires a non-empty query.');
    }
    const res = await this.transport.request<{ content?: string | null }>({
      method: 'POST',
      path: `/v3/workspaces/${workspaceId}/peers/${peer}/chat`,
      workspaceId,
      body: {
        query: query.slice(0, DIALECTIC_QUERY_MAX_CHARS),
        stream: false,
        reasoning_level: input.reasoningLevel ?? 'low',
      },
    });
    const content = res?.content;
    return typeof content === 'string' && content.trim().length > 0 ? content.trim() : null;
  }

  async listApprovedMessages(input: ListApprovedMessagesInput): Promise<ApprovedMessage[]> {
    const workspaceId = this.workspaceId(input.ctx);
    const peer = peerIdFor(input.peer);
    const session = input.session ? sessionIdFor(input.session) : undefined;

    // Honcho v3 uses POST /sessions/{sid}/messages/list (body = MessageGet
    // { filters }, query = page/size/reverse) for paginated reads. There is
    // NO peer-scoped messages list endpoint in v3 — to enumerate a peer's
    // messages across sessions you must either iterate sessions or call
    // /peers/{peer}/representation. We log + no-op the peer-only call rather
    // than throwing so existing callers degrade quietly.
    //
    // DEAD PATH (ITEM A): the peer-scoped brand read is now `dialecticQuery`
    // above — orchestrator.loadBrandProfileContext / the Hermes port use it.
    // `loadResearchMemoryContext` (session-less) is the only remaining caller
    // and it is kept solely so the research-dispatch snapshot API keeps its
    // shape; it will always yield [] and must never be treated as the brand
    // profile source.
    if (!session) {
      console.warn(
        '[honcho-client] listApprovedMessages without session is not supported on Honcho v3 (peer-scoped read TODO); returning [].',
        { workspaceId, peer },
      );
      return [];
    }

    const raw = await this.transport.request<{ items: Array<{ content: string; metadata?: { supersedes?: string | null } }> }>({
      method: 'POST',
      path: `/v3/workspaces/${workspaceId}/sessions/${session}/messages/list`,
      workspaceId,
      body: { filters: { peer_id: peer } },
      query: { size: '100' },
    });

    const messages: ApprovedMessage[] = [];
    const supersededIds = new Set<string>();
    for (const item of raw.items ?? []) {
      try {
        const parsed = JSON.parse(item.content) as ApprovedMessage;
        messages.push(parsed);
        if (parsed.supersedes) supersededIds.add(parsed.supersedes);
      } catch {
        // Malformed durable memory should never exist; skip silently in v1.
      }
    }

    if (input.includeSuperseded) return messages;
    return messages.filter(m => !supersededIds.has(messageKey(m)));
  }

  async deleteWorkspace(ctx: MinimalTenantContext): Promise<{ workspaceId: string }> {
    const workspaceId = this.workspaceId(ctx);
    await this.transport.request({
      method: 'DELETE',
      path: `/v3/workspaces/${workspaceId}`,
      workspaceId,
    });
    return { workspaceId };
  }
}

function messageKey(m: ApprovedMessage): string {
  return `${m.research_job_id}:${m.approved_at}:${m.claim.slice(0, 64)}`;
}

export const __peerIdFor = peerIdFor;
export const __sessionIdFor = sessionIdFor;
export type { PeerKind };
