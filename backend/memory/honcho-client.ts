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
  | { kind: 'strategy'; jobId: string };

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

  async listApprovedMessages(input: ListApprovedMessagesInput): Promise<ApprovedMessage[]> {
    const workspaceId = this.workspaceId(input.ctx);
    const peer = peerIdFor(input.peer);
    const session = input.session ? sessionIdFor(input.session) : undefined;

    // Honcho v3 uses POST /sessions/{sid}/messages/list (body = MessageGet
    // { filters }, query = page/size/reverse) for paginated reads. There is
    // NO peer-scoped messages list endpoint in v3 — to enumerate a peer's
    // messages across sessions you must either iterate sessions or call
    // /peers/{peer}/representation. We log + no-op the peer-only call rather
    // than throwing so existing callers (orchestrator.loadResearchMemoryContext)
    // degrade quietly until a proper peer-scoped read is implemented.
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
