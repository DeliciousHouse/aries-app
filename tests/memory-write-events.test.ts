import assert from 'node:assert/strict';
import test from 'node:test';

import { curateFinding } from '../backend/memory/curator';
import {
  recordApprovalEvent,
  recordCreativeVoicePreferenceEvent,
  recordDenialEvent,
  recordPerformanceEvent,
  recordPublishEvent,
  recordScheduleEvent,
  scheduleCreativeVoicePreferenceHonchoWrite,
  scheduleMarketingApprovalHonchoWrites,
  scrubPlatformIdsFromPerformancePayload,
  scrubPreferenceLabelForHoncho,
} from '../backend/memory/write-events';
import type { HonchoTransport } from '../backend/memory/honcho-client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal tenant context used across all tests. */
const TENANT_CTX = { tenantId: 'tid', tenantSlug: 'slug', userId: 'u1', role: 'tenant_admin' as const };

/** Salt required by pseudonymForUser. */
const TEST_SALT = 'test-salt-at-least-16-chars';

/**
 * Safely set env vars for the duration of fn, then restore originals even on throw.
 * Handles undefined originals correctly (deletes the key instead of setting "undefined").
 */
function withEnv<T>(updates: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const original: Record<string, string | undefined> = {};
  for (const key of Object.keys(updates)) {
    original[key] = process.env[key];
    if (updates[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = updates[key]!;
    }
  }
  return Promise.resolve().then(fn).finally(() => {
    for (const key of Object.keys(original)) {
      if (original[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original[key]!;
      }
    }
  });
}

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

/**
 * Honcho v3 wraps message writes as MessageBatchCreate
 * ({ messages: [{ peer_id, content, metadata }] }). Pull the first message
 * out so per-write assertions can stay readable.
 */
function firstMessage(call: TransportCall): Record<string, unknown> {
  const body = call.body as { messages?: Array<Record<string, unknown>> } | undefined;
  const messages = body?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error(
      `Expected wrapped Honcho v3 batch body ({ messages: [...] }) but got: ${JSON.stringify(call.body)}`,
    );
  }
  return messages[0];
}

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
      // appendApprovedMessage POST → returns an array of Message (v3 batch).
      // Tests below extract the per-message body via firstMessage() so they
      // assert on the same shape the wire actually carries.
      if (args.method === 'POST' && args.path.includes('/messages')) {
        return [{ id: 'msg-stub-id' }] as unknown as T;
      }
      return {} as T;
    },
  };
  return { transport, calls };
}

// ---------------------------------------------------------------------------
// Negative gate tests (pre-existing)
// ---------------------------------------------------------------------------

test('recordApprovalEvent skips DB when Honcho is disabled', () =>
  withEnv(
    {
      HONCHO_ENABLED: 'false',
      HONCHO_WRITE_APPROVALS_ENABLED: 'true',
    },
    async () => {
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
    },
  ));

test('scheduleMarketingApprovalHonchoWrites with approvals gate off returns immediately', () =>
  withEnv({ HONCHO_WRITE_APPROVALS_ENABLED: 'false' }, async () => {
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
  }));

// ---------------------------------------------------------------------------
// V0 — Idempotency: double-write produces only one Honcho call
// ---------------------------------------------------------------------------

test('V0 — recordApprovalEvent: second call with same key short-circuits (idempotency)', () =>
  withEnv(
    {
      HONCHO_ENABLED: 'true',
      HONCHO_WRITE_APPROVALS_ENABLED: 'true',
      ARIES_TENANT_PSEUDONYM_SALT: TEST_SALT,
      APP_BASE_URL: 'https://aries.example.com',
    },
    async () => {
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
    },
  ));

// ---------------------------------------------------------------------------
// V1 — Strategy approval auto-approves to peer-brand + session-strategy
// ---------------------------------------------------------------------------

test('V1 — recordApprovalEvent: strategy approval writes to peer-brand session-strategy', () =>
  withEnv(
    {
      HONCHO_ENABLED: 'true',
      HONCHO_WRITE_APPROVALS_ENABLED: 'true',
      ARIES_TENANT_PSEUDONYM_SALT: TEST_SALT,
      APP_BASE_URL: 'https://aries.example.com',
    },
    async () => {
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

      // Honcho v3: body is { messages: [{ peer_id, content, metadata }] }.
      const msg = firstMessage(msgCall);
      assert.equal(msg.peer_id, 'peer-brand', 'peer_id must be peer-brand');
      const content = JSON.parse(msg.content as string) as Record<string, unknown>;
      assert.equal(content.kind, 'fact', 'message kind must be fact');

      // approved_by is the user pseudonym (non-empty hex string).
      assert.ok(typeof content.approved_by === 'string' && content.approved_by.length > 0, 'approved_by should be a non-empty pseudonym');
      assert.equal(content.research_job_id, 'job-v1', 'research_job_id must match input jobId');
    },
  ));

// ---------------------------------------------------------------------------
// V2 — Denial dual-write: content to peer-brand + audit to peer-approver
// ---------------------------------------------------------------------------

test('V2 — recordDenialEvent: strategy denial writes rejected_angle to peer-brand and fact to peer-approver', () =>
  withEnv(
    {
      HONCHO_ENABLED: 'true',
      HONCHO_WRITE_APPROVALS_ENABLED: 'true',
      ARIES_TENANT_PSEUDONYM_SALT: TEST_SALT,
      APP_BASE_URL: 'https://aries.example.com',
    },
    async () => {
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
      const contentCall = msgCalls.find(c => firstMessage(c).peer_id === 'peer-brand');
      assert.ok(contentCall, 'should have a content write to peer-brand');
      const contentMsg = JSON.parse(firstMessage(contentCall!).content as string) as Record<string, unknown>;
      assert.equal(contentMsg.kind, 'rejected_angle', 'content message kind must be rejected_angle');
      const contentClaim = JSON.parse(contentMsg.claim as string) as Record<string, unknown>;
      assert.equal(contentClaim.denial_reason_code, 'wrong-tone', 'denial_reason_code must match input');

      // --- Audit write (fact → peer-approver-*) ---
      const auditCall = msgCalls.find(c => String(firstMessage(c).peer_id ?? '').startsWith('peer-approver-'));
      assert.ok(auditCall, 'should have an audit write to peer-approver-*');
      const auditMsg = JSON.parse(firstMessage(auditCall!).content as string) as Record<string, unknown>;
      assert.equal(auditMsg.kind, 'fact', 'audit message kind must be fact');
      assert.equal(auditMsg.research_job_id, 'job-v2', 'audit research_job_id must match jobId');
    },
  ));

// ---------------------------------------------------------------------------
// Phase 2 — publish / schedule / performance (HONCHO_WRITE_PUBLISH_ENABLED)
// ---------------------------------------------------------------------------

test('Phase 2 — scrubPlatformIdsFromPerformancePayload strips platform post ids', () => {
  const scrubbed = scrubPlatformIdsFromPerformancePayload({
    platform_post_id: '1234567890',
    reach: 100,
    nested: { post_id: '9999999999999', ok: true },
  });
  assert.equal(scrubbed.platform_post_id, undefined);
  assert.equal(scrubbed.reach, 100);
  assert.equal((scrubbed.nested as Record<string, unknown>).post_id, undefined);
  assert.equal((scrubbed.nested as Record<string, unknown>).ok, true);
});

test('Phase 2 — recordPublishEvent skips when publish gate is off', () =>
  withEnv(
    {
      HONCHO_ENABLED: 'true',
      HONCHO_WRITE_PUBLISH_ENABLED: 'false',
      ARIES_TENANT_PSEUDONYM_SALT: TEST_SALT,
    },
    async () => {
      const queries: string[] = [];
      const mockPool = {
        query: async (sql: string) => {
          queries.push(sql);
          return { rows: [] };
        },
      };
      await recordPublishEvent(
        {
          tenantCtx: TENANT_CTX,
          jobId: 'job-pub',
          platform: 'facebook',
          publishedAtYmd: '20260511',
        },
        mockPool as never,
      );
      assert.equal(queries.length, 0);
    },
  ));

test('Phase 2 — recordPublishEvent idempotency: second call short-circuits', () =>
  withEnv(
    {
      HONCHO_ENABLED: 'true',
      HONCHO_WRITE_PUBLISH_ENABLED: 'true',
      ARIES_TENANT_PSEUDONYM_SALT: TEST_SALT,
      APP_BASE_URL: 'https://aries.example.com',
    },
    async () => {
      let idem = 0;
      const findingInserts: string[] = [];
      const mockPool = buildMockPool((sql) => {
        if (sql.includes('honcho_write_idempotency_keys')) {
          idem++;
          return idem === 1 ? { rows: [{ key: 'claimed' }] } : { rows: [] };
        }
        if (sql.includes('INSERT INTO aries_research_findings')) {
          findingInserts.push(sql);
          return { rows: [] };
        }
        return { rows: [] };
      });

      await recordPublishEvent(
        {
          tenantCtx: TENANT_CTX,
          jobId: 'job-pub2',
          platform: 'facebook',
          publishedAtYmd: '20260512',
        },
        mockPool as never,
      );
      await recordPublishEvent(
        {
          tenantCtx: TENANT_CTX,
          jobId: 'job-pub2',
          platform: 'facebook',
          publishedAtYmd: '20260512',
        },
        mockPool as never,
      );
      assert.equal(findingInserts.length, 1, 'queued finding persisted once');
    },
  ));

test('Phase 2 — recordScheduleEvent auto-approves to peer-policy', () =>
  withEnv(
    {
      HONCHO_ENABLED: 'true',
      HONCHO_WRITE_PUBLISH_ENABLED: 'true',
      ARIES_TENANT_PSEUDONYM_SALT: TEST_SALT,
      APP_BASE_URL: 'https://aries.example.com',
    },
    async () => {
      const mockPool = buildMockPool((sql) => {
        if (sql.includes('ON CONFLICT') && sql.includes('RETURNING')) {
          return { rows: [{ key: 'claimed' }] };
        }
        return { rows: [] };
      });
      const { transport, calls } = buildStubTransport();
      await recordScheduleEvent(
        {
          tenantCtx: TENANT_CTX,
          jobId: 'job-sch',
          postId: '42',
          platforms: ['facebook'],
          scheduledForIso: '2026-06-01T12:00:00.000Z',
        },
        mockPool as never,
        { transport },
      );
      const msgCalls = calls.filter(c => c.method === 'POST' && c.path.includes('/messages'));
      assert.equal(msgCalls.length, 1);
      assert.equal(firstMessage(msgCalls[0]!).peer_id, 'peer-policy');
      assert.ok(String(msgCalls[0]!.path).includes('session-curated-job-sch'));
    },
  ));

/**
 * ITEM A helpers: the performance leg now appends prose to Honcho instead of
 * queuing a curator finding, so these tests capture the transport.
 */
function capturePerfTransport(behavior?: { failMessages?: boolean }): {
  transport: HonchoTransport;
  messageCalls: TransportCall[];
} {
  const messageCalls: TransportCall[] = [];
  const transport: HonchoTransport = {
    async request<T>(args: { method: string; path: string; workspaceId: string; body?: unknown }): Promise<T> {
      if (args.path.includes('/messages')) {
        if (behavior?.failMessages) throw new Error('honcho down');
        messageCalls.push({ method: args.method, path: args.path, body: args.body });
        return [{ id: 'msg-1' }] as unknown as T;
      }
      return {} as T;
    },
  };
  return { transport, messageCalls };
}

const PERF_ENV = {
  HONCHO_ENABLED: 'true',
  HONCHO_WRITE_PUBLISH_ENABLED: 'true',
  ARIES_TENANT_PSEUDONYM_SALT: TEST_SALT,
  APP_BASE_URL: 'https://aries.example.com',
};

test('Phase 2 — recordPerformanceEvent requires https source_url', () =>
  withEnv(PERF_ENV, async () => {
    const { transport, messageCalls } = capturePerfTransport();
    const pool = buildMockPool((sql) =>
      sql.includes('memory_write_claim_leases')
        ? { rows: [{ disposition: 'acquired' }] }
        : { rows: [] },
    );

    const noSource = await recordPerformanceEvent(
      {
        tenantCtx: TENANT_CTX,
        jobId: 'job-perf',
        publishedAtYmd: '20260515',
        platform: 'facebook',
        payloadRecord: { metrics: { reach: 1 }, platform_post_id: 'should-strip' },
      },
      pool as never,
      { transport },
    );
    assert.equal(noSource, 'skipped_invalid', 'no source_url → no write');
    assert.equal(messageCalls.length, 0);

    const ok = await recordPerformanceEvent(
      {
        tenantCtx: TENANT_CTX,
        jobId: 'job-perf2',
        publishedAtYmd: '20260516',
        platform: 'facebook',
        payloadRecord: {
          metrics: { reach: 10 },
          source_url: 'https://www.facebook.com/insights/deleted/',
          platform_post_id: 'secret-post',
        },
      },
      pool as never,
      { transport },
    );
    assert.equal(ok, 'appended');
    assert.equal(messageCalls.length, 1);
  }));

test('ITEM A — perf observation is prose on peer-brand / session-performance-<jobId>', () =>
  withEnv(PERF_ENV, async () => {
    const { transport, messageCalls } = capturePerfTransport();
    const pool = buildMockPool((sql) =>
      sql.includes('memory_write_claim_leases')
        ? { rows: [{ disposition: 'acquired' }] }
        : { rows: [] },
    );

    const outcome = await recordPerformanceEvent(
      {
        tenantCtx: TENANT_CTX,
        jobId: 'job-obs',
        publishedAtYmd: '20260516',
        observationDayYmd: '20260523',
        horizonDays: 7,
        platform: 'Instagram',
        payloadRecord: {
          media_type: 'reel',
          caption_excerpt: 'three ways to break in new leather',
          metrics: {
            reach: 1200,
            views: 3400,
            likes: 300,
            comments: 12,
            shares: 5,
            saves: 9,
            source_url: 'https://www.instagram.com/p/ABC/',
          },
        },
      },
      pool as never,
      { transport },
    );

    assert.equal(outcome, 'appended');
    assert.equal(messageCalls.length, 1);
    assert.match(String(messageCalls[0]!.path), /\/sessions\/session-performance-job-obs\/messages$/);
    const msg = firstMessage(messageCalls[0]!);
    assert.equal(msg.peer_id, 'peer-brand');
    const content = String(msg.content);
    // Prose, not JSON — the deriver reads sentences.
    assert.ok(!content.trim().startsWith('{'), 'observation must not be a JSON blob');
    assert.match(content, /Post performance observation \(instagram reel, published 2026-05-16, measured 7d after publish\)/);
    assert.match(content, /reach 1200, views 3400, likes 300, comments 12, shares 5, saves 9/);
    assert.match(content, /Caption excerpt: "three ways to break in new leather"/);
    assert.match(content, /Source: https:\/\/www\.instagram\.com\/p\/ABC\//);
    const metadata = msg.metadata as Record<string, unknown>;
    assert.equal(metadata.kind, 'performance_observation');
    assert.equal(metadata.observation_horizon, '7d');
  }));

test('ITEM A — gates off: zero Honcho calls, zero idempotency claims', () =>
  withEnv({ ...PERF_ENV, HONCHO_WRITE_PUBLISH_ENABLED: 'false' }, async () => {
    const { transport, messageCalls } = capturePerfTransport();
    let claims = 0;
    const pool = buildMockPool((sql) => {
      if (sql.includes('honcho_write_idempotency_keys')) claims++;
      return { rows: [{ key: 'claimed' }] };
    });
    const outcome = await recordPerformanceEvent(
      {
        tenantCtx: TENANT_CTX,
        jobId: 'job-gated',
        publishedAtYmd: '20260516',
        platform: 'facebook',
        payloadRecord: { metrics: { reach: 1, source_url: 'https://x.example/p/1' } },
      },
      pool as never,
      { transport },
    );
    assert.equal(outcome, 'skipped_gated');
    assert.equal(claims, 0);
    assert.equal(messageCalls.length, 0);
  }));

test('ITEM A — lease storage failure returns failed instead of throwing', () =>
  withEnv(PERF_ENV, async () => {
    const pool = buildMockPool(() => {
      throw new Error('lease db down');
    });
    const outcome = await recordPerformanceEvent(
      {
        tenantCtx: TENANT_CTX,
        jobId: 'job-lease-db-down',
        publishedAtYmd: '20260516',
        platform: 'facebook',
        payloadRecord: { metrics: { reach: 1, source_url: 'https://x.example/p/1' } },
      },
      pool as never,
      { transport: capturePerfTransport().transport },
    );
    assert.equal(outcome, 'failed');
  }));

/**
 * Stand-in for the append-only completion ledger plus the mutable operational
 * lease table used by performance writes.
 *
 * `honcho_write_idempotency_keys` records only completed writes and is never
 * mutated. In-flight claims live in `memory_write_claim_leases`, where a failed
 * write may release its lease and a crash orphan may be taken over after 1 h.
 */
function buildClaimsPool() {
  const completed = new Set<string>();
  const leases = new Map<string, number>();
  const pool = buildMockPool((sql, params) => {
    const args = (params as unknown[] | undefined) ?? [];
    const key = String(args[0] ?? '');
    if (sql.includes('INSERT INTO memory_write_claim_leases')) {
      if (completed.has(key)) return { rows: [{ disposition: 'completed' }] };
      const leaseMs = Number(args[1] ?? 0);
      const claimedAt = leases.get(key);
      if (claimedAt !== undefined && Date.now() - claimedAt <= leaseMs) {
        return { rows: [{ disposition: 'in_flight' }] };
      }
      leases.set(key, Date.now());
      return { rows: [{ disposition: 'acquired' }] };
    }
    if (sql.includes('INSERT INTO honcho_write_idempotency_keys')) {
      completed.add(key);
      return { rows: [] };
    }
    if (sql.includes('DELETE FROM memory_write_claim_leases')) {
      leases.delete(key);
      return { rows: [] };
    }
    return { rows: [] };
  });
  return { pool, completed, leases };
}

const DUPE_INPUT = {
  tenantCtx: TENANT_CTX,
  jobId: 'job-dupe',
  publishedAtYmd: '20260516',
  observationDayYmd: '20260517',
  horizonDays: 1,
  platform: 'facebook',
  payloadRecord: { metrics: { reach: 1, source_url: 'https://x.example/p/1' } },
};

test('ITEM A — a COMPLETED claim: no Honcho call, reported as skipped_idempotent', () =>
  withEnv(PERF_ENV, async () => {
    const { transport, messageCalls } = capturePerfTransport();
    const { pool, completed, leases } = buildClaimsPool();

    // First write completes and appends its final idempotency marker.
    assert.equal(await recordPerformanceEvent(DUPE_INPUT, pool as never, { transport }), 'appended');
    assert.equal(messageCalls.length, 1);
    assert.equal(completed.size, 1, 'a successful append records one completion key');
    assert.equal(leases.size, 1, 'the completed lease remains as a concurrent-snapshot interlock');

    // Second sees the completed claim: safe to report as already written.
    const again = await recordPerformanceEvent(DUPE_INPUT, pool as never, { transport });
    assert.equal(again, 'skipped_idempotent');
    assert.equal(messageCalls.length, 1, 'no second append');
  }));

test('ITEM A — an UN-completed claim is never reported as idempotent (crash between claim and append)', () =>
  withEnv(PERF_ENV, async () => {
    // THE LOSS WINDOW. A process claimed the key and was killed (OOM, deploy,
    // SIGKILL) before the Honcho append, so releaseIdempotencyKey never ran.
    // Reporting skipped_idempotent here makes the worker ledger a write that
    // never happened, and the observation is gone for good.
    const { transport, messageCalls } = capturePerfTransport();
    const { pool, completed, leases } = buildClaimsPool();

    // Drive one real write so the mock learns the real idempotency key…
    assert.equal(await recordPerformanceEvent(DUPE_INPUT, pool as never, { transport }), 'appended');
    const key = [...completed][0]!;
    // …then rewind it to "leased just now, never completed".
    completed.delete(key);
    leases.set(key, Date.now());

    const outcome = await recordPerformanceEvent(DUPE_INPUT, pool as never, { transport });
    assert.equal(outcome, 'failed', 'an un-completed claim must stay due, not be ledgered as written');
    assert.equal(messageCalls.length, 1, 'and no second append while the other writer may be live');
  }));

test('ITEM A — an orphaned claim past its lease is taken over and actually written', () =>
  withEnv(PERF_ENV, async () => {
    const { transport, messageCalls } = capturePerfTransport();
    const { pool, completed, leases } = buildClaimsPool();

    assert.equal(await recordPerformanceEvent(DUPE_INPUT, pool as never, { transport }), 'appended');
    const key = [...completed][0]!;
    // Older than the 1 h lease and never completed → a crash orphan, not a
    // live writer. Someone has to finish it or the observation is lost.
    completed.delete(key);
    leases.set(key, Date.now() - 3 * 60 * 60 * 1000);

    const outcome = await recordPerformanceEvent(DUPE_INPUT, pool as never, { transport });
    assert.equal(outcome, 'appended', 'the orphan is recovered rather than lost');
    assert.equal(messageCalls.length, 2);
    assert.equal(completed.has(key), true, 'and the recovered write appends its completion key');
  }));

test('ITEM A — append failure releases the idempotency claim so the next tick retries', () =>
  withEnv(PERF_ENV, async () => {
    const leases = new Set<string>();
    const deletes: string[] = [];
    const pool = buildMockPool((sql, params) => {
      const key = String((params as unknown[] | undefined)?.[0] ?? '');
      if (sql.includes('INSERT INTO memory_write_claim_leases')) {
        if (leases.has(key)) return { rows: [{ disposition: 'in_flight' }] };
        leases.add(key);
        return { rows: [{ disposition: 'acquired' }] };
      }
      if (sql.includes('INSERT INTO honcho_write_idempotency_keys')) {
        return { rows: [] };
      }
      if (sql.includes('DELETE FROM memory_write_claim_leases')) {
        leases.delete(key);
        deletes.push(key);
        return { rows: [] };
      }
      return { rows: [] };
    });

    const input = {
      tenantCtx: TENANT_CTX,
      jobId: 'job-retry',
      publishedAtYmd: '20260516',
      observationDayYmd: '20260517',
      horizonDays: 1,
      platform: 'facebook',
      payloadRecord: { metrics: { reach: 42, source_url: 'https://x.example/p/1' } },
    };

    // Tick 1: Honcho is down.
    const down = capturePerfTransport({ failMessages: true });
    const first = await recordPerformanceEvent(input, pool as never, { transport: down.transport });
    assert.equal(first, 'failed');
    assert.equal(deletes.length, 1, 'claim released');
    assert.equal(leases.size, 0);

    // Tick 2: Honcho is back — the observation is NOT lost.
    const up = capturePerfTransport();
    const second = await recordPerformanceEvent(input, pool as never, { transport: up.transport });
    assert.equal(second, 'appended');
    assert.equal(up.messageCalls.length, 1);
    assert.match(String(firstMessage(up.messageCalls[0]!).content), /reach 42/);
  }));

// ---------------------------------------------------------------------------
// Phase 3 — explicit creative voice preference (HONCHO_WRITE_PREFERENCES_ENABLED)
// ---------------------------------------------------------------------------

const FP_SOURCE = {
  url: 'https://aries.example.com/',
  fetched_at: new Date().toISOString(),
  trust: 'first_party' as const,
};

test('Phase 3 — curator queues preference without explicit_user_intent metadata', () => {
  const outcome = curateFinding(
    {
      kind: 'preference',
      claim: JSON.stringify({ event: 'x' }),
      sources: [FP_SOURCE],
      confidence: 0.92,
      peerHint: 'user',
    },
    { jobId: 'job-pref', approvedBy: 'someone' },
  );
  assert.equal(outcome.decision, 'queue_for_review');
});

test('Phase 3 — curator auto_approves preference with explicit_user_intent', () => {
  const outcome = curateFinding(
    {
      kind: 'preference',
      claim: JSON.stringify({
        event: 'creative_voice_style_preference',
        research_job_id: 'job-pref',
        always_match_creative_voice: true,
      }),
      sources: [FP_SOURCE],
      confidence: 0.92,
      peerHint: 'user',
      metadata: { explicit_user_intent: true },
    },
    { jobId: 'job-pref', approvedBy: 'pseud' },
  );
  assert.equal(outcome.decision, 'auto_approve');
  if (outcome.decision === 'auto_approve') {
    assert.equal(outcome.peer, 'user');
  }
});

test('Phase 3 — scrubPreferenceLabelForHoncho redacts name-like and email tokens', () => {
  const s = scrubPreferenceLabelForHoncho('Use Jane Smith voice; ping me at ops@example.com');
  assert.ok(!s.includes('ops@example.com'));
  assert.ok(s.includes('[redacted_email]'));
  assert.ok(s.includes('[redacted_name]'));
});

test('Phase 3 — recordCreativeVoicePreferenceEvent is a no-op when preferences gate is off', () =>
  withEnv(
    {
      HONCHO_ENABLED: 'true',
      HONCHO_WRITE_PREFERENCES_ENABLED: 'false',
      ARIES_TENANT_PSEUDONYM_SALT: TEST_SALT,
      APP_BASE_URL: 'https://aries.example.com',
    },
    async () => {
      let idem = 0;
      const mockPool = buildMockPool((sql) => {
        if (sql.includes('honcho_write_idempotency_keys')) idem++;
        return { rows: [] };
      });
      const { transport, calls } = buildStubTransport();
      await recordCreativeVoicePreferenceEvent(
        {
          tenantCtx: TENANT_CTX,
          memoryActorUserId: '42',
          jobId: 'job-vp',
          alwaysMatchCreativeVoice: true,
          voiceStyleLabel: 'bold',
          eventDateYmd: '20260520',
          explicitUserIntent: true,
        },
        mockPool as never,
        { transport },
      );
      assert.equal(idem, 0);
      const msgCalls = calls.filter(c => c.method === 'POST' && c.path.includes('/messages'));
      assert.equal(msgCalls.length, 0);
    },
  ));

test('Phase 3 — recordCreativeVoicePreferenceEvent skips Honcho when explicitUserIntent is false', () =>
  withEnv(
    {
      HONCHO_ENABLED: 'true',
      HONCHO_WRITE_PREFERENCES_ENABLED: 'true',
      ARIES_TENANT_PSEUDONYM_SALT: TEST_SALT,
      APP_BASE_URL: 'https://aries.example.com',
    },
    async () => {
      let idem = 0;
      const mockPool = buildMockPool((sql) => {
        if (sql.includes('honcho_write_idempotency_keys')) idem++;
        return { rows: [{ key: 'k' }] };
      });
      const { transport, calls } = buildStubTransport();
      await recordCreativeVoicePreferenceEvent(
        {
          tenantCtx: TENANT_CTX,
          memoryActorUserId: '42',
          jobId: 'job-vp2',
          alwaysMatchCreativeVoice: true,
          eventDateYmd: '20260521',
          explicitUserIntent: false,
        },
        mockPool as never,
        { transport },
      );
      assert.equal(idem, 0);
      assert.equal(calls.filter(c => c.method === 'POST' && c.path.includes('/messages')).length, 0);
    },
  ));

test('Phase 3 — recordCreativeVoicePreferenceEvent appends peer-user preference when gate on', () =>
  withEnv(
    {
      HONCHO_ENABLED: 'true',
      HONCHO_WRITE_PREFERENCES_ENABLED: 'true',
      ARIES_TENANT_PSEUDONYM_SALT: TEST_SALT,
      APP_BASE_URL: 'https://aries.example.com',
    },
    async () => {
      const mockPool = buildMockPool((sql) => {
        if (sql.includes('ON CONFLICT') && sql.includes('RETURNING')) {
          return { rows: [{ key: 'claimed' }] };
        }
        return { rows: [] };
      });
      const { transport, calls } = buildStubTransport();
      await recordCreativeVoicePreferenceEvent(
        {
          tenantCtx: TENANT_CTX,
          memoryActorUserId: '42',
          jobId: 'job-vp3',
          alwaysMatchCreativeVoice: true,
          voiceStyleLabel: 'minimal',
          eventDateYmd: '20260522',
          explicitUserIntent: true,
        },
        mockPool as never,
        { transport },
      );
      const msgCalls = calls.filter(c => c.method === 'POST' && c.path.includes('/messages'));
      assert.equal(msgCalls.length, 1);
      assert.ok(String(firstMessage(msgCalls[0]!).peer_id).startsWith('peer-user-'));
      assert.ok(String(msgCalls[0]!.path).includes('session-curated-job-vp3'));
    },
  ));

test('Phase 3 — scheduleCreativeVoicePreferenceHonchoWrite with gate off does not touch transport', () =>
  withEnv({ HONCHO_ENABLED: 'true', HONCHO_WRITE_PREFERENCES_ENABLED: 'false' }, async () => {
    const { transport, calls } = buildStubTransport();
    scheduleCreativeVoicePreferenceHonchoWrite({
      tenantCtx: TENANT_CTX,
      memoryActorUserId: '1',
      jobId: 'j',
      alwaysMatchCreativeVoice: true,
      eventDateYmd: '20260523',
      explicitUserIntent: true,
    });
    await new Promise<void>((resolve) => {
      setImmediate(() => resolve());
    });
    assert.equal(calls.length, 0);
    assert.ok(transport);
  }));
