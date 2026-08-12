import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';
import {
  MAX_EDITED_CLAIM_LENGTH,
  PROMOTION_ACTIONS,
  buildApprovedMessageFromFinding,
  isPromotionAction,
  resolveQueuedFinding,
  topicPseudonymForFinding,
} from '../backend/memory/promote-finding';
import {
  TERMINAL_CURATOR_DECISIONS,
  isTerminalCuratorDecision,
  type TenantResearchFinding,
} from '../backend/memory/research-jobs';
import { peerRefFromStoredPeer } from '../backend/memory/write-events';

/**
 * S6-5 / AA-118 (gap F8) — Approve / Edit / Reject a queued memory candidate.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/memory-finding-resolve.test.ts
 */

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

const TENANT_CTX = {
  tenantId: '7',
  tenantSlug: 'tenant-7',
  userId: 'user-42',
  role: 'tenant_admin' as const,
};

function finding(overrides: Partial<TenantResearchFinding> = {}): TenantResearchFinding {
  return {
    id: 'f-1',
    job_id: 'job-uuid-1',
    raw: {
      kind: 'research_conclusion',
      claim: JSON.stringify({ event: 'publish_stage_performance', provider: 'instagram' }),
      sources: [{ url: 'https://example.com/p/1', fetched_at: '2026-08-05T00:00:00Z', trust: 'third_party' }],
      confidence: 0.88,
      peerHint: 'market_signal',
    },
    curator_decision: 'queue_for_review',
    peer: 'market_signal',
    approved_message_id: null,
    created_at: '2026-08-05T00:00:00Z',
    tenant_id: '7',
    job_task_spec: { kind: 'marketing_memory_queue', marketing_job_id: 'mkt-job-9' },
    ...overrides,
  };
}

/** Deps that record everything and default to a healthy path. */
function deps(over: Partial<Parameters<typeof resolveQueuedFinding>[1]> = {}, row = finding()) {
  const appended: unknown[] = [];
  const decisions: Array<[string, string]> = [];
  let current = row;
  return {
    appended,
    decisions,
    d: {
      loadFinding: async () => (current.curator_decision === '__gone__' ? null : current),
      setDecision: async (_id: string, decision: 'approved' | 'rejected') => {
        if (current.curator_decision !== 'queue_for_review') return false;
        current = { ...current, curator_decision: decision };
        decisions.push([_id, decision]);
        return true;
      },
      appendToHoncho: async (input: unknown) => {
        appended.push(input);
        return true;
      },
      ...over,
    } as Parameters<typeof resolveQueuedFinding>[1],
  };
}

// ── Vocabulary ───────────────────────────────────────────────────────────────

test('the terminal decisions avoid colliding with the curator\'s own "drop"', () => {
  // curator.ts already emits `drop` for an automatic quality/safety rejection.
  // A human rejection must be distinguishable from it in the column alone.
  assert.deepEqual([...TERMINAL_CURATOR_DECISIONS], ['approved', 'rejected']);
  assert.ok(!TERMINAL_CURATOR_DECISIONS.includes('drop' as never));
  assert.ok(!TERMINAL_CURATOR_DECISIONS.includes('dropped' as never));
  assert.equal(isTerminalCuratorDecision('approved'), true);
  assert.equal(isTerminalCuratorDecision('queue_for_review'), false);
});

test('only the three documented actions are accepted', () => {
  assert.deepEqual([...PROMOTION_ACTIONS], ['approve', 'edit', 'reject']);
  for (const bad of ['', 'APPROVE', 'delete', 'drop', null, undefined, 7]) {
    assert.equal(isPromotionAction(bad), false, String(bad));
  }
});

// ── Approve ──────────────────────────────────────────────────────────────────

test('approve appends to Honcho and flips the decision', async () => {
  const { d, appended, decisions } = deps();
  const out = await resolveQueuedFinding(
    { findingId: 'f-1', tenantCtx: TENANT_CTX, action: 'approve' },
    d,
  );
  assert.deepEqual(out, {
    status: 'ok',
    findingId: 'f-1',
    decision: 'approved',
    memoryWritten: true,
  });
  assert.equal(appended.length, 1, 'exactly one memory append');
  assert.deepEqual(decisions, [['f-1', 'approved']]);
});

test('the appended message carries the approver, the job and the stored claim', async () => {
  const { d, appended } = deps();
  await resolveQueuedFinding({ findingId: 'f-1', tenantCtx: TENANT_CTX, action: 'approve' }, d);
  const input = appended[0] as {
    message: { claim: string; approved_by: string; research_job_id: string; confidence: number };
    peer: { kind: string; topicPseudonym?: string };
    session: { kind: string; jobId: string };
  };
  assert.equal(input.message.approved_by, 'user-42', 'the operator, not "system"');
  assert.equal(input.message.research_job_id, 'job-uuid-1');
  assert.equal(input.message.confidence, 0.88);
  assert.match(input.message.claim, /publish_stage_performance/);
  assert.equal(input.peer.kind, 'market_signal');
  assert.ok(input.peer.topicPseudonym, 'a market-signal memory needs a topic bucket');
  assert.equal(input.session.kind, 'curated');
});

// ── Edit ─────────────────────────────────────────────────────────────────────

test('edit promotes the operator wording, not the original', async () => {
  const { d, appended } = deps();
  const out = await resolveQueuedFinding(
    {
      findingId: 'f-1',
      tenantCtx: TENANT_CTX,
      action: 'edit',
      editedClaim: 'Reels outperform static posts for this brand.',
    },
    d,
  );
  assert.equal(out.status, 'ok');
  const input = appended[0] as { message: { claim: string } };
  assert.equal(input.message.claim, 'Reels outperform static posts for this brand.');
  assert.doesNotMatch(input.message.claim, /publish_stage_performance/);
});

test('edit requires a claim and bounds its length', async () => {
  for (const bad of [undefined, null, '', '   ']) {
    const { d } = deps();
    const out = await resolveQueuedFinding(
      { findingId: 'f-1', tenantCtx: TENANT_CTX, action: 'edit', editedClaim: bad as string },
      d,
    );
    assert.deepEqual(out, { status: 'invalid', reason: 'edited_claim_required' });
  }

  const { d, appended } = deps();
  const tooLong = 'x'.repeat(MAX_EDITED_CLAIM_LENGTH + 1);
  const out = await resolveQueuedFinding(
    { findingId: 'f-1', tenantCtx: TENANT_CTX, action: 'edit', editedClaim: tooLong },
    d,
  );
  assert.deepEqual(out, { status: 'invalid', reason: 'edited_claim_too_long' });
  assert.equal(appended.length, 0, 'a rejected input must not reach Honcho');
});

test('the original raw is preserved for provenance on an edit', async () => {
  // The edit changes what is PROMOTED, never the stored candidate — otherwise
  // the record of what Aries actually concluded is lost.
  const row = finding();
  const { d } = deps({}, row);
  await resolveQueuedFinding(
    { findingId: 'f-1', tenantCtx: TENANT_CTX, action: 'edit', editedClaim: 'reworded' },
    d,
  );
  assert.match(String(row.raw.claim), /publish_stage_performance/, 'raw is untouched');
});

// ── Reject ───────────────────────────────────────────────────────────────────

test('reject settles locally and writes NOTHING to memory', async () => {
  const { d, appended, decisions } = deps();
  const out = await resolveQueuedFinding(
    { findingId: 'f-1', tenantCtx: TENANT_CTX, action: 'reject' },
    d,
  );
  assert.deepEqual(out, {
    status: 'ok',
    findingId: 'f-1',
    decision: 'rejected',
    memoryWritten: false,
  });
  assert.equal(appended.length, 0, 'a rejected finding must never reach Honcho');
  assert.deepEqual(decisions, [['f-1', 'rejected']]);
});

// ── Isolation + idempotency ──────────────────────────────────────────────────

test('a finding this tenant does not own is NOT FOUND, never forbidden', async () => {
  // The tenant filter is in the SQL, so a cross-tenant id is indistinguishable
  // from a missing one — its existence is never confirmed.
  const { d, appended } = deps({ loadFinding: async () => null });
  const out = await resolveQueuedFinding(
    { findingId: 'someone-elses', tenantCtx: TENANT_CTX, action: 'approve' },
    d,
  );
  assert.deepEqual(out, { status: 'not_found' });
  assert.equal(appended.length, 0);
});

test('an already-settled finding is a no-op, with no second memory write', async () => {
  for (const settled of ['approved', 'rejected', 'drop']) {
    const { d, appended } = deps({}, finding({ curator_decision: settled }));
    const out = await resolveQueuedFinding(
      { findingId: 'f-1', tenantCtx: TENANT_CTX, action: 'approve' },
      d,
    );
    assert.deepEqual(out, { status: 'already_resolved', decision: settled });
    assert.equal(appended.length, 0, `${settled}: must not re-append`);
  }
});

test('losing a concurrent race reports the settled state instead of claiming success', async () => {
  // The UPDATE is guarded on queue_for_review, so a double-approve settles in
  // the database. The loser must not report ok.
  let loaded = 0;
  const out = await resolveQueuedFinding(
    { findingId: 'f-1', tenantCtx: TENANT_CTX, action: 'reject' },
    {
      loadFinding: async () => {
        loaded += 1;
        // First read: still queued. Second (post-race re-read): settled.
        return loaded === 1 ? finding() : finding({ curator_decision: 'approved' });
      },
      setDecision: async () => false, // someone else got there first
      appendToHoncho: async () => true,
    },
  );
  assert.deepEqual(out, { status: 'already_resolved', decision: 'approved' });
});

// ── Honcho unavailable ───────────────────────────────────────────────────────

test('with Honcho off the decision still lands, and says memory is pending', async () => {
  // Failing the operator's click because a downstream service is off would be
  // worse than recording the decision and reporting the gap.
  const { d, decisions } = deps({ appendToHoncho: async () => false });
  const out = await resolveQueuedFinding(
    { findingId: 'f-1', tenantCtx: TENANT_CTX, action: 'approve' },
    d,
  );
  assert.deepEqual(out, {
    status: 'ok',
    findingId: 'f-1',
    decision: 'approved',
    memoryWritten: false,
  });
  assert.deepEqual(decisions, [['f-1', 'approved']]);
});

// ── Message + peer construction ──────────────────────────────────────────────

test('a finding with no usable claim is refused rather than promoted empty', async () => {
  const { d, appended } = deps({}, finding({ raw: { kind: 'research_conclusion' } }));
  const out = await resolveQueuedFinding(
    { findingId: 'f-1', tenantCtx: TENANT_CTX, action: 'approve' },
    d,
  );
  assert.deepEqual(out, { status: 'invalid', reason: 'finding_not_promotable' });
  assert.equal(appended.length, 0);
});

test('an unsupported peer is refused, not guessed', async () => {
  const { d, appended } = deps({}, finding({ peer: 'competitor' }));
  const out = await resolveQueuedFinding(
    { findingId: 'f-1', tenantCtx: TENANT_CTX, action: 'approve' },
    d,
  );
  assert.deepEqual(out, { status: 'invalid', reason: 'unsupported_peer' });
  assert.equal(appended.length, 0, 'never file a memory under an invented peer');
});

test('peerRefFromStoredPeer handles market_signal, which the auto-approve mapper cannot', () => {
  assert.deepEqual(peerRefFromStoredPeer('brand'), { kind: 'brand' });
  assert.deepEqual(peerRefFromStoredPeer('policy'), { kind: 'policy' });
  assert.deepEqual(peerRefFromStoredPeer('market_signal', { topicPseudonym: 'abc' }), {
    kind: 'market_signal',
    topicPseudonym: 'abc',
  });
  // No topic ⇒ no bucket ⇒ refuse rather than invent one.
  assert.equal(peerRefFromStoredPeer('market_signal', {}), null);
  assert.deepEqual(peerRefFromStoredPeer('user', { actorUserId: 'u1' }), {
    kind: 'user',
    userId: 'u1',
  });
  assert.equal(peerRefFromStoredPeer('user', {}), null);
  assert.equal(peerRefFromStoredPeer(null), null);
  assert.equal(peerRefFromStoredPeer('nonsense'), null);
});

test('the topic bucket derives from the marketing job, and is stable', () => {
  const a = topicPseudonymForFinding(finding());
  const b = topicPseudonymForFinding(finding());
  assert.ok(a);
  assert.equal(a, b, 'the same job must always land in the same bucket');
  // A different marketing job is a different bucket.
  const other = topicPseudonymForFinding(
    finding({ job_task_spec: { marketing_job_id: 'mkt-job-OTHER' } }),
  );
  assert.notEqual(a, other);
  // The pseudonym must not leak the job id itself.
  assert.ok(!a!.includes('mkt-job-9'));
});

test('buildApprovedMessageFromFinding fills only what promotion knows', () => {
  const msg = buildApprovedMessageFromFinding(finding(), {
    approvedBy: 'user-42',
    now: new Date('2026-08-06T12:00:00Z'),
  });
  assert.ok(msg);
  assert.equal(msg.approved_by, 'user-42');
  assert.equal(msg.approved_at, '2026-08-06T12:00:00.000Z');
  assert.equal(msg.supersedes, null);
  assert.equal(msg.research_job_id, 'job-uuid-1');
  assert.equal(msg.sources.length, 1);
});

// ── Route contracts ──────────────────────────────────────────────────────────

const routeSource = readFileSync(
  path.join(PROJECT_ROOT, 'app', 'api', 'memory', 'findings', '[findingId]', 'resolve', 'route.ts'),
  'utf8',
);

test('the route is tenant_admin only and human-only', () => {
  assert.match(routeSource, /role !== 'tenant_admin'/);
  assert.match(routeSource, /export async function POST/);
  // No GET/PUT/DELETE surface, and no internal-secret path that would let a
  // machine caller promote its own finding.
  assert.doesNotMatch(routeSource, /export async function (GET|PUT|DELETE|PATCH)/);
  assert.doesNotMatch(routeSource, /INTERNAL_API_SECRET/);
});

test('a cross-tenant finding 404s and the tenant comes only from context', () => {
  assert.match(routeSource, /status: 404/);
  assert.match(routeSource, /getTenantContext\(\)/);
  assert.doesNotMatch(
    routeSource,
    /searchParams\.get\(\s*['"](tenant|tenantId|tenant_id)['"]\s*\)/i,
  );
});

test('the route surfaces memoryWritten rather than implying a memory exists', () => {
  assert.match(routeSource, /memoryWritten: outcome\.memoryWritten/);
});

test('the store scopes the single-finding read in SQL, not after the fact', () => {
  const store = readFileSync(
    path.join(PROJECT_ROOT, 'backend', 'memory', 'research-jobs.ts'),
    'utf8',
  );
  assert.match(store, /WHERE f\.id = \$1::uuid\s*\n\s*AND j\.tenant_id = \$2/);
  // The decision UPDATE is guarded in the statement so a concurrent
  // double-approve settles in the database.
  assert.match(store, /AND curator_decision = 'queue_for_review'/);
});

test('a promoted finding leaves the review queue', () => {
  // The cross-module contract that makes this feature real: the queue lists
  // ONLY queue_for_review, so approving or rejecting removes the card.
  const store = readFileSync(
    path.join(PROJECT_ROOT, 'backend', 'memory', 'research-jobs.ts'),
    'utf8',
  );
  assert.match(store, /f\.curator_decision = 'queue_for_review'/);
  for (const terminal of TERMINAL_CURATOR_DECISIONS) {
    assert.notEqual(terminal, 'queue_for_review');
  }
});
