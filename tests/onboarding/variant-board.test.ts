/**
 * Self-contained unit tests for the variant board read + timeout logic.
 * summarizeVariantBoard is pure (deterministic nowMs); getVariantBoard is
 * exercised with a mock pg client + a per-test mkdtemp DATA_ROOT (for the batch
 * record file), no live DB.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/onboarding/variant-board.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { summarizeVariantBoard, getVariantBoard, VARIANT_COUNT } from '../../backend/marketing/onboarding-variant-batch';
import {
  saveVariantBatch,
  loadVariantBatch,
  makeVariantBatchId,
  VARIANT_BATCH_SCHEMA_NAME,
  VARIANT_BATCH_SCHEMA_VERSION,
} from '../../backend/marketing/variant-batch-store';

// DATA_ROOT is read lazily at call time; set before any test body runs.
process.env.DATA_ROOT = mkdtempSync(path.join(os.tmpdir(), 'aries-variant-board-'));

const TIMEOUT_MS = 15 * 60 * 1000;
const NOW = Date.parse('2026-06-02T12:00:00.000Z');

function makeBatch(overrides: Record<string, unknown> = {}) {
  return {
    schema_name: VARIANT_BATCH_SCHEMA_NAME,
    schema_version: VARIANT_BATCH_SCHEMA_VERSION,
    batch_id: 'vbatch_test',
    tenant_id: '7',
    user_id: '42',
    slot_index: 0,
    job_ids: ['mkt_a', 'mkt_b', 'mkt_c'],
    created_at: new Date(NOW).toISOString(),
    picked_variant_index: null,
    picked_creative_id: null,
    picked_at: null,
    abandoned_at: null,
    ...overrides,
  } as never;
}

const asset = (variant_index: number, creative_id: string) => ({ variant_index, creative_id, served_asset_ref: `/api/internal/hermes/media/${creative_id}` });

test('summarizeVariantBoard: all variants present → board ready, not abandoned', () => {
  const { view, shouldAbandon } = summarizeVariantBoard(
    makeBatch(),
    [asset(0, 'a'), asset(1, 'b'), asset(2, 'c')],
    NOW + 1000,
    TIMEOUT_MS,
  );
  assert.equal(shouldAbandon, false);
  assert.equal(view.board_ready, true);
  assert.equal(view.abandoned, false);
  assert.equal(view.picked_variant_index, null);
  assert.deepEqual(view.cards.map((c) => c.variant_index), [0, 1, 2]);
});

test('summarizeVariantBoard: partial + fresh → not ready, not abandoned', () => {
  const { view, shouldAbandon } = summarizeVariantBoard(makeBatch(), [asset(0, 'a'), asset(1, 'b')], NOW + 1000, TIMEOUT_MS);
  assert.equal(shouldAbandon, false);
  assert.equal(view.board_ready, false);
  assert.equal(view.cards.length, 2);
});

test('summarizeVariantBoard: partial + stale past timeout → auto-abandon picks variant 0', () => {
  const { view, shouldAbandon } = summarizeVariantBoard(makeBatch(), [asset(0, 'a')], NOW + TIMEOUT_MS + 1, TIMEOUT_MS);
  assert.equal(shouldAbandon, true);
  assert.equal(view.board_ready, true, 'a timed-out board still resolves so the draft never hangs');
  assert.equal(view.abandoned, true);
  assert.equal(view.picked_variant_index, 0);
});

test('summarizeVariantBoard: already picked → ready, no re-abandon', () => {
  const { view, shouldAbandon } = summarizeVariantBoard(
    makeBatch({ picked_variant_index: 1 }),
    [asset(1, 'b')],
    NOW + TIMEOUT_MS + 1,
    TIMEOUT_MS,
  );
  assert.equal(shouldAbandon, false, 'a picked board is never abandoned');
  assert.equal(view.board_ready, true);
  assert.equal(view.picked_variant_index, 1);
});

test('summarizeVariantBoard: already abandoned → ready, no second abandon', () => {
  const { view, shouldAbandon } = summarizeVariantBoard(
    makeBatch({ abandoned_at: new Date(NOW).toISOString(), picked_variant_index: 0 }),
    [asset(0, 'a')],
    NOW + 10 * TIMEOUT_MS,
    TIMEOUT_MS,
  );
  assert.equal(shouldAbandon, false);
  assert.equal(view.abandoned, true);
  assert.equal(view.board_ready, true);
});

test('summarizeVariantBoard: duplicate variant_index rows collapse to one card each', () => {
  const { view } = summarizeVariantBoard(
    makeBatch(),
    [asset(0, 'a1'), asset(0, 'a2'), asset(1, 'b'), asset(2, 'c'), asset(2, 'c2')],
    NOW + 1000,
    TIMEOUT_MS,
  );
  assert.equal(view.cards.length, VARIANT_COUNT, 'one card per distinct variant_index');
  assert.equal(view.cards[0].creative_id, 'a1', 'first asset per index wins');
});

test('summarizeVariantBoard: timeout with variant 0 MISSING auto-picks the lowest LANDED variant', () => {
  const { view, shouldAbandon } = summarizeVariantBoard(makeBatch(), [asset(1, 'b'), asset(2, 'c')], NOW + TIMEOUT_MS + 1, TIMEOUT_MS);
  assert.equal(shouldAbandon, true);
  assert.equal(view.picked_variant_index, 1, 'lowest landed index, never a hardcoded 0 that has no creative');
  assert.equal(view.picked_creative_id, 'b', 'the picked card carries its creative id');
  assert.equal(view.abandoned, true);
});

test('summarizeVariantBoard: timeout with ZERO landed abandons WITHOUT a pick (no empty finalize)', () => {
  const { view, shouldAbandon } = summarizeVariantBoard(makeBatch(), [], NOW + TIMEOUT_MS + 1, TIMEOUT_MS);
  assert.equal(shouldAbandon, true);
  assert.equal(view.picked_variant_index, null, 'no pick when nothing landed');
  assert.equal(view.picked_creative_id, null);
  assert.equal(view.abandoned, true);
  assert.equal(view.board_ready, true, 'still resolves so the draft never hangs');
});

test('summarizeVariantBoard: unparseable created_at fails OPEN (abandons a stale partial board)', () => {
  const { shouldAbandon } = summarizeVariantBoard(makeBatch({ created_at: 'not-a-date' }), [asset(0, 'a')], NOW, TIMEOUT_MS);
  assert.equal(shouldAbandon, true, 'a corrupt timestamp resolves via timeout instead of hanging forever');
});

test('summarizeVariantBoard: out-of-order assets are sorted ascending by variant_index', () => {
  const { view } = summarizeVariantBoard(makeBatch(), [asset(2, 'c'), asset(0, 'a'), asset(1, 'b')], NOW + 1000, TIMEOUT_MS);
  assert.deepEqual(view.cards.map((c) => c.variant_index), [0, 1, 2]);
});

// --- getVariantBoard (mock client + FS batch record) -----------------------

function mockClient(rows: unknown[]) {
  return { query: async () => ({ rows, rowCount: rows.length }) };
}

test('getVariantBoard returns the board view for a known batch + tenant', async () => {
  const batchId = makeVariantBatchId();
  saveVariantBatch(makeBatch({ batch_id: batchId }));
  const view = await getVariantBoard({
    batchId,
    tenantId: '7',
    client: mockClient([asset(0, 'a'), asset(1, 'b'), asset(2, 'c')]) as never,
    now: new Date(NOW + 1000),
  });
  assert.ok(view);
  assert.equal(view!.board_ready, true);
  assert.equal(view!.cards.length, 3);
});

test('getVariantBoard returns null on tenant mismatch and unknown batch', async () => {
  const batchId = makeVariantBatchId();
  saveVariantBatch(makeBatch({ batch_id: batchId }));
  assert.equal(await getVariantBoard({ batchId, tenantId: '999', client: mockClient([]) as never }), null);
  assert.equal(await getVariantBoard({ batchId: 'vbatch_nope', tenantId: '7', client: mockClient([]) as never }), null);
});

test('getVariantBoard persists a timeout auto-pick for a stale unpicked board', async () => {
  const batchId = makeVariantBatchId();
  saveVariantBatch(makeBatch({ batch_id: batchId, created_at: '2020-01-01T00:00:00.000Z' }));
  const view = await getVariantBoard({
    batchId,
    tenantId: '7',
    client: mockClient([asset(0, 'a')]) as never, // only 1 of 3 → stale → abandon
    now: new Date(NOW),
  });
  assert.equal(view!.abandoned, true);
  assert.equal(view!.picked_variant_index, 0);
  const reloaded = await loadVariantBatch(batchId);
  assert.ok(reloaded!.abandoned_at, 'abandon persisted to disk');
  assert.equal(reloaded!.picked_variant_index, 0, 'timeout auto-pick persisted');
});

test('getVariantBoard timeout persists the lowest-LANDED pick + its creative id', async () => {
  const batchId = makeVariantBatchId();
  saveVariantBatch(makeBatch({ batch_id: batchId, created_at: '2020-01-01T00:00:00.000Z' }));
  const view = await getVariantBoard({
    batchId,
    tenantId: '7',
    client: mockClient([asset(2, 'c')]) as never, // only variant 2 landed (0 + 1 never did)
    now: new Date(NOW),
  });
  assert.equal(view!.picked_variant_index, 2, 'picks the only landed variant, not 0');
  assert.equal(view!.picked_creative_id, 'c');
  const reloaded = await loadVariantBatch(batchId);
  assert.equal(reloaded!.picked_variant_index, 2);
  assert.equal(reloaded!.picked_creative_id, 'c', 'creative id persisted on auto-pick');
});
