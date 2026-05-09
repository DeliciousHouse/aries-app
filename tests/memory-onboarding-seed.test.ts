import assert from 'node:assert/strict';
import test from 'node:test';

import { seedOnboardingMemory } from '../backend/memory/onboarding-seed';
import { TenantMemoryClient } from '../backend/memory/honcho-client';
import type { HonchoTransport } from '../backend/memory/honcho-client';
import type { AppendApprovedMessageInput } from '../backend/memory/honcho-client';

const SALT = 'onboarding-seed-test-salt-abcde';
const NOW = '2026-05-08T00:00:00.000Z';

function withSalt<T>(run: () => Promise<T>): Promise<T> {
  const prev = process.env.ARIES_TENANT_PSEUDONYM_SALT;
  process.env.ARIES_TENANT_PSEUDONYM_SALT = SALT;
  return Promise.resolve(run()).finally(() => {
    if (prev === undefined) delete process.env.ARIES_TENANT_PSEUDONYM_SALT;
    else process.env.ARIES_TENANT_PSEUDONYM_SALT = prev;
  });
}

function makeCtx() {
  return {
    tenantId: 'onboarding-test-tenant',
    tenantSlug: 'onboarding-test',
    userId: 'user-onboarding',
    role: 'tenant_admin' as const,
  };
}

type WriteCall = { input: AppendApprovedMessageInput; messageId: string };

function recordingClient(): { client: TenantMemoryClient; writes: WriteCall[] } {
  const writes: WriteCall[] = [];
  const transport: HonchoTransport = {
    async request<T>(args: { method: string; path: string; workspaceId: string; body?: unknown }): Promise<T> {
      return { id: `msg-${writes.length + 1}`, items: [] } as unknown as T;
    },
  };
  const inner = new TenantMemoryClient(transport);
  const client = new Proxy(inner, {
    get(target, prop) {
      if (prop === 'appendApprovedMessage') {
        return async (input: AppendApprovedMessageInput) => {
          const messageId = `msg-${writes.length + 1}`;
          writes.push({ input, messageId });
          return { messageId };
        };
      }
      return (target as unknown as Record<string | symbol, unknown>)[prop];
    },
  }) as TenantMemoryClient;
  return { client, writes };
}

const RUN_ID = 'run-onboard-001';

const CLEAN_BRAND_FACT = {
  kind: 'fact' as const,
  claim: 'Acme Corp was founded in 2018 and focuses on B2B SaaS.',
  sources: [{ url: 'https://acme.example.com/about', fetched_at: NOW, trust: 'first_party' as const }],
  confidence: 0.92,
};

const INFERRED_TONE = {
  kind: 'research_conclusion' as const,
  claim: 'Brand tone is professional with occasional humor.',
  sources: [{ url: 'https://acme.example.com/blog', fetched_at: NOW, trust: 'third_party' as const }],
  confidence: 0.88,
};

const LOW_CONFIDENCE = {
  kind: 'fact' as const,
  claim: 'Maybe Acme sponsors events.',
  sources: [{ url: 'https://acme.example.com/events', fetched_at: NOW, trust: 'first_party' as const }],
  confidence: 0.35,
};

test('clean first-party brand fact auto-approves, reaches Honcho exactly once', async () => {
  await withSalt(async () => {
    const { client, writes } = recordingClient();
    const result = await seedOnboardingMemory(makeCtx(), {
      runId: RUN_ID,
      candidates: [CLEAN_BRAND_FACT],
    }, client);

    assert.equal(result.counts.approved, 1);
    assert.equal(result.counts.queued, 0);
    assert.equal(result.counts.dropped, 0);
    assert.equal(writes.length, 1);
  });
});

test('auto-approved fact goes to peer-brand under session-onboarding-<runId>', async () => {
  await withSalt(async () => {
    const { client, writes } = recordingClient();
    await seedOnboardingMemory(makeCtx(), {
      runId: RUN_ID,
      candidates: [CLEAN_BRAND_FACT],
    }, client);

    assert.equal(writes.length, 1);
    const { input } = writes[0];
    assert.equal(input.peer.kind, 'brand');
    assert.equal(input.session.kind, 'onboarding');
    if (input.session.kind === 'onboarding') {
      assert.equal(input.session.runId, RUN_ID);
    }
  });
});

test('inferred-tone third-party-derived claim is queued, not written to Honcho', async () => {
  await withSalt(async () => {
    const { client, writes } = recordingClient();
    const result = await seedOnboardingMemory(makeCtx(), {
      runId: RUN_ID,
      candidates: [INFERRED_TONE],
    }, client);

    assert.equal(result.counts.queued, 1);
    assert.equal(result.counts.approved, 0);
    assert.equal(writes.length, 0);
    assert.equal(result.results[0].outcome.decision, 'queue_for_review');
  });
});

test('low-confidence first-party claim is dropped', async () => {
  await withSalt(async () => {
    const { client, writes } = recordingClient();
    const result = await seedOnboardingMemory(makeCtx(), {
      runId: RUN_ID,
      candidates: [LOW_CONFIDENCE],
    }, client);

    assert.equal(result.counts.dropped, 1);
    assert.equal(result.counts.approved, 0);
    assert.equal(writes.length, 0);
    assert.equal(result.results[0].outcome.decision, 'drop');
  });
});

test('three candidates together: 1 approved, 1 queued, 1 dropped — exactly one Honcho write', async () => {
  await withSalt(async () => {
    const { client, writes } = recordingClient();
    const result = await seedOnboardingMemory(makeCtx(), {
      runId: RUN_ID,
      candidates: [CLEAN_BRAND_FACT, INFERRED_TONE, LOW_CONFIDENCE],
    }, client);

    assert.equal(result.counts.approved, 1);
    assert.equal(result.counts.queued, 1);
    assert.equal(result.counts.dropped, 1);
    assert.equal(writes.length, 1);
  });
});

test('messageId present on approved result, absent on others', async () => {
  await withSalt(async () => {
    const { client } = recordingClient();
    const result = await seedOnboardingMemory(makeCtx(), {
      runId: RUN_ID,
      candidates: [CLEAN_BRAND_FACT, INFERRED_TONE, LOW_CONFIDENCE],
    }, client);

    const approvedResult = result.results.find(r => r.outcome.decision === 'auto_approve');
    assert.ok(approvedResult?.messageId, 'approved result must have a messageId');

    for (const r of result.results.filter(r => r.outcome.decision !== 'auto_approve')) {
      assert.equal(r.messageId, undefined, 'non-approved result must not have a messageId');
    }
  });
});
