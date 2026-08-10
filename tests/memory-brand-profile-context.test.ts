/**
 * ITEM A READ LEG — `createMemoryOrchestrator(...).loadBrandProfileContext`.
 *
 * The compounding per-brand profile: two dialectic queries (peer-brand "what
 * works", peer-policy "what to avoid") composed into one token-capped block.
 * Faked client throughout — no Honcho, no network.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createMemoryOrchestrator, BRAND_PROFILE_QUERY, BRAND_AVOID_QUERY } from '../backend/memory/orchestrator';
import type { TenantMemoryClient, PeerRef } from '../backend/memory/honcho-client';

const CTX = { tenantId: 't-1', tenantSlug: 'slug', userId: 'system', role: 'tenant_admin' as const };

type Answerer = (peer: PeerRef, query: string) => Promise<string | null>;

function fakeClient(answer: Answerer): { client: TenantMemoryClient; asked: Array<{ peer: string; query: string }> } {
  const asked: Array<{ peer: string; query: string }> = [];
  const client = {
    async dialecticQuery(input: { peer: PeerRef; query: string }) {
      asked.push({ peer: input.peer.kind, query: input.query });
      return answer(input.peer, input.query);
    },
  } as unknown as TenantMemoryClient;
  return { client, asked };
}

test('composes both dialectic answers under labelled sections', async () => {
  const { client, asked } = fakeClient(async (peer) =>
    peer.kind === 'brand'
      ? 'Audience skews 25-40 urban. Reels with a hands-on demo outperform statics 3x.'
      : 'Avoid discount-led messaging; two price-cut angles were denied.',
  );
  const orchestrator = createMemoryOrchestrator(client);
  const profile = await orchestrator.loadBrandProfileContext(CTX, { tokenBudget: 1024 });

  assert.ok(profile);
  assert.equal(profile.truncated, false);
  assert.match(profile.text, /^Known about this brand:\nAudience skews 25-40 urban\./);
  assert.match(profile.text, /\n\nAvoid:\nAvoid discount-led messaging;/);

  // One query per peer, with the intended phrasing.
  assert.deepEqual(asked.map((a) => a.peer), ['brand', 'policy']);
  assert.equal(asked[0]!.query, BRAND_PROFILE_QUERY);
  assert.equal(asked[1]!.query, BRAND_AVOID_QUERY);
});

test('the two queries run concurrently, not one after the other', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const { client } = fakeClient(async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await Promise.resolve();
    inFlight -= 1;
    return 'something';
  });
  const orchestrator = createMemoryOrchestrator(client);
  await orchestrator.loadBrandProfileContext(CTX, { tokenBudget: 1024 });

  assert.equal(maxInFlight, 2, 'both dialectic calls must be in flight together');
});

test('one peer failing never costs the other (per-call fail-open)', async () => {
  const { client } = fakeClient(async (peer) => {
    if (peer.kind === 'policy') throw new Error('honcho 500');
    return 'Reels outperform statics.';
  });
  const orchestrator = createMemoryOrchestrator(client);
  const profile = await orchestrator.loadBrandProfileContext(CTX, { tokenBudget: 1024 });

  assert.ok(profile);
  assert.match(profile.text, /Known about this brand:\nReels outperform statics\./);
  assert.ok(!profile.text.includes('Avoid:'), 'no empty Avoid section when that call failed');
});

test('both calls failing yields null (caller renders no block at all)', async () => {
  const { client } = fakeClient(async () => {
    throw new Error('ECONNREFUSED');
  });
  const orchestrator = createMemoryOrchestrator(client);
  assert.equal(await orchestrator.loadBrandProfileContext(CTX, { tokenBudget: 1024 }), null);
});

test('empty / bare-"unknown" answers are dropped rather than rendered', async () => {
  const { client } = fakeClient(async (peer) => (peer.kind === 'brand' ? 'unknown.' : '   '));
  const orchestrator = createMemoryOrchestrator(client);
  assert.equal(
    await orchestrator.loadBrandProfileContext(CTX, { tokenBudget: 1024 }),
    null,
    'an empty representation must not produce a "Known about this brand: unknown" block',
  );
});

test('token budget caps the composed block and flags truncation', async () => {
  const { client } = fakeClient(async () => 'x'.repeat(5000));
  const orchestrator = createMemoryOrchestrator(client);
  const profile = await orchestrator.loadBrandProfileContext(CTX, { tokenBudget: 100 });

  assert.ok(profile);
  assert.equal(profile.truncated, true);
  // 100 tokens ≈ 400 chars, plus the truncation marker.
  assert.ok(profile.text.length <= 400 + '\n…[truncated]'.length);
  assert.ok(profile.text.endsWith('…[truncated]'));
});
