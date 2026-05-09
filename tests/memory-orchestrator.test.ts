import assert from 'node:assert/strict';
import test from 'node:test';

import { createMemoryOrchestrator } from '../backend/memory/orchestrator';
import type { TenantMemoryClient } from '../backend/memory/honcho-client';
import type { ApprovedMessage } from '../backend/memory/types';

const BASE_CTX = {
  tenantId: 'tenant-1',
  tenantSlug: 'tenant-1',
  userId: 'user-1',
  role: 'tenant_admin' as const,
};

const NOW = '2026-05-08T00:00:00.000Z';

function makeApprovedMessage(overrides: Partial<ApprovedMessage> = {}): ApprovedMessage {
  return {
    kind: 'fact',
    claim: 'Acme was founded in 2018.',
    sources: [{ url: 'https://acme.example.com/about', fetched_at: NOW, trust: 'first_party' }],
    confidence: 0.9,
    approved_by: 'system',
    approved_at: NOW,
    supersedes: null,
    research_job_id: 'job-1',
    ...overrides,
  };
}

function makeFakeClient(messages: ApprovedMessage[]): TenantMemoryClient {
  const appended: Array<{ message: ApprovedMessage; messageId: string }> = [];
  return {
    workspaceId: () => 'aries-tenant-abc123',
    ensureWorkspace: async () => ({ workspaceId: 'aries-tenant-abc123' }),
    deleteWorkspace: async () => ({ workspaceId: 'aries-tenant-abc123' }),
    listApprovedMessages: async () => messages,
    appendApprovedMessage: async (input: { message: ApprovedMessage }) => {
      const messageId = `msg-${appended.length + 1}`;
      appended.push({ message: input.message, messageId });
      return { messageId };
    },
    _appended: appended,
  } as unknown as TenantMemoryClient;
}

test('loadResearchMemoryContext returns non-superseded messages only', async () => {
  const old = makeApprovedMessage({ claim: 'Old brand name was Acme Inc.', research_job_id: 'job-0', approved_at: '2026-01-01T00:00:00.000Z' });
  const newer = makeApprovedMessage({ claim: 'Brand name is Acme Corp.', supersedes: null, research_job_id: 'job-1' });
  const superseding = makeApprovedMessage({ claim: 'Brand name is now ACME.', supersedes: `job-0:2026-01-01T00:00:00.000Z:Old brand name was Acme Inc.`, research_job_id: 'job-2' });

  const messages = [old, newer, superseding];

  const fakeClient = {
    workspaceId: () => 'aries-tenant-test',
    listApprovedMessages: async ({ includeSuperseded }: { includeSuperseded?: boolean }) => {
      if (includeSuperseded) return messages;
      const supersededKeys = new Set<string>();
      for (const m of messages) {
        if (m.supersedes) supersededKeys.add(m.supersedes);
      }
      return messages.filter(m => {
        const key = `${m.research_job_id}:${m.approved_at}:${m.claim.slice(0, 64)}`;
        return !supersededKeys.has(key);
      });
    },
    appendApprovedMessage: async () => ({ messageId: 'msg-x' }),
    ensureWorkspace: async () => ({ workspaceId: 'x' }),
    deleteWorkspace: async () => ({ workspaceId: 'x' }),
  } as unknown as TenantMemoryClient;

  const orchestrator = createMemoryOrchestrator(fakeClient);
  const { memoryContext, truncated } = await orchestrator.loadResearchMemoryContext(BASE_CTX, {
    peers: [{ kind: 'brand' }],
    tokenBudget: 10000,
  });

  assert.equal(truncated, false);
  const claims = memoryContext.map(e => e.claim);
  assert.ok(!claims.includes('Old brand name was Acme Inc.'), 'superseded message should not appear');
  assert.ok(claims.includes('Brand name is now ACME.'), 'superseding message should appear');
});

test('loadResearchMemoryContext caps by token budget', async () => {
  const messages: ApprovedMessage[] = Array.from({ length: 10 }, (_, i) =>
    makeApprovedMessage({ claim: 'A'.repeat(100), research_job_id: `job-${i}`, approved_at: `2026-05-0${i + 1}T00:00:00.000Z` }),
  );

  const fakeClient = makeFakeClient(messages);
  const orchestrator = createMemoryOrchestrator(fakeClient);

  const { memoryContext, truncated } = await orchestrator.loadResearchMemoryContext(BASE_CTX, {
    peers: [{ kind: 'brand' }],
    tokenBudget: 100,
  });

  assert.equal(truncated, true);
  assert.ok(memoryContext.length < 10, 'should have fewer than 10 entries with small budget');
  for (const entry of memoryContext) {
    assert.ok(!('approved_by' in entry), 'should not include approved_by in context');
    assert.ok(!('supersedes' in entry), 'should not include supersedes in context');
  }
});

test('loadResearchMemoryContext strips internal db ids and tenant ids', async () => {
  const msg = makeApprovedMessage({ claim: 'Brand name is Acme.' });
  const fakeClient = makeFakeClient([msg]);
  const orchestrator = createMemoryOrchestrator(fakeClient);

  const { memoryContext } = await orchestrator.loadResearchMemoryContext(BASE_CTX, {
    peers: [{ kind: 'brand' }],
    tokenBudget: 10000,
  });

  assert.equal(memoryContext.length, 1);
  const entry = memoryContext[0];
  assert.ok(!('approved_by' in entry));
  assert.ok(!('supersedes' in entry));
  assert.ok('claim' in entry);
  assert.ok('kind' in entry);
  assert.ok('confidence' in entry);
  assert.ok('sources' in entry);
  assert.ok('research_job_id' in entry);
});

test('appendCuratedFinding auto-approves first-party fact and writes to Honcho', async () => {
  const fakeClient = makeFakeClient([]);
  const orchestrator = createMemoryOrchestrator(fakeClient);

  const result = await orchestrator.appendCuratedFinding(BASE_CTX, {
    jobId: 'job-abc',
    finding: {
      kind: 'fact',
      claim: 'Acme was founded in 2018.',
      sources: [{ url: 'https://acme.example.com/about', fetched_at: NOW, trust: 'first_party' }],
      confidence: 0.9,
    },
  });

  assert.equal(result.outcome.decision, 'auto_approve');
  assert.ok(result.messageId, 'should have a message ID from Honcho');
});

test('appendCuratedFinding queues third-party finding and does not write to Honcho', async () => {
  const appended: unknown[] = [];
  const fakeClient = {
    workspaceId: () => 'aries-tenant-test',
    listApprovedMessages: async () => [],
    appendApprovedMessage: async (input: unknown) => {
      appended.push(input);
      return { messageId: 'msg-x' };
    },
    ensureWorkspace: async () => ({ workspaceId: 'x' }),
    deleteWorkspace: async () => ({ workspaceId: 'x' }),
  } as unknown as TenantMemoryClient;

  const orchestrator = createMemoryOrchestrator(fakeClient);

  const result = await orchestrator.appendCuratedFinding(BASE_CTX, {
    jobId: 'job-abc',
    finding: {
      kind: 'research_conclusion',
      claim: 'Competitor X repositioned upmarket.',
      sources: [{ url: 'https://news.example.com/art', fetched_at: NOW, trust: 'third_party' }],
      confidence: 0.95,
    },
  });

  assert.equal(result.outcome.decision, 'queue_for_review');
  assert.equal(result.messageId, undefined);
  assert.equal(appended.length, 0, 'should not write to Honcho for queued finding');
});

test('appendCuratedFinding drops low-confidence finding', async () => {
  const fakeClient = makeFakeClient([]);
  const orchestrator = createMemoryOrchestrator(fakeClient);

  const result = await orchestrator.appendCuratedFinding(BASE_CTX, {
    jobId: 'job-abc',
    finding: {
      kind: 'fact',
      claim: 'Acme might be doing something.',
      sources: [{ url: 'https://acme.example.com/about', fetched_at: NOW, trust: 'first_party' }],
      confidence: 0.3,
    },
  });

  assert.equal(result.outcome.decision, 'drop');
  assert.equal(result.messageId, undefined);
});
