/**
 * Self-contained unit tests for readVariantTagsFromDoc — the doc-driven variant
 * tag reader used by production-asset ingestion (the Hermes callback carries no
 * callback_context, so tags ride doc.inputs.request).
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/onboarding/ingest-variant-tags.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { readVariantTagsFromDoc, isVariantBoardJobAwaitingPick } from '../../backend/marketing/ingest-production-assets';

const doc = (request: unknown) => ({ inputs: { request } }) as never;

test('reads a fully-tagged variant job (number index)', () => {
  assert.deepEqual(readVariantTagsFromDoc(doc({ variant_batch_id: 'vbatch_x', variant_index: 2 })), {
    variantBatchId: 'vbatch_x',
    variantIndex: 2,
  });
});

test('parses a string variant_index and index 0', () => {
  assert.deepEqual(readVariantTagsFromDoc(doc({ variant_batch_id: 'vbatch_x', variant_index: '0' })), {
    variantBatchId: 'vbatch_x',
    variantIndex: 0,
  });
});

test('accepts camelCase keys', () => {
  assert.deepEqual(readVariantTagsFromDoc(doc({ variantBatchId: 'vbatch_y', variantIndex: 1 })), {
    variantBatchId: 'vbatch_y',
    variantIndex: 1,
  });
});

test('untagged (normal weekly) job → nulls, so non-variant assets stay NULL', () => {
  assert.deepEqual(readVariantTagsFromDoc(doc({ primaryGoal: 'x' })), { variantBatchId: null, variantIndex: null });
});

test('half-set pairs are treated as untagged', () => {
  assert.deepEqual(readVariantTagsFromDoc(doc({ variant_batch_id: 'vbatch_x' })), { variantBatchId: null, variantIndex: null });
  assert.deepEqual(readVariantTagsFromDoc(doc({ variant_index: 1 })), { variantBatchId: null, variantIndex: null });
});

test('missing / non-object request → nulls', () => {
  assert.deepEqual(readVariantTagsFromDoc(doc(null)), { variantBatchId: null, variantIndex: null });
  assert.deepEqual(readVariantTagsFromDoc({ inputs: {} } as never), { variantBatchId: null, variantIndex: null });
});

test('negative or non-numeric index → nulls', () => {
  assert.deepEqual(readVariantTagsFromDoc(doc({ variant_batch_id: 'v', variant_index: -1 })), { variantBatchId: null, variantIndex: null });
  assert.deepEqual(readVariantTagsFromDoc(doc({ variant_batch_id: 'v', variant_index: 'abc' })), { variantBatchId: null, variantIndex: null });
  assert.deepEqual(readVariantTagsFromDoc(doc({ variant_batch_id: 'v', variant_index: 1.5 })), { variantBatchId: null, variantIndex: null });
});

// --- isVariantBoardJobAwaitingPick (publish suppression gate) ---------------

test('isVariantBoardJobAwaitingPick: a variant job not yet finalized must be held from publish', () => {
  assert.equal(isVariantBoardJobAwaitingPick(doc({ variant_batch_id: 'vbatch_x', variant_index: 0 })), true);
});

test('isVariantBoardJobAwaitingPick: a finalized (picked) variant job is released to publish', () => {
  assert.equal(
    isVariantBoardJobAwaitingPick(doc({ variant_batch_id: 'vbatch_x', variant_index: 0, variant_pick_finalized: true })),
    false,
  );
});

test('isVariantBoardJobAwaitingPick: a normal weekly job is never held (no variant tag)', () => {
  assert.equal(isVariantBoardJobAwaitingPick(doc({ primaryGoal: 'x' })), false);
  assert.equal(isVariantBoardJobAwaitingPick(doc(null)), false);
});
