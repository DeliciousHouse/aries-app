/**
 * backend/insights/narrative/template-builder.ts
 *
 * Assembles the Hero Band narrative (2-3 sentences) from a NarrativeSnapshot.
 * Deterministic — no LLM, no external calls. All variation comes from snapshot data.
 *
 * Template contexts:
 *   1. No data yet — user has not published in the period
 *   2. Single platform (non-YouTube)
 *   3. YouTube — uses "videos", "unique viewers", includes watch time when present
 *   4. All Channels — aggregates across platforms, names the top-performing platform
 */

import type { NarrativeSnapshot, NarrativePeriod } from './snapshot-builder';

// ── Formatting helpers ─────────────────────────────────────────────────────────

function fmtNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtDelta(delta: number): string {
  if (delta > 0) return `up ${delta}%`;
  if (delta < 0) return `down ${Math.abs(delta)}%`;
  return 'about the same as';
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function periodLabel(period: NarrativePeriod): string {
  if (period === 'week')  return 'This week';
  if (period === '30day') return 'This month';
  return 'This quarter';
}

function platformLabel(platform: string): string {
  const labels: Record<string, string> = {
    youtube:   'YouTube',
    instagram: 'Instagram',
    facebook:  'Facebook',
    // x:      'X',     ← add when X adapter lands
    // reddit: 'Reddit',
  };
  return labels[platform] ?? platform.charAt(0).toUpperCase() + platform.slice(1);
}

function watchTimeSentence(minutes: number): string {
  if (minutes < 60)   return `${minutes} minute${minutes === 1 ? '' : 's'} of watch time generated.`;
  const hours = Math.round(minutes / 60);
  return `${plural(hours, 'hour')} of watch time generated.`;
}

// ── Template assembly ──────────────────────────────────────────────────────────

export function buildNarrativeText(snap: NarrativeSnapshot): string {
  const { platform, period, posts, postsLabel, reach, reachDelta, reachLabel,
          engagementRate, topPost, unreplied, watchTimeMinutes, hasData } = snap;

  // No data context
  if (!hasData) {
    const label = platform === 'all' ? 'any of your channels' : platformLabel(platform);
    const pLabel = platform === 'youtube' ? 'videos' : 'posts';
    return (
      `No ${pLabel} published on ${label} yet ${period === 'week' ? 'this week' : `in the last ${period === '30day' ? '30' : '90'} days`}. ` +
      `Once you publish, we'll show your reach, engagement, and top-performing content here.`
    );
  }

  const prefix = periodLabel(period);
  const pName  = platform === 'all' ? 'all your channels' : platformLabel(platform);

  // Sentence 1: posts + reach + delta
  const deltaStr  = fmtDelta(reachDelta);
  const prevLabel = period === 'week' ? 'last week' : `the previous ${period === '30day' ? '30' : '90'} days`;

  let sentence1: string;
  if (platform === 'all') {
    sentence1 =
      `${prefix} across ${pName}, you published ${plural(posts, postsLabel)} ` +
      `reaching ${fmtNumber(reach)} ${reachLabel} — ${deltaStr} ${prevLabel}.`;
  } else {
    sentence1 =
      `${prefix}, ${pName}: ${plural(posts, postsLabel)} published, ` +
      `reaching ${fmtNumber(reach)} ${reachLabel} (${deltaStr} ${prevLabel}).`;
  }

  // Sentence 2: top post — only if we have one with meaningful reach
  let sentence2 = '';
  if (topPost && topPost.metric > 0) {
    const topPlatformNote = platform === 'all' ? ` on ${platformLabel(topPost.platform)}` : '';
    sentence2 =
      ` Your top ${platform === 'youtube' ? 'video' : 'post'} was "${topPost.title}"${topPlatformNote} ` +
      `with ${fmtNumber(topPost.metric)} ${topPost.metricLabel}.`;
  }

  // Sentence 3: watch time (YouTube / all) or engagement hint
  let sentence3 = '';
  if (watchTimeMinutes != null && watchTimeMinutes > 0) {
    sentence3 = ` ${watchTimeSentence(watchTimeMinutes)}`;
  } else if (engagementRate > 0) {
    sentence3 = ` Engagement rate: ${engagementRate}%.`;
  }

  // Trailing note: unreplied comments
  let unrepliedNote = '';
  if (unreplied > 0) {
    unrepliedNote =
      ` ${plural(unreplied, 'comment')} ${unreplied === 1 ? 'is' : 'are'} waiting for a reply.`;
  }

  return `${sentence1}${sentence2}${sentence3}${unrepliedNote}`.trim();
}
