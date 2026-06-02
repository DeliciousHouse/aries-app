/**
 * Self-contained unit tests for finalizeVariantPick — Phase 4 side effects of a
 * pick: dual taste write (Aries DB + Honcho) for the pick + ratings, and the
 * Phase-B anchored generation of posts #2-7. All deps injected; no DB/Honcho/orchestrator.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/onboarding/variant-pick-finalize.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractBasePayload,
  finalizeVariantPick,
  ratingOutcome,
  ratingWeight,
  VARIANT_TASTE_DIMENSIONS,
} from '../../backend/marketing/variant-pick-finalize';

const tenantCtx = { tenantId: '7', tenantSlug: 'acme', userId: '42', role: 'tenant_admin' as const };

const makeBatch = () =>
  ({ batch_id: 'vbatch_x', tenant_id: '7', user_id: '42', slot_index: 0, job_ids: ['mkt_0', 'mkt_1', 'mkt_2'] }) as never;

test('ratingOutcome maps stars to approve / reject / neutral', () => {
  assert.equal(ratingOutcome(5), 'approved');
  assert.equal(ratingOutcome(4), 'approved');
  assert.equal(ratingOutcome(3), null);
  assert.equal(ratingOutcome(2), 'rejected');
  assert.equal(ratingOutcome(1), 'rejected');
  assert.equal(ratingOutcome(Number.NaN), null);
});

test('ratingWeight is distance from the neutral 3', () => {
  assert.equal(ratingWeight(5), 2);
  assert.equal(ratingWeight(4), 1);
  assert.equal(ratingWeight(1), 2);
  assert.equal(ratingWeight(3), 1);
});

test('extractBasePayload keeps onboarding base fields, drops variant overrides', () => {
  const doc = {
    inputs: { request: { brandUrl: 'x', goal: 'g', staticPostCount: 1, variant_batch_id: 'v', creativeBriefs: ['b'] } },
  } as never;
  assert.deepEqual(extractBasePayload(doc), { brandUrl: 'x', goal: 'g' });
  assert.equal(extractBasePayload(null), null);
});

test('finalizeVariantPick writes pick + rating taste to DB and Honcho, and triggers Phase-B', async () => {
  const tasteCalls: Array<{ outcome: string; weight?: number; value: string }> = [];
  const honchoCalls: Array<{ picked: boolean; variantId: string; explicitUserIntent: boolean; editOps?: string | null }> = [];
  const startJobCalls: Array<Record<string, unknown>> = [];

  const result = await finalizeVariantPick(
    {
      tenantCtx,
      batchId: 'vbatch_x',
      pickedVariantIndex: 1,
      pickedCreativeId: 'creative_b',
      ratings: [
        { variantIndex: 0, score: 1 }, // reject
        { variantIndex: 2, score: 3 }, // neutral → no DB signal, but Honcho records the rating
      ],
      edits: [{ variantIndex: 1, op: 'freeform', instruction: 'warmer lighting' }],
    },
    {
      loadBatch: async () => makeBatch(),
      applyTaste: (async (a: { outcome: string; weight?: number; value: string }) => {
        tasteCalls.push(a);
        return {} as never;
      }) as never,
      scheduleHoncho: ((i: { picked: boolean; variantId: string; explicitUserIntent: boolean; editOps?: string | null }) => {
        honchoCalls.push(i);
      }) as never,
      loadJobDoc: async () => ({ inputs: { request: { brandUrl: 'https://x', goal: 'grow' } } }) as never,
      startJob: (async (req: Record<string, unknown>) => {
        startJobCalls.push(req);
        return { jobId: 'mkt_phaseB' } as never;
      }) as never,
      now: new Date('2026-06-02T00:00:00.000Z'),
    },
  );

  // Pick (variant 1) → approve its dims at weight 2.
  const approved = tasteCalls.filter((c) => c.outcome === 'approved');
  assert.equal(approved.length, VARIANT_TASTE_DIMENSIONS[1].length, 'pick approves the chosen variant dimensions');
  assert.ok(approved.every((c) => c.weight === 2));
  // 1-star on variant 0 → reject its dims.
  const rejected = tasteCalls.filter((c) => c.outcome === 'rejected');
  assert.equal(rejected.length, VARIANT_TASTE_DIMENSIONS[0].length, '1-star rejects that variant dimensions');
  // Neutral (score 3) writes no DB taste for variant 2's dims.
  assert.ok(!tasteCalls.some((c) => VARIANT_TASTE_DIMENSIONS[2].some((d) => d.value === c.value)), 'neutral writes no DB taste');

  // Honcho: pick + both rated variants (incl. the neutral rating event).
  const pickedHoncho = honchoCalls.find((h) => h.picked === true);
  assert.ok(pickedHoncho, 'the pick is scheduled to Honcho');
  assert.equal(pickedHoncho!.variantId, 'creative_b');
  assert.ok(honchoCalls.every((h) => h.explicitUserIntent === true));
  assert.ok(String(pickedHoncho!.editOps).includes('warmer lighting'), 'freeform instruction reaches the taste signal');
  assert.equal(result.honchoScheduled, honchoCalls.length);

  // Phase B: a weekly job for the 6 anchored posts.
  assert.equal(startJobCalls.length, 1, 'Phase-B job started');
  const phaseB = startJobCalls[0];
  assert.equal(phaseB.jobType, 'weekly_social_content');
  const phaseBPayload = phaseB.payload as Record<string, unknown>;
  assert.equal(phaseBPayload.staticPostCount, 6);
  assert.ok(String(phaseBPayload.campaignStyleAnchor).length > 0, 'anchored to the picked direction');
  assert.equal(result.phaseBJobId, 'mkt_phaseB');
});

test('finalizeVariantPick is a no-op when the batch is missing', async () => {
  const result = await finalizeVariantPick(
    { tenantCtx, batchId: 'nope', pickedVariantIndex: 0 },
    { loadBatch: async () => null },
  );
  assert.deepEqual(result, { tasteSignals: 0, honchoScheduled: 0, phaseBJobId: null });
});
