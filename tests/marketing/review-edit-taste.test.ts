/**
 * PR2 Phase 3 — the post-edit taste producer (backend/marketing/review-edit-taste.ts).
 *
 * The load-bearing guarantees, proven with injected deps (no DB):
 *  - flag OFF  => pure no-op (the writer is never called);
 *  - a write that THROWS is swallowed (returns false, never throws) so the
 *    operator action it rides on still succeeds;
 *  - flag ON + valid lens => the tenant writer is called with the mapped outcome;
 *  - an empty/invalid lens is skipped (no write).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  creativeReviewTasteOutcome,
  recordPostEditTasteSignal,
  recordStyleVibeTasteSignal,
} from '../../backend/marketing/review-edit-taste';
import { visualStyleLens } from '../../backend/marketing/taste-profile-store';

type ApplyCall = { tenantId: string; dimension: string; value: string; outcome: string; weight?: number };

function stubApply() {
  const calls: ApplyCall[] = [];
  const apply = (async (input: ApplyCall) => {
    calls.push(input);
    return { dimensions: {}, updated_at: '2026-06-09T00:00:00.000Z' };
  }) as never;
  return { calls, apply };
}

test('flag OFF => no-op: the tenant writer is never called', async () => {
  const { calls, apply } = stubApply();
  const wrote = await recordPostEditTasteSignal(
    { tenantId: '15', dimension: 'visual_style', value: 'Quiet Luxury', outcome: 'rejected' },
    { enabled: () => false, apply },
  );
  assert.equal(wrote, false);
  assert.equal(calls.length, 0, 'no write when the flag is OFF');
});

test('flag ON + valid lens => writes the mapped signal once', async () => {
  const { calls, apply } = stubApply();
  const wrote = await recordPostEditTasteSignal(
    { tenantId: '15', dimension: 'visual_style', value: 'Quiet Luxury', outcome: 'approved', weight: 2 },
    { enabled: () => true, apply },
  );
  assert.equal(wrote, true);
  assert.deepEqual(calls, [
    { tenantId: '15', dimension: 'visual_style', value: 'Quiet Luxury', outcome: 'approved', weight: 2 },
  ]);
});

test('a throwing writer is swallowed (non-fatal): returns false, never throws', async () => {
  const apply = (async () => {
    throw new Error('db exploded');
  }) as never;
  let threw = false;
  let result = true;
  try {
    result = await recordPostEditTasteSignal(
      { tenantId: '15', dimension: 'visual_style', value: 'Quiet Luxury', outcome: 'rejected' },
      { enabled: () => true, apply },
    );
  } catch {
    threw = true;
  }
  assert.equal(threw, false, 'a taste-write failure must not propagate to the operator action');
  assert.equal(result, false, 'returns false on a swallowed error');
});

test('empty/invalid lens is skipped even with the flag ON', async () => {
  const { calls, apply } = stubApply();
  const enabled = () => true;
  assert.equal(
    await recordPostEditTasteSignal({ tenantId: '15', dimension: '', value: 'X', outcome: 'rejected' }, { enabled, apply }),
    false,
    'empty dimension => skip',
  );
  assert.equal(
    await recordPostEditTasteSignal({ tenantId: '15', dimension: 'visual_style', value: '  ', outcome: 'rejected' }, { enabled, apply }),
    false,
    'blank value => skip',
  );
  assert.equal(
    await recordPostEditTasteSignal({ tenantId: '', dimension: 'visual_style', value: 'X', outcome: 'rejected' }, { enabled, apply }),
    false,
    'empty tenant => skip',
  );
  assert.equal(calls.length, 0, 'no write for any invalid lens');
});

test('recordStyleVibeTasteSignal derives the visual_style lens from style_vibe', async () => {
  const { calls, apply } = stubApply();
  const enabled = () => true;

  // Empty style_vibe => no lens => skip.
  assert.equal(
    await recordStyleVibeTasteSignal({ tenantId: '15', styleVibe: '   ', outcome: 'rejected' }, { enabled, apply }),
    false,
    'blank style_vibe => no signal',
  );
  assert.equal(calls.length, 0);

  // A real style_vibe => visual_style lens with that value.
  const wrote = await recordStyleVibeTasteSignal(
    { tenantId: '15', styleVibe: 'Editorial warmth with sharp proof points.', outcome: 'rejected' },
    { enabled, apply },
  );
  assert.equal(wrote, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.dimension, 'visual_style');
  assert.equal(calls[0]!.value, 'Editorial warmth with sharp proof points.');
  assert.equal(calls[0]!.outcome, 'rejected');
});

test('visualStyleLens is the shared lens helper (stamp + producers agree)', () => {
  assert.equal(visualStyleLens(null), null);
  assert.equal(visualStyleLens(''), null);
  assert.equal(visualStyleLens('   '), null);
  assert.deepEqual(visualStyleLens('  Bold Minimalist  '), { dimension: 'visual_style', value: 'Bold Minimalist' });
});

// The recordMarketingReviewDecision call-site discrimination (runtime-views.ts):
// only a creative item WITH an assetId teaches taste; the publish-preview
// launch-gate items carry reviewType 'creative' but NO assetId and must be
// skipped, else the style double-counts at the publish gate. Outcome maps
// approve => approved, everything else (reject / changes_requested) => rejected.
test('creativeReviewTasteOutcome: creative + assetId maps the action outcome', () => {
  assert.equal(creativeReviewTasteOutcome({ reviewType: 'creative', assetId: 'img_1' }, 'approve'), 'approved');
  assert.equal(creativeReviewTasteOutcome({ reviewType: 'creative', assetId: 'img_1' }, 'reject'), 'rejected');
  assert.equal(
    creativeReviewTasteOutcome({ reviewType: 'creative', assetId: 'img_1' }, 'changes_requested'),
    'rejected',
    'anything that is not approve maps to rejected (mirrors the call site)',
  );
});

test('creativeReviewTasteOutcome: creative WITHOUT assetId is skipped (launch-gate double-count guard)', () => {
  assert.equal(
    creativeReviewTasteOutcome({ reviewType: 'creative', assetId: null }, 'approve'),
    null,
    'a launch-gate creative item (no assetId) must NOT teach taste, even on approve',
  );
  assert.equal(creativeReviewTasteOutcome({ reviewType: 'creative', assetId: undefined }, 'approve'), null);
  assert.equal(creativeReviewTasteOutcome({ reviewType: 'creative', assetId: '' }, 'reject'), null, 'empty assetId is falsy => skip');
});

test('creativeReviewTasteOutcome: non-creative review types are skipped', () => {
  for (const reviewType of ['strategy', 'brand', 'workflow_approval', '', null, undefined]) {
    assert.equal(
      creativeReviewTasteOutcome({ reviewType, assetId: 'img_1' }, 'approve'),
      null,
      `reviewType ${String(reviewType)} must not teach taste`,
    );
  }
});
