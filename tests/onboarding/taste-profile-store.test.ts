/**
 * Self-contained unit tests for the taste-profile store.
 *
 * The decay/confidence math is exercised through pure exported functions
 * (no DB, deterministic `nowMs`); the get/apply/loadTasteForBrief wrappers are
 * exercised with an injected mock `client` (mirrors
 * tests/memory-review-queue-query.test.ts) so nothing touches Postgres.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/onboarding/taste-profile-store.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DECAY_PER_WEEK,
  MIN_BRIEF_CONFIDENCE,
  applyTasteSignal,
  briefBucketForDimension,
  decayFactor,
  getTasteProfile,
  laplaceConfidence,
  loadTasteForBrief,
  projectTasteForBrief,
  summarizeDimensionValues,
  summarizeDimensions,
  type StoredTasteDimensions,
  type TasteProfileView,
} from '../../backend/marketing/taste-profile-store';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-06-15T00:00:00.000Z');
const approxEqual = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

// --- laplaceConfidence -----------------------------------------------------

test('laplaceConfidence = approved / (approved + rejected + 1)', () => {
  assert.ok(approxEqual(laplaceConfidence(3, 0), 3 / 4));
  assert.ok(approxEqual(laplaceConfidence(0, 0), 0));
  assert.ok(approxEqual(laplaceConfidence(1, 1), 1 / 3));
  assert.ok(approxEqual(laplaceConfidence(9, 0), 0.9));
});

test('laplaceConfidence clamps negative inputs to 0', () => {
  assert.ok(approxEqual(laplaceConfidence(-5, -5), 0));
});

// --- decayFactor (5%/week, read time) --------------------------------------

test('decayFactor applies (1 - 0.05)^weeks', () => {
  const twoWeeksAgo = new Date(NOW - 2 * WEEK_MS).toISOString();
  assert.ok(approxEqual(decayFactor(twoWeeksAgo, NOW), Math.pow(1 - DECAY_PER_WEEK, 2)));
  const oneWeekAgo = new Date(NOW - WEEK_MS).toISOString();
  assert.ok(approxEqual(decayFactor(oneWeekAgo, NOW), 0.95));
});

test('decayFactor is 1 for now, missing, invalid, or future timestamps', () => {
  assert.ok(approxEqual(decayFactor(new Date(NOW).toISOString(), NOW), 1));
  assert.equal(decayFactor(null, NOW), 1);
  assert.equal(decayFactor(undefined, NOW), 1);
  assert.equal(decayFactor('not-a-date', NOW), 1);
  // Future last_seen → weeks clamped to 0 → no decay.
  assert.ok(approxEqual(decayFactor(new Date(NOW + WEEK_MS).toISOString(), NOW), 1));
});

// --- summarizeDimensionValues (top value by decayed confidence) ------------

test('summarizeDimensionValues picks the highest decayed-confidence value', () => {
  const fresh = new Date(NOW).toISOString();
  const view = summarizeDimensionValues(
    {
      'Bold Minimalist': { approved_count: 9, rejected_count: 0, last_seen: fresh },
      'Maximalist': { approved_count: 1, rejected_count: 3, last_seen: fresh },
    },
    NOW,
  );
  assert.ok(view);
  assert.equal(view!.value, 'Bold Minimalist');
  assert.ok(approxEqual(view!.confidence, 0.9), 'fresh 9/0 → 0.9');
});

test('summarizeDimensionValues decays a stale strong value below a fresh weak one', () => {
  const fresh = new Date(NOW).toISOString();
  const veryOld = new Date(NOW - 200 * WEEK_MS).toISOString(); // factor ≈ 0
  const view = summarizeDimensionValues(
    {
      'Stale Favorite': { approved_count: 50, rejected_count: 0, last_seen: veryOld },
      'Fresh Pick': { approved_count: 2, rejected_count: 0, last_seen: fresh },
    },
    NOW,
  );
  assert.equal(view!.value, 'Fresh Pick', 'decay drops the ancient value under the fresh one');
});

test('summarizeDimensionValues returns null for an empty dimension', () => {
  assert.equal(summarizeDimensionValues({}, NOW), null);
  assert.equal(summarizeDimensionValues(null, NOW), null);
});

// --- summarizeDimensions / projectTasteForBrief ----------------------------

const RAW: StoredTasteDimensions = {
  visual_style: { 'Bold Minimalist': { approved_count: 9, rejected_count: 0, last_seen: new Date(NOW).toISOString() } },
  voice: { 'warm, low-hype': { approved_count: 4, rejected_count: 0, last_seen: new Date(NOW).toISOString() } },
  density: { airy: { approved_count: 0, rejected_count: 5, last_seen: new Date(NOW).toISOString() } }, // confidence 0
};

test('summarizeDimensions projects each dimension to its top value', () => {
  const dims = summarizeDimensions(RAW, NOW);
  assert.equal(dims.visual_style.value, 'Bold Minimalist');
  assert.equal(dims.voice.value, 'warm, low-hype');
  assert.ok(dims.density.confidence < MIN_BRIEF_CONFIDENCE);
});

test('briefBucketForDimension routes dimensions to brief fields', () => {
  assert.equal(briefBucketForDimension('voice'), 'voice_descriptors');
  assert.equal(briefBucketForDimension('audience'), 'audience_descriptors');
  assert.equal(briefBucketForDimension('avoid'), 'avoid');
  assert.equal(briefBucketForDimension('visual_style'), 'style_descriptors');
  assert.equal(briefBucketForDimension('color_palette'), 'style_descriptors');
  assert.equal(briefBucketForDimension('density'), 'style_descriptors');
  assert.equal(briefBucketForDimension('something_new'), 'style_descriptors');
});

test('projectTasteForBrief keeps only high-confidence dimensions, routed by bucket', () => {
  const view: TasteProfileView = { dimensions: summarizeDimensions(RAW, NOW), updated_at: new Date(NOW).toISOString() };
  const brief = projectTasteForBrief(view);
  assert.ok(brief);
  assert.deepEqual(brief!.style_descriptors, ['Bold Minimalist']);
  assert.deepEqual(brief!.voice_descriptors, ['warm, low-hype']);
  // density was confidence 0 (0 approved / 5 rejected) → excluded.
  assert.deepEqual(brief!.audience_descriptors, []);
  assert.deepEqual(brief!.avoid, []);
});

test('projectTasteForBrief returns null when nothing clears the confidence bar', () => {
  const weak: TasteProfileView = {
    dimensions: summarizeDimensions(
      { density: { airy: { approved_count: 0, rejected_count: 9, last_seen: new Date(NOW).toISOString() } } },
      NOW,
    ),
    updated_at: new Date(NOW).toISOString(),
  };
  assert.equal(projectTasteForBrief(weak), null);
  assert.equal(projectTasteForBrief(null), null);
});

test('malformed jsonb counts decay to 0 — never a NaN-confidence descriptor leaking into the brief', () => {
  const fresh = new Date(NOW).toISOString();
  const malformed: StoredTasteDimensions = {
    // a hand-edited / legacy leaf with a non-numeric count, iterated FIRST so a
    // NaN confidence (pre-fix) would have become `best` and blocked the real value.
    visual_style: {
      Garbage: { approved_count: 'oops' as never, rejected_count: null as never, last_seen: fresh },
      'Bold Minimalist': { approved_count: 9, rejected_count: 0, last_seen: fresh },
    },
  };
  const dims = summarizeDimensions(malformed, NOW);
  assert.ok(Number.isFinite(dims.visual_style.confidence), 'confidence is finite, not NaN');
  assert.equal(dims.visual_style.value, 'Bold Minimalist', 'a real high-confidence value still wins');
  const brief = projectTasteForBrief({ dimensions: dims, updated_at: fresh });
  assert.deepEqual(brief!.style_descriptors, ['Bold Minimalist'], 'no garbage descriptor leaks into the brief');
});

// --- getTasteProfile (mock client) -----------------------------------------

function mockClient(rows: unknown[]) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rows, rowCount: rows.length };
    },
  };
  return { client, calls };
}

test('getTasteProfile returns null for an unknown user (no row)', async () => {
  const { client } = mockClient([]);
  assert.equal(await getTasteProfile('1', '2', client as never), null);
});

test('getTasteProfile returns null for invalid ids without querying', async () => {
  const { client, calls } = mockClient([{ dimensions: {}, updated_at: new Date(NOW) }]);
  assert.equal(await getTasteProfile('abc', '2', client as never), null);
  assert.equal(await getTasteProfile('1', '-3', client as never), null);
  assert.equal(calls.length, 0, 'bad ids short-circuit before the query');
});

test('getTasteProfile decays a stale row at read time', async () => {
  const veryOld = new Date(Date.now() - 500 * WEEK_MS).toISOString();
  const { client, calls } = mockClient([
    {
      dimensions: { visual_style: { 'Bold Minimalist': { approved_count: 10, rejected_count: 0, last_seen: veryOld } } },
      updated_at: new Date(NOW),
    },
  ]);
  const view = await getTasteProfile('1', '2', client as never);
  assert.ok(view);
  assert.equal(view!.dimensions.visual_style.value, 'Bold Minimalist');
  // 10/0 would be confidence 0.909 with no decay; 500 weeks of 5%/week ≈ 0.
  assert.ok(view!.dimensions.visual_style.confidence < 0.05, 'ancient signal is nearly fully decayed');
  // params bind parsed integer ids.
  assert.deepEqual(calls[0]!.params, [1, 2]);
});

// --- applyTasteSignal (mock client) ----------------------------------------

function returningRow(dimension: string, value: string, approved: number, rejected: number) {
  return {
    dimensions: {
      // Fresh last_seen (live clock) so the read-time decay factor is ≈ 1 and the
      // returned confidence equals the raw Laplace value, deterministically.
      [dimension]: { [value]: { approved_count: approved, rejected_count: rejected, last_seen: new Date().toISOString() } },
    },
    updated_at: new Date(NOW),
  };
}

test('applyTasteSignal binds approved delta, upserts via ON CONFLICT, returns decayed confidence', async () => {
  const { client, calls } = mockClient([returningRow('visual_style', 'Bold Minimalist', 1, 0)]);
  const view = await applyTasteSignal(
    { tenantId: '7', userId: '11', dimension: 'visual_style', value: 'Bold Minimalist', outcome: 'approved' },
    client as never,
  );
  assert.match(calls[0]!.sql, /INSERT INTO marketing_taste_profile/);
  assert.match(calls[0]!.sql, /ON CONFLICT \(tenant_id, user_id\) DO UPDATE/);
  const [tid, uid, dim, value, approvedDelta, rejectedDelta] = calls[0]!.params as unknown[];
  assert.deepEqual([tid, uid, dim, value, approvedDelta, rejectedDelta], [7, 11, 'visual_style', 'Bold Minimalist', 1, 0]);
  assert.equal(view.dimensions.visual_style.value, 'Bold Minimalist');
  // The returned view exposes the decayed Laplace confidence (fresh last_seen → factor ≈ 1).
  assert.ok(approxEqual(view.dimensions.visual_style.confidence, laplaceConfidence(1, 0), 1e-3));
});

test('applyTasteSignal binds rejected delta and honours weight', async () => {
  const { client, calls } = mockClient([returningRow('density', 'airy', 0, 3)]);
  await applyTasteSignal(
    { tenantId: '7', userId: '11', dimension: 'density', value: 'airy', outcome: 'rejected', weight: 3 },
    client as never,
  );
  const [, , , , approvedDelta, rejectedDelta] = calls[0]!.params as unknown[];
  assert.deepEqual([approvedDelta, rejectedDelta], [0, 3]);
});

test('applyTasteSignal clamps weight to a positive integer', async () => {
  const { client, calls } = mockClient([returningRow('voice', 'warm', 1, 0)]);
  await applyTasteSignal(
    { tenantId: '7', userId: '11', dimension: 'voice', value: 'warm', outcome: 'approved', weight: 0 },
    client as never,
  );
  const approvedDelta = (calls[0]!.params as unknown[])[4];
  assert.equal(approvedDelta, 1, 'weight 0 → at least 1');
});

test('applyTasteSignal throws on invalid ids or empty dimension/value', async () => {
  const { client } = mockClient([returningRow('voice', 'warm', 1, 0)]);
  await assert.rejects(
    () => applyTasteSignal({ tenantId: 'x', userId: '1', dimension: 'voice', value: 'warm', outcome: 'approved' }, client as never),
    /invalid tenant_id or user_id/,
  );
  await assert.rejects(
    () => applyTasteSignal({ tenantId: '1', userId: '1', dimension: '  ', value: 'warm', outcome: 'approved' }, client as never),
    /empty dimension/,
  );
  await assert.rejects(
    () => applyTasteSignal({ tenantId: '1', userId: '1', dimension: 'voice', value: '', outcome: 'approved' }, client as never),
    /empty value/,
  );
});

// --- loadTasteForBrief (mock client) ---------------------------------------

test('loadTasteForBrief returns the brief shape for a high-confidence profile', async () => {
  const fresh = new Date(Date.now()).toISOString();
  const { client } = mockClient([
    {
      dimensions: { visual_style: { 'Bold Minimalist': { approved_count: 9, rejected_count: 0, last_seen: fresh } } },
      updated_at: new Date(NOW),
    },
  ]);
  const brief = await loadTasteForBrief('1', '2', client as never);
  assert.ok(brief);
  assert.deepEqual(brief!.style_descriptors, ['Bold Minimalist']);
});

test('loadTasteForBrief returns null when there is no profile', async () => {
  const { client } = mockClient([]);
  assert.equal(await loadTasteForBrief('1', '2', client as never), null);
});
