import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

import { computeAriesScore } from '../backend/insights/narrative/score-builder';
import { estimateHoursSaved, HOURS_PER_POST } from '../backend/insights/hours-saved';
import { buildWhyItWorked } from '../backend/insights/top/top-template-builder';
import type { TopPost } from '../backend/insights/top/top-snapshot-builder';

// S3-1 / AA-97 — HONESTY PASS. These pins guard against the page rendering
// fabricated/synthetic numbers as if they were measured stats. Pure + no DB;
// runs in `npm run verify` on every PR.

// ── Aries Score: a dead/zero-signal account scores 0, NOT the ~50 base ─────────
test('computeAriesScore: zero-signal account scores 0 (not the fabricated ~50 base)', () => {
  for (const period of ['week', '30day', '90day'] as const) {
    const s = computeAriesScore(period, 0, 0, 0, 0);
    assert.equal(s.score, 0, `${period}: dead account must score 0, not the base`);
  }
});

test('computeAriesScore: an account with real signal still scores from the formula', () => {
  // week base 56 + 2.5*4 + 0.42*10 = 70.2 → 70. Confirms the guard does NOT
  // suppress a genuine account — only the no-signal case.
  const s = computeAriesScore('week', 4, 10, 2, 5000);
  assert.equal(s.score, 70);
  // Any single real signal (engagement OR reach) is enough to earn the base.
  assert.ok(computeAriesScore('week', 1, 0, 0, 0).score > 0, 'engagement alone earns a score');
  assert.ok(computeAriesScore('week', 0, 0, 0, 1).score > 0, 'reach alone earns a score');
});

// ── hoursSaved: ONE shared estimate, no second divergent formula ───────────────
test('estimateHoursSaved: single synthetic estimate (posts × 3h)', () => {
  assert.equal(HOURS_PER_POST, 3);
  assert.equal(estimateHoursSaved(0), 0);
  assert.equal(estimateHoursSaved(7), 21);
  assert.equal(estimateHoursSaved(10), 30);
});

test('source-guard: neither builder computes hoursSaved inline (no second formula)', () => {
  const read = (p: string) => fs.readFileSync(path.join(import.meta.dirname, '..', p), 'utf8');
  const narrative = read('backend/insights/narrative/snapshot-builder.ts');
  const activity  = read('backend/insights/activity/activity-snapshot-builder.ts');
  for (const [name, src] of [['narrative', narrative], ['activity', activity]] as const) {
    assert.match(src, /estimateHoursSaved\(/, `${name} must call the shared estimateHoursSaved`);
    // The old inline per-post/per-comment constants must not come back.
    assert.doesNotMatch(src, /hoursPerPost|\* 0\.35|\* 0\.9|\* 0\.05/, `${name} must not compute hours inline`);
    assert.doesNotMatch(src, /const HOURS_PER_POST\s*=/, `${name} must not redeclare a local HOURS_PER_POST`);
  }
});

// ── whyItWorked: renders the REAL derived multiplier, never a hardcoded 1.5x/1.7x ─
test('buildWhyItWorked: uses the real per-post multiplier and no fabricated "N.Nx your rate"', () => {
  const post = {
    contentType: 'testimonial',
    multiplier: 2.3,      // real, S2-1-derived
    saveRate: 0,
    bestDow: 'Monday',
    platform: 'instagram',
  } as unknown as TopPost;

  const copy = buildWhyItWorked(post, 1000);
  assert.match(copy, /2\.3x/, 'renders the real derived multiplier');
  assert.doesNotMatch(copy, /1\.5x|1\.7x/, 'no hardcoded fabricated multiplier');
  assert.doesNotMatch(copy, /\d\.\dx your (typical|average) rate/, 'no fabricated "your rate" stat');
});

// ── Copy-audit tripwire: fabricated numbers/niche must not return ──────────────
test('source-guard: no fabricated stats or wrong-niche copy in the top/trends builders', () => {
  const read = (p: string) => fs.readFileSync(path.join(import.meta.dirname, '..', p), 'utf8');
  const top    = read('backend/insights/top/top-template-builder.ts');
  const trends = read('backend/insights/trends/trends-template-builder.ts');

  for (const [name, src] of [['top', top], ['trends', trends]] as const) {
    assert.doesNotMatch(src, /design account/i, `${name}: no "design accounts" niche assumption`);
    assert.doesNotMatch(src, /1[–-]3\.5/, `${name}: no invented "1–3.5%" benchmark`);
    // A hardcoded "N.Nx your average/typical/rate" posing as a measured stat.
    assert.doesNotMatch(src, /\d\.\dx your (average|typical|rate)/, `${name}: no hardcoded "N.Nx your ..." stat`);
  }
});
