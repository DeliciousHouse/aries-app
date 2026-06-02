/**
 * Handler tests for the onboarding variant board endpoints: auth gating, input
 * validation, response mapping, and no-leak 404s. The tenant loader and the
 * board/pick deps are injected, so no session, DB, or filesystem is touched.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/onboarding/variant-endpoints.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { handleVariantBoardGet, handleVariantPickPost } from '../../app/api/onboarding/variants/[batchId]/handler';

const fakeLoader = (async () => ({ userId: '42', tenantId: '7', tenantSlug: 'acme', role: 'tenant_admin' as const })) as never;

const sampleBoard = {
  batch_id: 'vbatch_x',
  slot_index: 0,
  board_ready: true,
  picked_variant_index: null,
  picked_creative_id: null,
  abandoned: false,
  cards: [{ variant_index: 0, creative_id: 'a', served_asset_ref: '/api/internal/hermes/media/a' }],
} as never;

test('GET board: missing batch id → 400 before any tenant work', async () => {
  const res = await handleVariantBoardGet('   ');
  assert.equal(res.status, 400);
});

test('GET board: found → 200 with the board view', async () => {
  const res = await handleVariantBoardGet('vbatch_x', { tenantContextLoader: fakeLoader, getBoard: async () => sampleBoard });
  assert.equal(res.status, 200);
  const json = (await res.json()) as { status: string; board: { batch_id: string } };
  assert.equal(json.status, 'ok');
  assert.equal(json.board.batch_id, 'vbatch_x');
});

test('GET board: unknown batch / tenant mismatch → 404 (no existence leak)', async () => {
  let askedTenant = '';
  const res = await handleVariantBoardGet('vbatch_x', {
    tenantContextLoader: fakeLoader,
    getBoard: async (args) => {
      askedTenant = args.tenantId;
      return null;
    },
  });
  assert.equal(res.status, 404);
  assert.equal(askedTenant, '7', 'board read is scoped to the session tenant');
});

test('POST pick: non-integer selected variant → 400', async () => {
  const res = await handleVariantPickPost(
    'vbatch_x',
    { selectedVariantIndex: 'nope' },
    { tenantContextLoader: fakeLoader, recordPick: async () => ({ kind: 'invalid_variant' }) },
  );
  assert.equal(res.status, 400);
});

test('POST pick: valid pick → 200, forwards index + creative + session tenant', async () => {
  let captured: Record<string, unknown> = {};
  const res = await handleVariantPickPost(
    'vbatch_x',
    { selectedVariantIndex: 1, selectedVariantId: 'creative_b' },
    {
      tenantContextLoader: fakeLoader,
      recordPick: async (args) => {
        captured = args;
        return { kind: 'picked', batchId: 'vbatch_x', pickedVariantIndex: 1, finalizedJobId: 'mkt_1' };
      },
      finalize: (async () => ({ tasteSignals: 0, honchoScheduled: 0, phaseBJobId: null })) as never,
    },
  );
  assert.equal(res.status, 200);
  const json = (await res.json()) as { pickedVariantIndex: number; finalizedJobId: string };
  assert.equal(json.pickedVariantIndex, 1);
  assert.equal(json.finalizedJobId, 'mkt_1');
  assert.equal(captured.selectedVariantIndex, 1);
  assert.equal(captured.selectedCreativeId, 'creative_b');
  assert.equal(captured.tenantId, '7', 'tenant is server-derived, never from the body');
});

test('POST pick: already resolved → 200 alreadyResolved', async () => {
  const res = await handleVariantPickPost(
    'vbatch_x',
    { selectedVariantIndex: 1 },
    { tenantContextLoader: fakeLoader, recordPick: async () => ({ kind: 'already_resolved', pickedVariantIndex: 0 }) },
  );
  const json = (await res.json()) as { alreadyResolved: boolean };
  assert.equal(json.alreadyResolved, true);
});

test('POST pick: not_found / tenant_mismatch → 404', async () => {
  const nf = await handleVariantPickPost('vbatch_x', { selectedVariantIndex: 1 }, { tenantContextLoader: fakeLoader, recordPick: async () => ({ kind: 'not_found' }) });
  assert.equal(nf.status, 404);
  const tm = await handleVariantPickPost('vbatch_x', { selectedVariantIndex: 1 }, { tenantContextLoader: fakeLoader, recordPick: async () => ({ kind: 'tenant_mismatch' }) });
  assert.equal(tm.status, 404);
});
