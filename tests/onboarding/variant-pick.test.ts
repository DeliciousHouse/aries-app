/**
 * Self-contained unit tests for recordVariantPick — the pick state transition
 * (record chosen variant + release ONLY the chosen job to publish). Uses a
 * per-test mkdtemp DATA_ROOT for the batch record and an injected in-memory job
 * doc store, no orchestrator / live DB.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/onboarding/variant-pick.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { recordVariantPick } from '../../backend/marketing/onboarding-variant-batch';
import {
  claimVariantPick,
  saveVariantBatch,
  loadVariantBatch,
  makeVariantBatchId,
  VARIANT_BATCH_SCHEMA_NAME,
  VARIANT_BATCH_SCHEMA_VERSION,
} from '../../backend/marketing/variant-batch-store';

process.env.DATA_ROOT = mkdtempSync(path.join(os.tmpdir(), 'aries-variant-pick-'));

function makeBatch(batchId: string, overrides: Record<string, unknown> = {}) {
  return {
    schema_name: VARIANT_BATCH_SCHEMA_NAME,
    schema_version: VARIANT_BATCH_SCHEMA_VERSION,
    batch_id: batchId,
    tenant_id: '7',
    user_id: '42',
    slot_index: 0,
    job_ids: ['mkt_0', 'mkt_1', 'mkt_2'],
    created_at: new Date().toISOString(),
    picked_variant_index: null,
    picked_creative_id: null,
    picked_at: null,
    abandoned_at: null,
    ...overrides,
  } as never;
}

function makeDocStore() {
  const docs = new Map<string, { job_id: string; tenant_id: string; inputs: { request: Record<string, unknown> } }>();
  for (const id of ['mkt_0', 'mkt_1', 'mkt_2']) {
    docs.set(id, { job_id: id, tenant_id: '7', inputs: { request: { variant_batch_id: 'b', variant_index: 0 } } });
  }
  const saved: string[] = [];
  return {
    docs,
    saved,
    loadJobDoc: async (jobId: string) => (docs.get(jobId) ?? null) as never,
    saveJobDoc: ((jobId: string, doc: never) => {
      docs.set(jobId, doc as never);
      saved.push(jobId);
      return `/path/${jobId}`;
    }) as never,
  };
}

test('recordVariantPick records the pick and releases ONLY the chosen job to publish', async () => {
  const batchId = makeVariantBatchId();
  saveVariantBatch(makeBatch(batchId));
  const store = makeDocStore();
  const res = await recordVariantPick({
    batchId,
    tenantId: '7',
    selectedVariantIndex: 1,
    selectedCreativeId: 'creative_b',
    loadJobDoc: store.loadJobDoc,
    saveJobDoc: store.saveJobDoc,
  });
  assert.equal(res.kind, 'picked');
  if (res.kind === 'picked') assert.equal(res.finalizedJobId, 'mkt_1');
  // chosen job released, unchosen ones left held + untouched.
  assert.equal(store.docs.get('mkt_1')!.inputs.request.variant_pick_finalized, true);
  assert.deepEqual(store.saved, ['mkt_1'], 'only the chosen job doc is re-saved');
  assert.notEqual(store.docs.get('mkt_0')!.inputs.request.variant_pick_finalized, true);
  assert.notEqual(store.docs.get('mkt_2')!.inputs.request.variant_pick_finalized, true);
  // batch record updated.
  const reloaded = await loadVariantBatch(batchId);
  assert.equal(reloaded!.picked_variant_index, 1);
  assert.equal(reloaded!.picked_creative_id, 'creative_b');
  assert.ok(reloaded!.picked_at);
});

test('recordVariantPick returns not_found / tenant_mismatch / invalid_variant', async () => {
  assert.equal((await recordVariantPick({ batchId: 'vbatch_nope', tenantId: '7', selectedVariantIndex: 0 })).kind, 'not_found');
  const batchId = makeVariantBatchId();
  saveVariantBatch(makeBatch(batchId));
  assert.equal((await recordVariantPick({ batchId, tenantId: '999', selectedVariantIndex: 0 })).kind, 'tenant_mismatch');
  assert.equal((await recordVariantPick({ batchId, tenantId: '7', selectedVariantIndex: 5 })).kind, 'invalid_variant');
  assert.equal((await recordVariantPick({ batchId, tenantId: '7', selectedVariantIndex: -1 })).kind, 'invalid_variant');
  assert.equal((await recordVariantPick({ batchId, tenantId: '7', selectedVariantIndex: 1.5 })).kind, 'invalid_variant');
});

test('recordVariantPick is a no-op on an already picked or abandoned batch', async () => {
  const pickedId = makeVariantBatchId();
  saveVariantBatch(makeBatch(pickedId, { picked_variant_index: 0, picked_at: new Date().toISOString() }));
  const r1 = await recordVariantPick({ batchId: pickedId, tenantId: '7', selectedVariantIndex: 2 });
  assert.equal(r1.kind, 'already_resolved');
  if (r1.kind === 'already_resolved') assert.equal(r1.pickedVariantIndex, 0);

  const abandonedId = makeVariantBatchId();
  saveVariantBatch(makeBatch(abandonedId, { abandoned_at: new Date().toISOString() }));
  assert.equal((await recordVariantPick({ batchId: abandonedId, tenantId: '7', selectedVariantIndex: 2 })).kind, 'already_resolved');
});

test('claimVariantPick is exclusive — a second claim on the same batch fails', () => {
  const batchId = makeVariantBatchId();
  saveVariantBatch(makeBatch(batchId));
  assert.equal(claimVariantPick(batchId), true, 'first claim wins');
  assert.equal(claimVariantPick(batchId), false, 'second claim loses (already claimed)');
});

test('recordVariantPick treats a lost pick claim as already_resolved (concurrent-pick guard)', async () => {
  const batchId = makeVariantBatchId();
  saveVariantBatch(makeBatch(batchId));
  // Simulate a concurrent request that already claimed the pick.
  assert.equal(claimVariantPick(batchId), true);
  const res = await recordVariantPick({
    batchId,
    tenantId: '7',
    selectedVariantIndex: 1,
    loadJobDoc: (async () => null) as never,
    saveJobDoc: (() => '') as never,
  });
  assert.equal(res.kind, 'already_resolved', 'the loser does not double-finalize');
});
