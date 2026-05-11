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

      const body = msgCall.body as Record<string, unknown>;
      // peer_id is passed as a body field per TenantMemoryClient.appendApprovedMessage.
      assert.equal(body.peer_id, 'peer-brand', 'peer_id must be peer-brand');
      const content = JSON.parse(body.content as string) as Record<string, unknown>;
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
      const body = msgCalls[0]!.body as Record<string, unknown>;
      assert.equal(body.peer_id, 'peer-policy');
      assert.ok(String(msgCalls[0]!.path).includes('session-curated-job-sch'));
    },
  ));

test('Phase 2 — recordPerformanceEvent requires https source_url', () =>
  withEnv(
    {
      HONCHO_ENABLED: 'true',
      HONCHO_WRITE_PUBLISH_ENABLED: 'true',
      ARIES_TENANT_PSEUDONYM_SALT: TEST_SALT,
      APP_BASE_URL: 'https://aries.example.com',
    },
    async () => {
      let findings = 0;
      const trackingPool = buildMockPool((sql) => {
        if (sql.includes('honcho_write_idempotency_keys')) {
          return { rows: [{ key: 'claimed' }] };
        }
        if (sql.includes('INSERT INTO aries_research_findings')) {
          findings++;
          return { rows: [] };
        }
        return { rows: [] };
      });

      await recordPerformanceEvent(
        {
          tenantCtx: TENANT_CTX,
          jobId: 'job-perf',
          topicPseudonymHex: 'abcdabcdabcdabcdabcdabcdabcdabcd',
          publishedAtYmd: '20260515',
          platform: 'facebook',
          payloadRecord: { impressions: 1, platform_post_id: 'should-strip' },
        },
        trackingPool as never,
      );
      assert.equal(findings, 0, 'no source_url → no write');

      await recordPerformanceEvent(
        {
          tenantCtx: TENANT_CTX,
          jobId: 'job-perf2',
          topicPseudonymHex: 'abcdabcdabcdabcdabcdabcdabcdabcd',
          publishedAtYmd: '20260516',
          platform: 'facebook',
          payloadRecord: {
            impressions: 10,
            source_url: 'https://www.facebook.com/insights/deleted/',
            platform_post_id: 'secret-post',
          },
        },
        trackingPool as never,
      );
      assert.equal(findings, 1);
    },
  ));

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
      const body = msgCalls[0]!.body as Record<string, unknown>;
      assert.ok(String(body.peer_id).startsWith('peer-user-'));
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
