/**
 * backend/insights/goal/goal-template-builder.ts
 *
 * Assembles the ariesLine for Section 2 — "Your Goal".
 * Deterministic template-based text. Varies by goal type, platform, and period.
 *
 * Template intent: each sentence should read as a natural 1-2 line insight,
 * not a raw stat dump. The tone shifts per goal:
 *   lead_generation  → qualified, actionable ("X qualified leads captured")
 *   content_growth   → momentum-focused ("your audience grew by X")
 *   product_sales    → intent-signal framing ("X saves = bookmarked to buy")
 *   brand_awareness  → scale-and-movement ("your content reached X people")
 */

import type { GoalSnapshot, GoalType } from './goal-snapshot-builder';
import type { NarrativePeriod } from '../narrative/snapshot-builder';

// ── Formatting helpers ─────────────────────────────────────────────────────────

function fmtNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtDelta(delta: number): string {
  if (delta > 0) return `up ${delta}%`;
  if (delta < 0) return `down ${Math.abs(delta)}%`;
  return 'flat compared to';
}

function periodLabel(period: NarrativePeriod): string {
  if (period === 'week')  return 'this week';
  if (period === '30day') return 'this month';
  return 'this quarter';
}

function prevPeriodLabel(period: NarrativePeriod): string {
  if (period === 'week')  return 'last week';
  if (period === '30day') return 'last month';
  return 'last quarter';
}

function platformName(platform: string): string {
  const names: Record<string, string> = {
    instagram: 'Instagram',
    facebook:  'Facebook',
    youtube:   'YouTube',
    tiktok:    'TikTok',
    linkedin:  'LinkedIn',
  };
  return names[platform] ?? platform.charAt(0).toUpperCase() + platform.slice(1);
}

function channelPhrase(platform: string): string {
  if (platform === 'all') return 'across your channels';
  return `on ${platformName(platform)}`;
}

// ── No-data fallbacks ──────────────────────────────────────────────────────────

function noDataText(goal: GoalType, platform: string, period: NarrativePeriod): string {
  const when    = periodLabel(period);
  const channel = channelPhrase(platform);
  switch (goal) {
    case 'lead_generation':
      return `No leads captured ${channel} ${when} yet. Once comments come in, Aries will classify and surface qualified leads here.`;
    case 'content_growth':
      return `No follower movement recorded ${channel} ${when} yet. Publish content to start growing your audience.`;
    case 'product_sales':
      return `No saves recorded ${channel} ${when} yet. Product-focused posts will start generating save signals once published.`;
    case 'brand_awareness':
      return `No reach recorded ${channel} ${when} yet. Once posts go live, we'll track how many people your content is reaching.`;
  }
}

// ── Goal-specific templates ────────────────────────────────────────────────────

function leadGenerationText(snap: GoalSnapshot): string {
  const { metricValue, metricDelta, platform, period, contributors } = snap;
  const when    = periodLabel(period);
  const prev    = prevPeriodLabel(period);
  const channel = channelPhrase(platform);
  const delta   = fmtDelta(metricDelta);

  let line = `${fmtNumber(metricValue)} qualified lead${metricValue === 1 ? '' : 's'} captured ${channel} ${when} — ${delta} ${prev}.`;

  if (contributors.length > 0) {
    const top = contributors[0];
    line += ` "${top.title}" was your top lead-driver with ${fmtNumber(top.metricValue)} lead${top.metricValue === 1 ? '' : 's'}.`;
  }

  return line;
}

function contentGrowthText(snap: GoalSnapshot): string {
  const { metricValue, metricDelta, platform, period, contributors } = snap;
  const when    = periodLabel(period);
  const prev    = prevPeriodLabel(period);
  const channel = channelPhrase(platform);
  const delta   = fmtDelta(metricDelta);

  const sign = metricValue >= 0 ? '+' : '';
  let line = `Your audience grew by ${sign}${fmtNumber(metricValue)} followers ${channel} ${when} — ${delta} ${prev}.`;

  if (contributors.length > 0) {
    const top = contributors[0];
    const reachLabel = top.platform === 'youtube' ? 'unique viewers' : 'people';
    line += ` "${top.title}" drove the most reach with ${fmtNumber(top.metricValue)} ${reachLabel}.`;
  }

  return line;
}

function productSalesText(snap: GoalSnapshot): string {
  const { metricValue, metricDelta, secondaryValue, platform, period, contributors } = snap;
  const when    = periodLabel(period);
  const prev    = prevPeriodLabel(period);
  const channel = channelPhrase(platform);
  const delta   = fmtDelta(metricDelta);

  let line = `${fmtNumber(metricValue)} save${metricValue === 1 ? '' : 's'} ${channel} ${when} — ${delta} ${prev}.`;

  if (secondaryValue && secondaryValue > 0) {
    line += ` ${fmtNumber(secondaryValue)} profile visit${secondaryValue === 1 ? '' : 's'} suggest shoppers are exploring your brand.`;
  }

  if (contributors.length > 0) {
    const top = contributors[0];
    line += ` "${top.title}" collected the most saves at ${fmtNumber(top.metricValue)}.`;
  }

  return line;
}

function brandAwarenessText(snap: GoalSnapshot): string {
  const { metricValue, metricDelta, platform, period, contributors } = snap;
  const when    = periodLabel(period);
  const prev    = prevPeriodLabel(period);
  const channel = channelPhrase(platform);
  const delta   = fmtDelta(metricDelta);

  const reachUnit = platform === 'youtube' ? 'unique viewer' : 'person';
  const reachUnits = platform === 'youtube' ? 'unique viewers' : 'people';

  let line = `Your content reached ${fmtNumber(metricValue)} ${metricValue === 1 ? reachUnit : reachUnits} ${channel} ${when} — ${delta} ${prev}.`;

  if (contributors.length > 0) {
    const top = contributors[0];
    const topReachLabel = top.platform === 'youtube' ? 'unique viewers' : 'people';
    line += ` "${top.title}" had the widest reach at ${fmtNumber(top.metricValue)} ${topReachLabel}.`;
  }

  return line;
}

// ── Main export ────────────────────────────────────────────────────────────────

export function buildGoalText(snap: GoalSnapshot): string {
  if (!snap.hasData) {
    return noDataText(snap.goal, snap.platform, snap.period);
  }

  switch (snap.goal) {
    case 'lead_generation': return leadGenerationText(snap);
    case 'content_growth':  return contentGrowthText(snap);
    case 'product_sales':   return productSalesText(snap);
    case 'brand_awareness': return brandAwarenessText(snap);
  }
}
