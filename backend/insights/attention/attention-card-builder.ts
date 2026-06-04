/**
 * backend/insights/attention/attention-card-builder.ts
 *
 * Assembles 0–3 attention cards from an AttentionSnapshot.
 *
 * Priority: action (unreplied) → opportunity (high performer) → insight/pattern/milestone
 * Empty result → frontend renders "All caught up" state.
 *
 * Card shapes mirror the design spec: tone, badge, icon, title, body, ctaPrimary, ctaSecondary.
 * Title may contain an <em> tag to bold the key noun — the frontend should render it as HTML.
 */

import type { AttentionSnapshot, ContentPattern } from './attention-snapshot-builder';
import { fmtMilestone } from './attention-snapshot-builder';
import type { NarrativePeriod } from '../narrative/snapshot-builder';

export type CardTone = 'urgent' | 'positive' | 'celebrate' | 'neutral';

export interface CardCta {
  label: string;
  href?: string;
  toast?: string;
}

export interface AttentionCard {
  type:         'unreplied' | 'opportunity' | 'pattern' | 'milestone' | 'calibrating';
  tone:         CardTone;
  badge:        string;
  icon:         string;
  title:        string;   // may contain <em> tags
  body:         string;
  ctaPrimary:   CardCta | null;
  ctaSecondary: CardCta | null;
}

// ── Platform label ─────────────────────────────────────────────────────────────

function platformName(p: string): string {
  const names: Record<string, string> = {
    instagram: 'Instagram', facebook: 'Facebook',
    youtube: 'YouTube', tiktok: 'TikTok', linkedin: 'LinkedIn',
  };
  return names[p] ?? p.charAt(0).toUpperCase() + p.slice(1);
}

// ── Period helpers ─────────────────────────────────────────────────────────────

function periodLabel(period: NarrativePeriod): string {
  if (period === 'week')  return 'this week';
  if (period === '30day') return 'this month';
  return 'this quarter';
}

// ── Card A — Unreplied ────────────────────────────────────────────────────────

function buildUnrepliedCard(snap: AttentionSnapshot): AttentionCard {
  const { unreplied, unrepliedLeads, unrepliedQuestions } = snap;

  let body = 'These messages are recent and convert better when answered within a few hours.';

  if (unrepliedLeads > 0 && unrepliedQuestions > 0) {
    body = `Including ${unrepliedLeads} potential lead${unrepliedLeads === 1 ? '' : 's'} and ${unrepliedQuestions} question${unrepliedQuestions === 1 ? '' : 's'}. These convert better when answered within a few hours.`;
  } else if (unrepliedLeads > 0) {
    body = `Including ${unrepliedLeads} potential lead${unrepliedLeads === 1 ? '' : 's'}. Reply soon — leads convert best within a few hours.`;
  } else if (unrepliedQuestions > 0) {
    body = `Including ${unrepliedQuestions} asking about your services. These convert better when answered within a few hours.`;
  }

  return {
    type:   'unreplied',
    tone:   'urgent',
    badge:  'NEEDS REPLY',
    icon:   'message-circle',
    title:  `<em>${unreplied} comment${unreplied === 1 ? '' : 's'}</em> waiting for your reply`,
    body,
    ctaPrimary:   { label: 'Open Conversations', href: '/conversations' },
    ctaSecondary: { label: 'Mark as read', toast: 'Marked as read' },
  };
}

// ── Card B — High performer ────────────────────────────────────────────────────

function buildOpportunityCard(snap: AttentionSnapshot): AttentionCard {
  const hp = snap.highPerformer!;
  const platLabel = platformName(hp.platform);

  return {
    type:   'opportunity',
    tone:   'positive',
    badge:  'OPPORTUNITY',
    icon:   'trending-up',
    title:  `Your <em>"${hp.title}"</em> hit ${hp.multiplier}x your ${platLabel} average`,
    body:   'Aries can put $50–$200 behind it as a paid ad to extend reach to similar audiences.',
    ctaPrimary:   { label: 'Promote as ad', href: '/campaigns' },
    ctaSecondary: { label: 'View details',  toast: 'Post details available in Top Performing Content below' },
  };
}

// ── Card C — Pattern ──────────────────────────────────────────────────────────

function buildPatternCard(pattern: ContentPattern): AttentionCard {
  let title: string;
  let body: string;

  if (pattern.type === 'day_of_week') {
    const day  = pattern.dayName!;
    const mult = pattern.mult!;
    title = `${day} posts consistently outperform`;
    body  = `Your ${day} content reaches ${mult}x more people than other days. Aries is weighting your schedule toward ${day} peaks.`;
  } else {
    const top = platformName(pattern.topPlatform!);
    const sec = platformName(pattern.secPlatform!);
    const mult = pattern.mult!;
    title = `${top} is outperforming ${sec}`;
    body  = `${top} is delivering ${mult}x the average daily reach of your other channels. Aries is putting more creative weight here.`;
  }

  return {
    type:         'pattern',
    tone:         'celebrate',
    badge:        'PATTERN',
    icon:         'sparkles',
    title,
    body,
    ctaPrimary:   null,
    ctaSecondary: null,
  };
}

// ── Card C — Milestone ────────────────────────────────────────────────────────

function buildMilestoneCard(snap: AttentionSnapshot): AttentionCard {
  const ms     = snap.milestone!;
  const label  = fmtMilestone(ms.value);
  const plat   = platformName(ms.platform);

  return {
    type:  'milestone',
    tone:  'celebrate',
    badge: 'MILESTONE',
    icon:  'award',
    title: `You crossed ${label} followers on ${plat}`,
    body:  'Aries notices growth pace and adjusts the content mix to keep the momentum going.',
    ctaPrimary:   null,
    ctaSecondary: null,
  };
}

// ── Card C — Still calibrating ────────────────────────────────────────────────

function buildCalibratingCard(platform: string, period: NarrativePeriod): AttentionCard {
  const when = periodLabel(period);
  const channelNote = platform === 'all'
    ? 'your channels'
    : `${platformName(platform)}`;
  return {
    type:  'calibrating',
    tone:  'neutral',
    badge: 'STILL CALIBRATING',
    icon:  'info',
    title: `Aries is still learning ${channelNote}`,
    body:  `Not enough posts ${when} to surface patterns yet. Keep publishing and Aries will start spotting what works.`,
    ctaPrimary:   null,
    ctaSecondary: null,
  };
}

// ── Main builder ──────────────────────────────────────────────────────────────

export function buildAttentionCards(
  snap:     AttentionSnapshot,
  platform: string,
  period:   NarrativePeriod,
): AttentionCard[] {
  const cards: AttentionCard[] = [];

  // Card A — unreplied (action)
  if (snap.unreplied > 0) {
    cards.push(buildUnrepliedCard(snap));
  }

  // Card B — high performer (opportunity)
  if (snap.highPerformer) {
    cards.push(buildOpportunityCard(snap));
  }

  // Card C — pattern (richest insight)
  if (snap.pattern && cards.length < 3) {
    cards.push(buildPatternCard(snap.pattern));
  }
  // Card C fallback — milestone
  else if (snap.milestone && cards.length < 3) {
    cards.push(buildMilestoneCard(snap));
  }
  // Card C fallback — still calibrating (only when no other cards, not enough data)
  else if (cards.length === 0 && snap.postCount < 5) {
    cards.push(buildCalibratingCard(platform, period));
  }

  return cards.slice(0, 3);
}
