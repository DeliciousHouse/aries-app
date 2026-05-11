import assert from 'node:assert/strict';
import test from 'node:test';

import { recordApprovalEvent, recordDenialEvent, scheduleMarketingApprovalHonchoWrites } from '../backend/memory/write-events';
import type { HonchoTransport } from '../backend/memory/honcho-client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal tenant context used across all tests. */
const TENANT_CTX = { tenantId: 'tid', tenantSlug: 'slug', userId: 'u1', role: 'tenant_admin' as const };

/** Salt required by pseudonymForUser. */
const TEST_SALT = 'test-salt-at-least-16-chars';

/**
 * Build a mock pool whose query responses are driven by the provided handler.
 *
 * The handler receives `(sql, params)` and must return `{ rows: unknown[] }`.
 * Default: first INSERT RETURNING call succeeds (claim wins); subsequent calls
 * with the same key return `{ rows: [] }` (already claimed).
 */
function buildMockPool(handler: (sql: string, params?: unknown[]) => { rows: unknown[] }) {
  return {
    query: async (sql: string, params?: unknown[]) => handler(sql, params),
  };
}

/** Record of a Honcho transport request. */
type TransportCall = {
  method: string;
  path: string;
  body?: unknown;
};

/** Stub transport that captures appendApprovedMessage calls. */
function buildStubTransport(): { transport: HonchoTransport; calls: TransportCall[] } {
  const calls: TransportCall[] = [];
  const transport: HonchoTransport = {
    async request<T>(args: {
      method: 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH';
      path: string;
      workspaceId: string;
      body?: unknown;
    }): Promise<T> {
      calls.push({ method: args.method, path: args.path, body: args.body });
      // ensureWorkspace POST → return workspace id shape
      if (args.method === 'POST' && args.path === '/v3/workspaces') {
        return { id: args.workspaceId } as unknown as T;
      }
      // appendApprovedMessage POST → return a message id
      if (args.method === 'POST' && args.path.includes('/messages')) {
        return { id: 'msg-stub-id' } as unknown as T;
      }
      return {} as T;
    },
  };
  return { transport, calls };
}

// ---------------------------------------------------------------------------
// Negative gate tests (pre-existing)
// ---------------------------------------------------------------------------

test('recordApprovalEvent skips DB when Honcho is disabled', async () => {
  const prevH = process.env.HONCHO_ENABLED;
  const prevW = process.env.HONCHO_WRITE_APPROVALS_ENABLED;
  process.env.HONCHO_ENABLED = 'false';
  process.env.HONCHO_WRITE_APPROVALS_ENABLED = 'true';
  const queries: string[] = [];
  const mockPool = {
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [] };
    },
  };
  await recordApprovalEvent(
    {
      tenantCtx: { tenantId: 'tid', tenantSlug: 'slug', userId: 'u1', role: 'tenant_admin' },
      memoryActorUserId: 'u1',
      jobId: 'j1',
      stage: 'strategy',
      eventDateYmd: '20260511',
    },
    mockPool as never,
  );
  assert.equal(queries.length, 0);
  process.env.HONCHO_ENABLED = prevH;
  process.env.HONCHO_WRITE_APPROVALS_ENABLED = prevW;
});

test('scheduleMarketingApprovalHonchoWrites with approvals gate off returns immediately', async () => {
  const prevW = process.env.HONCHO_WRITE_APPROVALS_ENABLED;
  process.env.HONCHO_WRITE_APPROVALS_ENABLED = 'false';
  scheduleMarketingApprovalHonchoWrites({
    tenantCtx: { tenantId: 't1', tenantSlug: 'slug', userId: 'u1', role: 'tenant_admin' },
    memoryActorUserId: 'u1',
    jobId: 'job-a',
    stage: 'strategy',
    resolution: 'approve',
    eventDateYmd: '20260511',
  });
  await new Promise<void>((resolve) => {
    setImmediate(() => resolve());
  });
  process.env.HONCHO_WRITE_APPROVALS_ENABLED = prevW;
});

// ---------------------------------------------------------------------------
// V0 — Idempotency: double-write produces only one Honcho call
// ---------------------------------------------------------------------------

test('V0 — recordApprovalEvent: second call with same key short-circuits (idempotency)', async () => {
  const prevH = process.env.HONCHO_ENABLED;
  const prevW = process.env.HONCHO_WRITE_APPROVALS_ENABLED;
  const prevSalt = process.env.ARIES_TENANT_PSEUDONYM_SALT;
  const prevApp = process.env.APP_BASE_URL;
  process.env.HONCHO_ENABLED = 'true';
  process.env.HONCHO_WRITE_APPROVALS_ENABLED = 'true';
  process.env.ARIES_TENANT_PSEUDONYM_SALT = TEST_SALT;
  process.env.APP_BASE_URL = 'https://aries.example.com';

  // Track INSERT RETURNING calls to simulate atomic claim:
  // first call wins (rows returned), second call PK conflict (no rows).
  let insertCount = 0;
  const mockPool = buildMockPool((sql) => {
    if (sql.includes('ON CONFLICT') && sql.includes('RETURNING')) {
      insertCount++;
      // First caller wins; second gets empty rows (PK conflict).
      return insertCount === 1 ? { rows: [{ key: 'claimed' }] } : { rows: [] };
    }
    return { rows: [] };
  });

  const { transport, calls } = buildStubTransport();

  const input = {
    tenantCtx: TENANT_CTX,
    memoryActorUserId: 'u1',
    jobId: 'job-v0',
    stage: 'strategy' as const,
    eventDateYmd: '20260511',
  };

  // First call — claim succeeds → Honcho write happens.
  await recordApprovalEvent(input, mockPool as never, { transport });
  const afterFirst = calls.filter(c => c.path.includes('/messages')).length;
  assert.equal(afterFirst, 1, 'first call should produce exactly one Honcho message write');

  // Second call with same key — claim returns false → short-circuit.
  await recordApprovalEvent(input, mockPool as never, { transport });
  const afterSecond = calls.filter(c => c.path.includes('/messages')).length;
  assert.equal(afterSecond, 1, 'second call must not produce another Honcho message write');

  process.env.HONCHO_ENABLED = prevH;
  process.env.HONCHO_WRITE_APPROVALS_ENABLED = prevW;
  process.env.ARIES_TENANT_PSEUDONYM_SALT = prevSalt;
  process.env.APP_BASE_URL = prevApp;
});

// ---------------------------------------------------------------------------
// V1 — Strategy approval auto-approves to peer-brand + session-strategy
// ---------------------------------------------------------------------------

test('V1 — recordApprovalEvent: strategy approval writes to peer-brand session-strategy', async () => {
  const prevH = process.env.HONCHO_ENABLED;
  const prevW = process.env.HONCHO_WRITE_APPROVALS_ENABLED;
  const prevSalt = process.env.ARIES_TENANT_PSEUDONYM_SALT;
  const prevApp = process.env.APP_BASE_URL;
  process.env.HONCHO_ENABLED = 'true';
  process.env.HONCHO_WRITE_APPROVALS_ENABLED = 'true';
  process.env.ARIES_TENANT_PSEUDONYM_SALT = TEST_SALT;
  process.env.APP_BASE_URL = 'https://aries.example.com';

  // Claim always wins for this test.
  const mockPool = buildMockPool((sql) => {
    if (sql.includes('ON CONFLICT') && sql.includes('RETURNING')) {
      return { rows: [{ key: 'claimed' }] };
    }
    return { rows: [] };
  });

  const { transport, calls } = buildStubTransport();

  await recordApprovalEvent(
    {
      tenantCtx: TENANT_CTX,
      memoryActorUserId: 'u1',
      jobId: 'job-v1',
      stage: 'strategy',
      eventDateYmd: '20260511',
    },
    mockPool as never,
    { transport },
  );

  // Find the message POST call. peer_id is in the body; session is in the URL path.
  const msgCalls = calls.filter(c => c.method === 'POST' && c.path.includes('/messages'));
  assert.equal(msgCalls.length, 1, 'should produce exactly one appendApprovedMessage call');

  const msgCall = msgCalls[0];
  // Session kind is encoded in the URL path (session-strategy-<jobId>).
  assert.ok(msgCall.path.includes('session-strategy-job-v1'), `expected session-strategy-job-v1 in path, got: ${msgCall.path}`);

  const body = msgCall.body as Record<string, unknown>;
  // peer_id is passed as a body field per TenantMemoryClient.appendApprovedMessage.
  assert.equal(body.peer_id, 'peer-brand', 'peer_id must be peer-brand');
  const content = JSON.parse(body.content as string) as Record<string, unknown>;
  assert.equal(content.kind, 'fact', 'message kind must be fact');

  // approved_by is the user pseudonym (non-empty hex string).
  assert.ok(typeof content.approved_by === 'string' && content.approved_by.length > 0, 'approved_by should be a non-empty pseudonym');
  assert.equal(content.research_job_id, 'job-v1', 'research_job_id must match input jobId');

  process.env.HONCHO_ENABLED = prevH;
  process.env.HONCHO_WRITE_APPROVALS_ENABLED = prevW;
  process.env.ARIES_TENANT_PSEUDONYM_SALT = prevSalt;
  process.env.APP_BASE_URL = prevApp;
});

// ---------------------------------------------------------------------------
// V2 — Denial dual-write: content to peer-brand + audit to peer-approver
// ---------------------------------------------------------------------------

test('V2 — recordDenialEvent: strategy denial writes rejected_angle to peer-brand and fact to peer-approver', async () => {
  const prevH = process.env.HONCHO_ENABLED;
  const prevW = process.env.HONCHO_WRITE_APPROVALS_ENABLED;
  const prevSalt = process.env.ARIES_TENANT_PSEUDONYM_SALT;
  const prevApp = process.env.APP_BASE_URL;
  process.env.HONCHO_ENABLED = 'true';
  process.env.HONCHO_WRITE_APPROVALS_ENABLED = 'true';
  process.env.ARIES_TENANT_PSEUDONYM_SALT = TEST_SALT;
  process.env.APP_BASE_URL = 'https://aries.example.com';

  // Both content and audit claims win.
  const mockPool = buildMockPool((sql) => {
    if (sql.includes('ON CONFLICT') && sql.includes('RETURNING')) {
      return { rows: [{ key: 'claimed' }] };
    }
    return { rows: [] };
  });

  const { transport, calls } = buildStubTransport();

  await recordDenialEvent(
    {
      tenantCtx: TENANT_CTX,
      memoryActorUserId: 'u1',
      jobId: 'job-v2',
      stage: 'strategy',
      denialReasonCode: 'wrong-tone',
      eventDateYmd: '20260511',
    },
    mockPool as never,
    { transport },
  );

  const msgCalls = calls.filter(c => c.method === 'POST' && c.path.includes('/messages'));
  assert.equal(msgCalls.length, 2, 'should produce exactly two appendApprovedMessage calls (content + audit)');

  // --- Content write (rejected_angle → peer-brand) ---
  const contentCall = msgCalls.find(c => (c.body as Record<string, unknown>).peer_id === 'peer-brand');
  assert.ok(contentCall, 'should have a content write to peer-brand');
  const contentBody = contentCall!.body as Record<string, unknown>;
  const contentMsg = JSON.parse(contentBody.content as string) as Record<string, unknown>;
  assert.equal(contentMsg.kind, 'rejected_angle', 'content message kind must be rejected_angle');
  const contentClaim = JSON.parse(contentMsg.claim as string) as Record<string, unknown>;
  assert.equal(contentClaim.denial_reason_code, 'wrong-tone', 'denial_reason_code must match input');

  // --- Audit write (fact → peer-approver-*) ---
  const auditCall = msgCalls.find(c => {
    const pid = (c.body as Record<string, unknown>).peer_id as string;
    return pid.startsWith('peer-approver-');
  });
  assert.ok(auditCall, 'should have an audit write to peer-approver-*');
  const auditBody = auditCall!.body as Record<string, unknown>;
  const auditMsg = JSON.parse(auditBody.content as string) as Record<string, unknown>;
  assert.equal(auditMsg.kind, 'fact', 'audit message kind must be fact');
  assert.equal(auditMsg.research_job_id, 'job-v2', 'audit research_job_id must match jobId');

  process.env.HONCHO_ENABLED = prevH;
  process.env.HONCHO_WRITE_APPROVALS_ENABLED = prevW;
  process.env.ARIES_TENANT_PSEUDONYM_SALT = prevSalt;
  process.env.APP_BASE_URL = prevApp;
});
