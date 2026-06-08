/**
 * backend/insights/top/top-template-builder.ts
 *
 * Derives whyItWorked text per post and the Pattern Spotted card
 * from a TopSnapshot. No LLM — deterministic templates.
 */

import type { TopPost, TopSnapshot } from './top-snapshot-builder';
import type { NarrativePeriod } from '../narrative/snapshot-builder';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PatternBreakdownSlice {
  contentType: string;
  label:       string;
  count:       number;
}

export interface PatternCard {
  title:     string;
  takeaway:  string;
  note:      string;
  breakdown: PatternBreakdownSlice[];
}

// ── Per-content-type notes (used in pattern card) ─────────────────────────────

const CONTENT_TYPE_NOTES: Record<string, string> = {
  educational:  'Educational content lifts shares and performs well across LinkedIn and Instagram.',
  promotional:  'Promotional posts perform best when paired with strong visual creative.',
  testimonial:  'Testimonials build trust and drive saves at 1.5x your average rate.',
  announcement: 'Announcements spike reach quickly — best posted at the start of the week.',
  lifestyle:    'Lifestyle content converts viewers to followers at 1.7x your average.',
  engagement:   'Engagement posts drive comments and keep the algorithm active between launches.',
  uncategorized:'Aries is still learning your content formats — classification pending.',
};

// ── whyItWorked builder ───────────────────────────────────────────────────────

export function buildWhyItWorked(post: TopPost, avgReach: number): string {
  const parts: string[] = [];

  // Reach multiplier
  if (post.multiplier >= 2) {
    parts.push(`This post hit ${post.multiplier}x your average reach.`);
  } else if (post.multiplier >= 1.2) {
    parts.push(`This post reached ${post.multiplier}x your period average.`);
  }

  // Content type signal
  const ct = post.contentType;
  if (ct && ct !== 'uncategorized') {
    const ctLabel = ct.charAt(0).toUpperCase() + ct.slice(1);
    if (ct === 'lifestyle') {
      parts.push(`${ctLabel} content is your strongest format — it converts viewers to followers at above-average rates.`);
    } else if (ct === 'educational') {
      parts.push(`${ctLabel} content performs disproportionately well on ${platformName(post.platform)} for your niche.`);
    } else if (ct === 'testimonial') {
      parts.push(`${ctLabel} content builds trust and drives saves at 1.5x your typical rate.`);
    } else if (ct === 'announcement') {
      parts.push(`${ctLabel} posts tend to spike reach in the first 24 hours — timing the publish matters.`);
    } else if (ct === 'promotional') {
      parts.push(`${ctLabel} content converted well here — strong visuals paired with a clear offer.`);
    } else if (ct === 'engagement') {
      parts.push(`${ctLabel} posts keep the algorithm active and surface the account to new audiences.`);
    }
  }

  // Day-of-week signal
  if (post.bestDow) {
    const weekendDays = ['Saturday', 'Sunday'];
    if (weekendDays.includes(post.bestDow)) {
      parts.push(`${post.bestDow} morning matches your audience's peak activity window.`);
    }
  }

  // Save rate signal
  if (post.saveRate >= 1.5) {
    parts.push(`A ${post.saveRate.toFixed(1)}% save rate suggests the audience found it bookmark-worthy.`);
  }

  if (parts.length === 0) {
    return 'This post outperformed others in the period — consistent publishing keeps this momentum going.';
  }

  return parts.join(' ');
}

function platformName(p: string): string {
  const names: Record<string, string> = {
    instagram: 'Instagram', facebook: 'Facebook',
    youtube: 'YouTube', tiktok: 'TikTok', linkedin: 'LinkedIn',
  };
  return names[p] ?? p.charAt(0).toUpperCase() + p.slice(1);
}

// ── Pattern card builder ──────────────────────────────────────────────────────

export function buildPatternCard(snap: TopSnapshot): PatternCard {
  const posts = snap.posts;

  if (posts.length === 0) {
    return {
      title:    'No posts yet this period',
      takeaway: 'Aries will surface patterns once posts start publishing.',
      note:     '',
      breakdown: [],
    };
  }

  if (posts.length < 3) {
    return {
      title:    'Still calibrating',
      takeaway: 'Not enough top posts to spot a reliable pattern yet. Keep publishing.',
      note:     '',
      breakdown: [],
    };
  }

  // Tally content types
  const counts = new Map<string, number>();
  for (const p of posts) {
    const ct = p.contentType ?? 'uncategorized';
    counts.set(ct, (counts.get(ct) ?? 0) + 1);
  }

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [leadType, leadCount] = sorted[0];
  const total = posts.length;

  const breakdown: PatternBreakdownSlice[] = sorted.map(([ct, count]) => ({
    contentType: ct,
    label:       ct.charAt(0).toUpperCase() + ct.slice(1),
    count,
  }));

  let title: string;
  let takeaway: string;

  if (leadCount >= Math.ceil(total * 0.6)) {
    const label = leadType.charAt(0).toUpperCase() + leadType.slice(1);
    title    = `${label} posts leading your top ${total}`;
    takeaway = `<strong>${label}</strong> content dominates your top performers — Aries will keep leaning in.`;
  } else if (sorted.length === 1) {
    const label = leadType.charAt(0).toUpperCase() + leadType.slice(1);
    title    = `All top posts are ${label}`;
    takeaway = `Your top posts are all <strong>${label.toLowerCase()}</strong> — typical for this channel.`;
  } else {
    title    = `Mixed top performers`;
    takeaway = `Your audience responds to several formats — Aries is rotating to find the highest-leverage mix.`;
  }

  const note = CONTENT_TYPE_NOTES[leadType] ?? '';

  return { title, takeaway, note, breakdown };
}

// ── Enrich posts with whyItWorked ─────────────────────────────────────────────

export interface EnrichedPost extends TopPost {
  whyItWorked: string;
}

export function enrichPosts(snap: TopSnapshot): EnrichedPost[] {
  return snap.posts.map(p => ({
    ...p,
    whyItWorked: buildWhyItWorked(p, snap.avgReach),
  }));
}
