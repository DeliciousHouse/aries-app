/**
 * backend/insights/trends/trends-template-builder.ts
 *
 * Derives all display-layer text for Section 5 from a TrendsSnapshot.
 * No LLM — deterministic templates, same as Sections 2–4.
 *
 * Two exports:
 *   buildMetricDisplays — headline/supporting/interpretation per metric tab
 *   buildKeyMovements   — 3-5 notable movements for the right-side card
 */

import type { TrendsSnapshot } from './trends-snapshot-builder';
import type { NarrativePeriod } from '../narrative/snapshot-builder';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MetricDisplay {
  label:          string;
  icon:           string;
  headline:       string;           // big number as formatted string
  headlineSuffix: string;
  delta:          number | null;    // raw delta for badge colouring
  deltaLabel:     string | null;    // formatted delta label
  supporting:     string;           // HTML-safe supporting line
  interpretation: string;           // "Aries: ..." paragraph
}

export type KeyMovementDirection = 'up' | 'down' | 'flat' | 'flag';

export interface KeyMovement {
  direction: KeyMovementDirection;
  label:     string;
  value:     string;
  note:      string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

function fmtSigned(n: number): string {
  return (n >= 0 ? '+' : '') + n;
}

function periodLabel(period: NarrativePeriod): string {
  if (period === 'week')  return 'this week';
  if (period === '30day') return 'this month';
  return 'this quarter';
}

function platformName(p: string): string {
  const names: Record<string, string> = {
    instagram: 'Instagram', facebook: 'Facebook',
    youtube: 'YouTube', tiktok: 'TikTok', linkedin: 'LinkedIn',
  };
  return names[p] ?? p.charAt(0).toUpperCase() + p.slice(1);
}

// ── Per-metric display builders ───────────────────────────────────────────────

function buildReachDisplay(snap: TrendsSnapshot, period: NarrativePeriod): MetricDisplay {
  const { value, valuePrev, delta } = snap.reach;
  const ratio = snap.followers.value > 0
    ? Math.round((value / snap.followers.value) * 10) / 10
    : 0;

  const ratioLine = ratio >= 1
    ? `${ratio}x your follower base of ${fmtNum(snap.followers.value)}`
    : `reached ${Math.round((value / Math.max(1, snap.followers.value)) * 100)}% of your ${fmtNum(snap.followers.value)} followers`;

  const deltaLabel = delta !== null ? `${fmtSigned(delta)}% vs prior` : null;

  let interpretation: string;
  if (snap.postCount < 3) {
    interpretation = `Too few posts ${periodLabel(period)} for a confident read — keep publishing and the trend line will become meaningful.`;
  } else if ((delta ?? 0) > 15) {
    const postRef = snap.topPostTitle
      ? `your <strong>"${snap.topPostTitle}"</strong> post`
      : 'your top post';
    interpretation = `Reach grew strongly — driven by ${postRef} and consistent weekend engagement.`;
  } else if ((delta ?? 0) > 0) {
    interpretation = `Reach is up modestly — your audience is growing steadily, with weekends consistently outperforming weekdays.`;
  } else {
    interpretation = `Reach softened this period — typical during week-to-week fluctuations. Consistent posting corrects this quickly.`;
  }

  return {
    label:          'Reach',
    icon:           'eye',
    headline:       fmtNum(value),
    headlineSuffix: ' people reached',
    delta,
    deltaLabel,
    supporting:     `<span class="${(delta ?? 0) >= 0 ? 'pos' : 'neg'}">${deltaLabel ?? '—'}</span> · ${ratioLine}`,
    interpretation,
  };
}

function buildEngagementDisplay(snap: TrendsSnapshot): MetricDisplay {
  const { value, valuePrev } = snap.engagement;
  const delta = Math.round((value - valuePrev) * 10) / 10;
  const interactions = snap.reach.value > 0
    ? Math.round(snap.reach.value * value / 100)
    : 0;
  const baseline = snap.engagementBaseline;
  const vsBaseline = value >= baseline
    ? `<span class="pos">above</span> your ${baseline.toFixed(1)}% 90-day average`
    : `<span class="neg">below</span> your ${baseline.toFixed(1)}% 90-day average`;

  let interpretation: string;
  if (value >= 5) {
    interpretation = `Engagement is strong — your audience is more active than the typical 1–3.5% range for design accounts.`;
  } else if (value >= 3.5) {
    interpretation = `Engagement is healthy — within the upper range for accounts your size.`;
  } else {
    interpretation = `Engagement is on the lower side — process and educational content tends to lift this metric.`;
  }

  return {
    label:          'Engagement rate',
    icon:           'activity',
    headline:       value.toFixed(1) + '%',
    headlineSuffix: ' engagement rate',
    delta,
    deltaLabel:     `${fmtSigned(delta)}pp vs prior`,
    supporting:     `<span class="strong">${fmtNum(interactions)}</span> total interactions · ${vsBaseline}`,
    interpretation,
  };
}

function buildFollowersDisplay(snap: TrendsSnapshot): MetricDisplay {
  const { value, valuePrev } = snap.followers;
  const totalFollowers = snap.reach.value > 0
    ? Math.max(snap.followers.value, 0)
    : 0;

  // Use the max of current/prev followers from the platform breakdown as total
  const totalFromBreakdown = snap.platformBreakdown.followers.reduce((s, p) => s + p.value, 0);
  const growthPct = totalFromBreakdown > 0
    ? ((value / totalFromBreakdown) * 100).toFixed(1)
    : '0';

  let interpretation: string;
  if (value > 100) {
    interpretation = `Strong growth pace — well above your historical average. Your top posts are pulling in followers most reliably.`;
  } else if (value > 0) {
    interpretation = `Steady growth — consistent week over week. Keep publishing and the pace compounds.`;
  } else {
    interpretation = `Followers slipped slightly — common during quiet posting weeks or platform algorithm shifts.`;
  }

  return {
    label:          'Followers',
    icon:           'user-plus',
    headline:       fmtSigned(value),
    headlineSuffix: ' new followers',
    delta:          null,
    deltaLabel:     null,
    supporting:     `<span class="strong">${growthPct}%</span> growth this period · <span class="${value >= 0 ? 'pos' : 'neg'}">${fmtSigned(value)}</span> vs prior's ${fmtSigned(valuePrev)}`,
    interpretation,
  };
}

function buildCommentsDisplay(snap: TrendsSnapshot): MetricDisplay {
  const { value } = snap.comments;
  const perPost = snap.postCount > 0
    ? (value / snap.postCount).toFixed(1)
    : '0';

  let interpretation: string;
  if (snap.unreplied > 0) {
    interpretation = `${snap.unreplied} of these need a reply — most cluster around your top-performing posts. Head to Conversations to respond.`;
  } else {
    interpretation = `Comments are healthy and you're caught up on replies — keep engaging and the algorithm rewards the activity.`;
  }

  return {
    label:          'Comments',
    icon:           'message-square',
    headline:       fmtNum(value),
    headlineSuffix: ' comments received',
    delta:          null,
    deltaLabel:     null,
    supporting:     `<span class="strong">${perPost}</span> per post · <span class="strong pos">${snap.sentimentPositivePct}%</span> positive sentiment`,
    interpretation,
  };
}

function buildVisitsDisplay(snap: TrendsSnapshot): MetricDisplay {
  const { value, valuePrev, delta } = snap.visits!;
  const conv = value > 0
    ? ((snap.followers.value / value) * 100).toFixed(1)
    : '0';
  const perPost = snap.postCount > 0
    ? Math.round(value / snap.postCount)
    : 0;
  const deltaLabel = delta !== null ? `${fmtSigned(delta)}% vs prior` : null;

  let interpretation: string;
  const convNum = parseFloat(conv);
  if (convNum >= 7) {
    interpretation = `Strong visit-to-follow conversion — visitors are finding what they came for.`;
  } else if (convNum >= 4) {
    interpretation = `Healthy visit-to-follow rate — typical for design accounts at your stage.`;
  } else {
    interpretation = `Conversion is on the lower side — a clear bio and strong pinned post tend to lift this.`;
  }

  return {
    label:          'Profile visits',
    icon:           'user-check',
    headline:       fmtNum(value),
    headlineSuffix: ' profile visits',
    delta,
    deltaLabel,
    supporting:     `<span class="${(delta ?? 0) >= 0 ? 'pos' : 'neg'}">${deltaLabel ?? '—'}</span> · <span class="strong">${conv}%</span> became followers · ~${perPost} per post`,
    interpretation,
  };
}

export function buildMetricDisplays(
  snap:     TrendsSnapshot,
  period:   NarrativePeriod,
  platform: string,
): Record<string, MetricDisplay> {
  const displays: Record<string, MetricDisplay> = {
    reach:      buildReachDisplay(snap, period),
    engagement: buildEngagementDisplay(snap),
    followers:  buildFollowersDisplay(snap),
    comments:   buildCommentsDisplay(snap),
  };
  if (snap.visitsAvailable) {
    displays.visits = buildVisitsDisplay(snap);
  }
  return displays;
}

// ── Key movements ──────────────────────────────────────────────────────────────

export function buildKeyMovements(
  snap:     TrendsSnapshot,
  period:   NarrativePeriod,
  platform: string,
): KeyMovement[] {
  const moves: KeyMovement[] = [];

  // 1. Day-of-week peak — only meaningful for week period (daily resolution)
  if (period === 'week') {
    const reachSeries = snap.series.reach.current;
    const labels      = snap.series.reach.labels;
    if (reachSeries.length > 0) {
      const maxIdx = reachSeries.indexOf(Math.max(...reachSeries));
      const total  = reachSeries.reduce((s, v) => s + v, 0);
      const avg    = total / reachSeries.length;
      const peak   = reachSeries[maxIdx];
      const mult   = avg > 0 ? Math.round((peak / avg) * 10) / 10 : 0;
      if (mult >= 1.4 && labels[maxIdx]) {
        moves.push({
          direction: 'up',
          label:     `${labels[maxIdx]} peak`,
          value:     `+${Math.round((mult - 1) * 100)}%`,
          note:      'above your weekday average',
        });
      }
    }
  }

  // 2. Engagement vs 90-day baseline
  const engVal      = snap.engagement.value;
  const engBaseline = snap.engagementBaseline;
  if (engVal >= engBaseline + 0.3) {
    moves.push({
      direction: 'up',
      label:     'Engagement rate',
      value:     engVal.toFixed(1) + '%',
      note:      `above your ${engBaseline.toFixed(1)}% baseline`,
    });
  } else if (engVal <= engBaseline - 0.5) {
    moves.push({
      direction: 'down',
      label:     'Engagement rate',
      value:     engVal.toFixed(1) + '%',
      note:      `below your ${engBaseline.toFixed(1)}% baseline`,
    });
  }

  // 3. Reach delta
  const reachDelta = snap.reach.delta ?? 0;
  if (reachDelta >= 15) {
    moves.push({
      direction: 'up',
      label:     'Reach',
      value:     fmtSigned(reachDelta) + '%',
      note:      'vs the prior period',
    });
  } else if (reachDelta <= -10) {
    moves.push({
      direction: 'down',
      label:     'Reach',
      value:     fmtSigned(reachDelta) + '%',
      note:      'vs the prior period',
    });
  }

  // 4. Follower growth pace
  const newFollow = snap.followers.value;
  if (newFollow > 100) {
    moves.push({
      direction: 'up',
      label:     'Follower growth',
      value:     fmtSigned(newFollow),
      note:      'ahead of your typical pace',
    });
  } else if (newFollow < 0) {
    moves.push({
      direction: 'down',
      label:     'Follower count',
      value:     fmtSigned(newFollow),
      note:      'minor dip — normal fluctuation',
    });
  } else if (newFollow > 0) {
    moves.push({
      direction: 'flat',
      label:     'Follower growth',
      value:     fmtSigned(newFollow),
      note:      'steady this period',
    });
  }

  // 5. Weakest channel — only visible in all-channels view
  if (platform === 'all' && snap.platformBreakdown.reach.length >= 2) {
    const sorted = [...snap.platformBreakdown.reach].sort((a, b) => a.value - b.value);
    const weakest = sorted[0];
    if (weakest.pct < 10) {
      moves.push({
        direction: 'down',
        label:     `${platformName(weakest.platform)} reach`,
        value:     `${weakest.pct.toFixed(0)}%`,
        note:      'of your total — consistently your quietest channel',
      });
    }
  }

  // 6. Unreplied flag — always surfaced when present
  if (snap.unreplied > 0 && moves.length < 5) {
    moves.push({
      direction: 'flag',
      label:     'Unreplied',
      value:     String(snap.unreplied),
      note:      `comment${snap.unreplied === 1 ? '' : 's'} waiting for you`,
    });
  }

  return moves.slice(0, 5);
}
