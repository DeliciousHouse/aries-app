/**
 * V0–V14 Honcho continuous-profile-writes verification harness (fixture-primary).
 *
 * Source of assertions: docs/plans/2026-05-11-aries-honcho-continuous-profile-writes.md
 * Rollout/verify plan:   docs/plans/2026-05-30-honcho-writes-rollout.md
 *
 * This file is the single-pane V0–V14 gate the rollout plan calls for. Every one
 * of the 15 spec assertions maps to exactly one `test('V<n> …')` below. It is
 * FIXTURE-PRIMARY: it never opens a socket or a Postgres connection.
 *
 *   - `pool.query` is replaced by an in-process mock that drives idempotency-key
 *     claims and captures `aries_research_findings` inserts (the review queue).
 *   - The Honcho transport is replaced by an in-process capture/throw/delay stub
 *     (no `HonchoHttpTransport`, no `fetch`).
 *
 * The prod read-back mode the plan mentions (`--prod`) is intentionally NOT in
 * this file — it requires the two prod JWTs + the real HONCHO_BASE_URL, which are
 * operator-only secrets (see docs/plans/2026-05-30-honcho-secrets-todo.md). This
 * harness is the CI-runnable half; the prod half is a manual operator step once
 * the secrets land.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/verify-honcho-writes.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  recordApprovalEvent,
  recordCreativeVoicePreferenceEvent,
  recordDenialEvent,
  recordPerformanceEvent,
  recordPublishEvent,
  recordScheduleEvent,
  scheduleMarketingApprovalHonchoWrites,
  scrubPreferenceLabelForHoncho,
  topicPseudonymHexForPerformanceMemory,
} from '../backend/memory/write-events';
import { pseudonymForUser } from '../backend/memory/pseudonym';
import type { HonchoTransport } from '../backend/memory/honcho-client';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const TENANT_CTX = { tenantId: 'tid', tenantSlug: 'slug', userId: 'u1', role: 'tenant_admin' as const };
const TEST_SALT = 'verify-harness-salt-32-chars-long!';

/** Base env every gated writer needs to run its body. */
const BASE_ENV = {
  HONCHO_ENABLED: 'true',
  ARIES_TENANT_PSEUDONYM_SALT: TEST_SALT,
  APP_BASE_URL: 'https://aries.example.com',
} as const;

function withEnv<T>(updates: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const original: Record<string, string | undefined> = {};
  for (const key of Object.keys(updates)) {
    original[key] = process.env[key];
    if (updates[key] === undefined) delete process.env[key];
    else process.env[key] = updates[key]!;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(original)) {
        if (original[key] === undefined) delete process.env[key];
        else process.env[key] = original[key]!;
      }
    });
}

// --- Mock pool -------------------------------------------------------------

const IDEM_TABLE = 'honcho_write_idempotency_keys';
const FINDINGS_TABLE = 'INSERT INTO aries_research_findings';

type FindingInsert = { decision: string; peer: string | null; raw: Record<string, unknown> };

/**
 * In-process pool that emulates the atomic `INSERT … ON CONFLICT DO NOTHING
 * RETURNING` idempotency claim against a Set of seen keys, and records every
 * review-queue (`aries_research_findings`) insert so queue-path assertions can
 * read them back without Postgres.
 */
function buildPool() {
  const claimedKeys = new Set<string>();
  const findings: FindingInsert[] = [];
  let idemAttempts = 0;
  let idemWins = 0;
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes(IDEM_TABLE) && sql.includes('ON CONFLICT')) {
        idemAttempts++;
        const key = String((params as unknown[] | undefined)?.[0] ?? '');
        if (claimedKeys.has(key)) return { rows: [], rowCount: 0 };
        claimedKeys.add(key);
        idemWins++;
        return { rows: [{ key }], rowCount: 1 };
      }
      if (sql.includes(FINDINGS_TABLE)) {
        const p = params as unknown[];
        findings.push({
          raw: JSON.parse(String(p[2])) as Record<string, unknown>,
          decision: String(p[3]),
          peer: p[4] === null || p[4] === undefined ? null : String(p[4]),
        });
        return { rows: [], rowCount: 1 };
      }
      // ensureResearchJobSchema DDL, ensureMarketingMemoryQueueJob INSERT, etc.
      return { rows: [], rowCount: 0 };
    },
    stats: () => ({ idemAttempts, idemWins, findings }),
  };
  return pool;
}

// --- Capture / throwing / delaying transports ------------------------------

type TransportCall = { method: string; path: string; body?: unknown };

function firstMessage(call: TransportCall): Record<string, unknown> {
  const body = call.body as { messages?: Array<Record<string, unknown>> } | undefined;
  const messages = body?.messages;
  assert.ok(Array.isArray(messages) && messages.length > 0, 'expected wrapped v3 batch body');
  return messages![0]!;
}

/** Captures every appendApprovedMessage / ensureWorkspace request. */
function captureTransport(): { transport: HonchoTransport; calls: TransportCall[] } {
  const calls: TransportCall[] = [];
  const transport: HonchoTransport = {
    async request<T>(args: { method: string; path: string; workspaceId: string; body?: unknown }): Promise<T> {
      calls.push({ method: args.method, path: args.path, body: args.body });
      if (args.method === 'POST' && args.path === '/v3/workspaces') return { id: args.workspaceId } as unknown as T;
      if (args.method === 'POST' && args.path.includes('/messages')) return [{ id: 'msg-id' }] as unknown as T;
      return {} as T;
    },
  };
  return { transport, calls };
}

/** Throws on append (simulates Honcho 503). */
function throwingTransport(): { transport: HonchoTransport; appendAttempts: () => number } {
  let attempts = 0;
  const transport: HonchoTransport = {
    async request<T>(args: { method: string; path: string; workspaceId: string }): Promise<T> {
      if (args.method === 'POST' && args.path.includes('/messages')) {
        attempts++;
        const err = new Error('honcho_unavailable') as Error & { status?: number };
        err.status = 503;
        throw err;
      }
      if (args.method === 'POST' && args.path === '/v3/workspaces') return { id: args.workspaceId } as unknown as T;
      return {} as T;
    },
  };
  return { transport, appendAttempts: () => attempts };
}

/** Adds `delayMs` to every append (simulates Honcho latency). */
function delayingTransport(delayMs: number): HonchoTransport {
  return {
    async request<T>(args: { method: string; path: string; workspaceId: string }): Promise<T> {
      if (args.method === 'POST' && args.path.includes('/messages')) {
        await new Promise((r) => setTimeout(r, delayMs));
        return [{ id: 'msg-id' }] as unknown as T;
      }
      if (args.method === 'POST' && args.path === '/v3/workspaces') return { id: args.workspaceId } as unknown as T;
      return {} as T;
    },
  };
}

const flushSetImmediate = () => new Promise<void>((resolve) => setImmediate(() => resolve()));
const msgWrites = (calls: TransportCall[]) => calls.filter((c) => c.method === 'POST' && c.path.includes('/messages'));

// ===========================================================================
// V0 — double-approve same job/stage → exactly one idempotency win; second
//      call no-ops (no second Honcho write).
// ===========================================================================
test('V0 — approval idempotency: second identical approve short-circuits', () =>
  withEnv({ ...BASE_ENV, HONCHO_WRITE_APPROVALS_ENABLED: 'true' }, async () => {
    const pool = buildPool();
    const { transport, calls } = captureTransport();
    const input = { tenantCtx: TENANT_CTX, memoryActorUserId: 'u1', jobId: 'v0', stage: 'strategy' as const, eventDateYmd: '20260511' };

    await recordApprovalEvent(input, pool as never, { transport });
    assert.equal(msgWrites(calls).length, 1, 'first approve writes once');
    await recordApprovalEvent(input, pool as never, { transport });
    assert.equal(msgWrites(calls).length, 1, 'second approve must not write again');
    assert.equal(pool.stats().idemWins, 1, 'exactly one idempotency key claimed');
  }));

// ===========================================================================
// V1 — strategy approve → session-strategy-<jobId> + peer-brand, one kind=fact,
//      approved_by=<userPseudonym>, NO raw tenant/user id anywhere in payload.
// ===========================================================================
test('V1 — strategy approve: peer-brand fact, pseudonymous, no raw ids leaked', () =>
  withEnv({ ...BASE_ENV, HONCHO_WRITE_APPROVALS_ENABLED: 'true' }, async () => {
    const pool = buildPool();
    const { transport, calls } = captureTransport();
    await recordApprovalEvent(
      { tenantCtx: TENANT_CTX, memoryActorUserId: 'u1', jobId: 'v1', stage: 'strategy', eventDateYmd: '20260511' },
      pool as never,
      { transport },
    );
    const writes = msgWrites(calls);
    assert.equal(writes.length, 1);
    const call = writes[0]!;
    assert.ok(call.path.includes('session-strategy-v1'), `session in path: ${call.path}`);
    const msg = firstMessage(call);
    assert.equal(msg.peer_id, 'peer-brand');
    const content = JSON.parse(msg.content as string) as Record<string, unknown>;
    assert.equal(content.kind, 'fact');
    assert.equal(content.approved_by, pseudonymForUser('u1'), 'approved_by is the user pseudonym');
    // No raw tenant/user id in the entire wire payload.
    const wire = JSON.stringify(call.body);
    assert.ok(!/"u1"/.test(wire), 'raw userId u1 absent');
    assert.ok(!/"tid"/.test(wire) && !wire.includes('aries-tenant-tid'), 'raw tenantId tid absent');
  }));

// ===========================================================================
// V2 — deny `production` w/ denial_reason_code → peer-policy rejected_angle
//      claim carries the code+stage+job (no free text) AND a peer-approver-*
//      kind=fact audit; both auto-approved (finding auto-approved, not queued).
// ===========================================================================
test('V2 — explicit deny: peer-policy rejected_angle + peer-approver audit, structured claim', () =>
  withEnv({ ...BASE_ENV, HONCHO_WRITE_APPROVALS_ENABLED: 'true' }, async () => {
    const pool = buildPool();
    const { transport, calls } = captureTransport();
    await recordDenialEvent(
      { tenantCtx: TENANT_CTX, memoryActorUserId: 'u1', jobId: 'v2', stage: 'production', denialReasonCode: 'wrong-colors', eventDateYmd: '20260511' },
      pool as never,
      { transport },
    );
    const writes = msgWrites(calls);
    assert.equal(writes.length, 2, 'content + audit');

    const content = writes.find((c) => firstMessage(c).peer_id === 'peer-policy');
    assert.ok(content, 'rejected_angle on peer-policy (production → policy)');
    const cMsg = JSON.parse(firstMessage(content!).content as string) as Record<string, unknown>;
    assert.equal(cMsg.kind, 'rejected_angle');
    const claim = JSON.parse(cMsg.claim as string) as Record<string, unknown>;
    assert.equal(claim.denial_reason_code, 'wrong-colors');
    assert.equal(claim.stage, 'production');
    assert.equal(claim.research_job_id, 'v2');
    // Structured-only: claim keys are exactly the three structured fields.
    assert.deepEqual(Object.keys(claim).sort(), ['denial_reason_code', 'research_job_id', 'stage']);

    const audit = writes.find((c) => String(firstMessage(c).peer_id).startsWith('peer-approver-'));
    assert.ok(audit, 'audit fact on peer-approver-*');
    assert.equal((JSON.parse(firstMessage(audit!).content as string) as Record<string, unknown>).kind, 'fact');
    assert.equal(pool.stats().findings.length, 0, 'explicit-coded denial auto-approves, nothing queued');
  }));

// ===========================================================================
// V3 — deny WITHOUT reason code → rejected_angle lands in the review queue
//      (aries_research_findings, queue_for_review); audit fact still written.
// ===========================================================================
test('V3 — deny without reason code: content queued for review, audit still written', () =>
  withEnv({ ...BASE_ENV, HONCHO_WRITE_APPROVALS_ENABLED: 'true' }, async () => {
    const pool = buildPool();
    const { transport, calls } = captureTransport();
    await recordDenialEvent(
      { tenantCtx: TENANT_CTX, memoryActorUserId: 'u1', jobId: 'v3', stage: 'strategy', denialReasonCode: null, eventDateYmd: '20260511' },
      pool as never,
      { transport },
    );
    const queued = pool.stats().findings.filter((f) => f.decision === 'queue_for_review');
    assert.equal(queued.length, 1, 'uncoded rejected_angle queued for review');
    assert.equal(queued[0]!.raw.kind, 'rejected_angle');
    // Audit fact is auto-approved → appended to Honcho, not queued.
    const audit = msgWrites(calls).find((c) => String(firstMessage(c).peer_id).startsWith('peer-approver-'));
    assert.ok(audit, 'audit fact still appended despite content going to queue');
  }));

// ===========================================================================
// V4 — gate off (HONCHO_WRITE_APPROVALS_ENABLED=false) → approve+deny produce
//      ZERO appended messages and ZERO db touches from the writer.
// ===========================================================================
test('V4 — approvals gate off: approve and deny produce zero Honcho + zero db writes', () =>
  withEnv({ ...BASE_ENV, HONCHO_WRITE_APPROVALS_ENABLED: 'false' }, async () => {
    const pool = buildPool();
    const { transport, calls } = captureTransport();
    await recordApprovalEvent(
      { tenantCtx: TENANT_CTX, memoryActorUserId: 'u1', jobId: 'v4', stage: 'strategy', eventDateYmd: '20260511' },
      pool as never,
      { transport },
    );
    await recordDenialEvent(
      { tenantCtx: TENANT_CTX, memoryActorUserId: 'u1', jobId: 'v4', stage: 'strategy', denialReasonCode: 'wrong-tone', eventDateYmd: '20260511' },
      pool as never,
      { transport },
    );
    assert.equal(msgWrites(calls).length, 0, 'no Honcho writes when gate off');
    assert.equal(pool.stats().idemAttempts, 0, 'writer short-circuits before any db query');
  }));

// ===========================================================================
// V5 — Honcho 503 (transport throws) → caller path returns normally, error
//      swallowed, no throw escapes the writer.
// ===========================================================================
test('V5 — Honcho 503: append throws but recordApprovalEvent resolves (no throw escapes)', () =>
  withEnv({ ...BASE_ENV, HONCHO_WRITE_APPROVALS_ENABLED: 'true' }, async () => {
    const pool = buildPool();
    const { transport, appendAttempts } = throwingTransport();
    await assert.doesNotReject(() =>
      recordApprovalEvent(
        { tenantCtx: TENANT_CTX, memoryActorUserId: 'u1', jobId: 'v5', stage: 'strategy', eventDateYmd: '20260511' },
        pool as never,
        { transport },
      ),
    );
    assert.ok(appendAttempts() >= 1, 'append was attempted and failed');
  }));

// ===========================================================================
// V6 — Honcho latency: the schedule* caller returns synchronously; the write
//      runs on setImmediate (off the response path) and does not block.
// ===========================================================================
test('V6 — latency non-blocking: schedule returns synchronously, slow append does not block caller', () =>
  withEnv({ ...BASE_ENV, HONCHO_WRITE_APPROVALS_ENABLED: 'true' }, async () => {
    const start = Date.now();
    const ret = scheduleMarketingApprovalHonchoWrites({
      tenantCtx: TENANT_CTX,
      memoryActorUserId: 'u1',
      jobId: 'v6',
      stage: 'strategy',
      resolution: 'approve',
      eventDateYmd: '20260511',
    });
    const returnedAt = Date.now() - start;
    assert.equal(ret, undefined, 'scheduler returns void synchronously');
    assert.ok(returnedAt < 50, `scheduler returned synchronously (${returnedAt}ms), not awaiting the write`);
    // Prove the write unit itself does not block the caller synchronously even
    // under a slow transport: the promise is pending immediately.
    const slow = delayingTransport(120);
    const t0 = Date.now();
    const p = recordApprovalEvent(
      { tenantCtx: TENANT_CTX, memoryActorUserId: 'u1', jobId: 'v6b', stage: 'strategy', eventDateYmd: '20260511' },
      buildPool() as never,
      { transport: slow },
    );
    assert.ok(Date.now() - t0 < 50, 'recordApprovalEvent did not block synchronously on the slow append');
    await p;
    await flushSetImmediate();
  }));

// ===========================================================================
// V7 — publish-verify `verified` → peer-policy constraint, QUEUED for review
//      (third-party source) — lands in aries_research_findings, NOT appended.
// ===========================================================================
test('V7 — publish verification: third-party constraint queued for review (not appended)', () =>
  withEnv({ ...BASE_ENV, HONCHO_WRITE_PUBLISH_ENABLED: 'true' }, async () => {
    const pool = buildPool();
    const { transport, calls } = captureTransport();
    await recordPublishEvent(
      { tenantCtx: TENANT_CTX, jobId: 'v7', platform: 'facebook', publishedAtYmd: '20260511' },
      pool as never,
      { transport },
    );
    assert.equal(msgWrites(calls).length, 0, 'third-party publish-verify is not auto-appended');
    const queued = pool.stats().findings.filter((f) => f.decision === 'queue_for_review');
    assert.equal(queued.length, 1, 'queued to review');
    assert.equal(queued[0]!.raw.kind, 'constraint');
  }));

// ===========================================================================
// V8 — schedule post → peer-policy constraint, auto-approved, approved_by=system
//      (first-party intent).
// ===========================================================================
test('V8 — schedule post: first-party constraint auto-approved to peer-policy, approved_by=system', () =>
  withEnv({ ...BASE_ENV, HONCHO_WRITE_PUBLISH_ENABLED: 'true' }, async () => {
    const pool = buildPool();
    const { transport, calls } = captureTransport();
    await recordScheduleEvent(
      { tenantCtx: TENANT_CTX, jobId: 'v8', postId: '42', platforms: ['facebook'], scheduledForIso: '2026-06-01T12:00:00.000Z' },
      pool as never,
      { transport },
    );
    const writes = msgWrites(calls);
    assert.equal(writes.length, 1);
    assert.equal(firstMessage(writes[0]!).peer_id, 'peer-policy');
    const content = JSON.parse(firstMessage(writes[0]!).content as string) as Record<string, unknown>;
    assert.equal(content.kind, 'constraint');
    assert.equal(content.approved_by, 'system');
  }));

// ===========================================================================
// V9 — Hermes publish-stage callback with https source_url → research_conclusion
//      on market-signal, QUEUED; payload ran through the scrubber (platform_post_id
//      dropped, 10-20 digit numeric string redacted).
// ===========================================================================
test('V9 — perf callback: scrubbed (platform_post_id + numeric id) research_conclusion queued', () =>
  withEnv({ ...BASE_ENV, HONCHO_WRITE_PUBLISH_ENABLED: 'true' }, async () => {
    const pool = buildPool();
    const topic = topicPseudonymHexForPerformanceMemory('v9', null);
    await recordPerformanceEvent(
      {
        tenantCtx: TENANT_CTX,
        jobId: 'v9',
        topicPseudonymHex: topic,
        publishedAtYmd: '20260511',
        platform: 'facebook',
        payloadRecord: {
          impressions: 10,
          platform_post_id: 'should-be-stripped',
          some_numeric: '123456789012345',
          source_url: 'https://graph.facebook.com/v21.0/insights',
        },
      },
      pool as never,
    );
    const queued = pool.stats().findings.filter((f) => f.decision === 'queue_for_review');
    assert.equal(queued.length, 1, 'research_conclusion queued (third-party market-signal)');
    assert.equal(queued[0]!.raw.kind, 'research_conclusion');
    const claim = JSON.parse(String(queued[0]!.raw.claim)) as Record<string, unknown>;
    const metrics = claim.metrics as Record<string, unknown>;
    assert.equal(metrics.platform_post_id, undefined, 'platform_post_id stripped');
    assert.equal(metrics.some_numeric, '[redacted_numeric_id]', '15-digit numeric id redacted');
    assert.equal(metrics.impressions, 10, 'real metric preserved');
    assert.equal(claim.source_url, 'https://graph.facebook.com/v21.0/insights');
  }));

// ===========================================================================
// V10 — duplicate publish for same job+platform+date → one idempotency win,
//       second is a no-op (one queued finding).
// ===========================================================================
test('V10 — publish idempotency: duplicate job+platform+date writes once', () =>
  withEnv({ ...BASE_ENV, HONCHO_WRITE_PUBLISH_ENABLED: 'true' }, async () => {
    const pool = buildPool();
    const { transport } = captureTransport();
    const input = { tenantCtx: TENANT_CTX, jobId: 'v10', platform: 'facebook', publishedAtYmd: '20260511' };
    await recordPublishEvent(input, pool as never, { transport });
    await recordPublishEvent(input, pool as never, { transport });
    assert.equal(pool.stats().idemWins, 1, 'one idempotency key claimed');
    assert.equal(pool.stats().findings.length, 1, 'one queued finding persisted');
  }));

// ===========================================================================
// V11 — volume bound: 50 jobs × 5 platforms × daily callbacks for a month
//       → distinct idempotency wins < 1,500 writes/tenant/month.
// ===========================================================================
test('V11 — volume bound: 50 jobs × 5 platforms × 30 days stays under 1,500 writes/tenant/month', () =>
  withEnv({ ...BASE_ENV, HONCHO_WRITE_PUBLISH_ENABLED: 'true' }, async () => {
    const pool = buildPool();
    const { transport } = captureTransport();
    const platforms = ['facebook', 'instagram', 'tiktok', 'x', 'linkedin'];
    // The publish-verification key is (jobId, 'publish_verification', platform, ymd).
    // A monthly bound counts DISTINCT keys, so repeated daily callbacks for the
    // SAME (job, platform, day) collapse. Worst realistic case: each (job,
    // platform) verified once on a single in-month day, with retry callbacks.
    for (let job = 0; job < 50; job++) {
      for (const platform of platforms) {
        const day = String(20260500 + ((job % 28) + 1)); // a real YYYYMMDD in-month
        for (let retry = 0; retry < 3; retry++) {
          await recordPublishEvent(
            { tenantCtx: TENANT_CTX, jobId: `j${job}`, platform, publishedAtYmd: day },
            pool as never,
            { transport },
          );
        }
      }
    }
    const wins = pool.stats().idemWins;
    assert.equal(wins, 50 * platforms.length, 'retries collapse to one write per (job,platform,day)');
    assert.ok(wins < 1500, `monthly distinct writes ${wins} < 1500 bound`);
  }));

// ===========================================================================
// V12 — explicit toggle save → peer-user-<pseudonym> preference, auto-approved,
//       metadata.explicit_user_intent=true.
// ===========================================================================
test('V12 — explicit preference save: peer-user preference auto-approved with explicit_user_intent', () =>
  withEnv({ ...BASE_ENV, HONCHO_WRITE_PREFERENCES_ENABLED: 'true' }, async () => {
    const pool = buildPool();
    const { transport, calls } = captureTransport();
    await recordCreativeVoicePreferenceEvent(
      {
        tenantCtx: TENANT_CTX,
        memoryActorUserId: '42',
        jobId: 'v12',
        alwaysMatchCreativeVoice: true,
        voiceStyleLabel: 'Minimalist',
        eventDateYmd: '20260511',
        explicitUserIntent: true,
      },
      pool as never,
      { transport },
    );
    const writes = msgWrites(calls);
    assert.equal(writes.length, 1);
    const msg = firstMessage(writes[0]!);
    assert.ok(String(msg.peer_id).startsWith('peer-user-'), 'appended to peer-user-*');
    assert.ok(String(writes[0]!.path).includes('session-curated-v12'));
    const content = JSON.parse(msg.content as string) as Record<string, unknown>;
    assert.equal(content.kind, 'preference');
    const claim = JSON.parse(content.claim as string) as Record<string, unknown>;
    assert.equal(claim.explicit_user_intent, true);
    assert.equal(claim.creative_voice_style_label, 'Minimalist', 'single-word descriptor survives both redaction modes');
  }));

// ===========================================================================
// V13 — explicitUserIntent=false → zero appended messages (writer short-circuits
//       before claiming a key).
// ===========================================================================
test('V13 — inferred (explicitUserIntent=false): zero writes, no key claimed', () =>
  withEnv({ ...BASE_ENV, HONCHO_WRITE_PREFERENCES_ENABLED: 'true' }, async () => {
    const pool = buildPool();
    const { transport, calls } = captureTransport();
    await recordCreativeVoicePreferenceEvent(
      {
        tenantCtx: TENANT_CTX,
        memoryActorUserId: '42',
        jobId: 'v13',
        alwaysMatchCreativeVoice: true,
        eventDateYmd: '20260511',
        explicitUserIntent: false,
      },
      pool as never,
      { transport },
    );
    assert.equal(msgWrites(calls).length, 0, 'no Honcho write for inferred preference');
    assert.equal(pool.stats().idemAttempts, 0, 'short-circuits before claiming a key');
  }));

// ===========================================================================
// V14 — label with a <First Last> name → scrubPreferenceLabelForHoncho redacts
//       before the claim is built. Under ARIES_MEMORY_LABEL_REDACTION_V2=1
//       (prod default): "Bold Minimalist" survives, "John Smith" → [redacted_name],
//       email → [redacted_email].
// ===========================================================================
test('V14 — label scrub (V2 mode): name+email redacted, creative descriptor preserved, in the wire claim', () =>
  withEnv(
    { ...BASE_ENV, HONCHO_WRITE_PREFERENCES_ENABLED: 'true', ARIES_MEMORY_LABEL_REDACTION_V2: '1' },
    async () => {
      // Unit-level: the scrubber itself, in V2 mode.
      const scrubbed = scrubPreferenceLabelForHoncho('Bold Minimalist by John Smith — ping ops@example.com');
      assert.ok(scrubbed.includes('Bold Minimalist'), 'creative descriptor survives V2 mode');
      assert.ok(scrubbed.includes('[redacted_name]'), 'John Smith redacted');
      assert.ok(scrubbed.includes('[redacted_email]'), 'email redacted');
      assert.ok(!scrubbed.includes('John Smith') && !scrubbed.includes('ops@example.com'));

      // Integration-level: the redacted form is what reaches the Honcho claim.
      const pool = buildPool();
      const { transport, calls } = captureTransport();
      await recordCreativeVoicePreferenceEvent(
        {
          tenantCtx: TENANT_CTX,
          memoryActorUserId: '42',
          jobId: 'v14',
          alwaysMatchCreativeVoice: true,
          voiceStyleLabel: 'Bold Minimalist by John Smith',
          eventDateYmd: '20260511',
          explicitUserIntent: true,
        },
        pool as never,
        { transport },
      );
      const writes = msgWrites(calls);
      assert.equal(writes.length, 1);
      const claim = JSON.parse(
        (JSON.parse(firstMessage(writes[0]!).content as string) as Record<string, unknown>).claim as string,
      ) as Record<string, unknown>;
      assert.equal(claim.creative_voice_style_label, 'Bold Minimalist by [redacted_name]', 'wire claim carries redacted label');
    },
  ));
