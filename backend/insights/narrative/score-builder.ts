/**
 * backend/insights/narrative/score-builder.ts
 *
 * Computes the Aries Score (0–100) for a given period snapshot.
 *
 * Formula reverse-engineered from the design mockup data (18 data points):
 *   score = periodBase + (2.5 × engagementRate%) + (0.42 × reachDelta%)
 *   clamp to [0, 100]
 *
 * Period bases shift because longer windows naturally produce higher cumulative
 * reach deltas, so the baseline needs to compress to keep scores comparable:
 *   week=56, 30day=52, 90day=48
 *
 * scoreDelta = currentScore − prevScore, where prevScore uses the same formula
 * applied to the previous period's engagementRate (reachDelta assumed ~0 for
 * the prior period since we don't query 3 windows back).
 *
 * Judgment thresholds:
 *   ≥ 76  → Strong (week/month/quarter)
 *   ≥ 68  → Steady / Steady growth
 *   ≥ 60  → Building (when delta positive) or Steady
 *   < 60  → Slow
 */

import type { NarrativePeriod } from './snapshot-builder';

export interface AriesScore {
  score:     number;
  scoreDelta: number;
  judgment:  string;
}

const PERIOD_BASE: Record<NarrativePeriod, number> = {
  week:    56,
  '30day': 55,
  '90day': 48,
};

function rawScore(base: number, engagementRate: number, reachDelta: number): number {
  return Math.min(100, Math.max(0, base + 2.5 * engagementRate + 0.42 * reachDelta));
}

function judgment(score: number, delta: number, period: NarrativePeriod): string {
  const suffix = { week: ' week', '30day': ' month', '90day': '' }[period];
  if (score >= 76) return `Strong${suffix}`;
  if (score >= 68) return period === '90day' ? 'Steady growth' : 'Steady';
  if (score >= 60) return delta >= 2 ? 'Building' : 'Steady';
  return delta >= 2 ? 'Building' : 'Slow';
}

export function computeAriesScore(
  period:              NarrativePeriod,
  engagementRate:      number,
  reachDelta:          number,
  engagementRatePrev:  number,
): AriesScore {
  const base    = PERIOD_BASE[period];
  const score   = Math.round(rawScore(base, engagementRate, reachDelta));
  // Previous period: assume flat reach delta (no 3-window query)
  const prevScore = Math.round(rawScore(base, engagementRatePrev, 0));
  const scoreDelta = score - prevScore;

  return { score, scoreDelta, judgment: judgment(score, scoreDelta, period) };
}
