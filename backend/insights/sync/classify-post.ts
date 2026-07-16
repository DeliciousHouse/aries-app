/**
 * backend/insights/sync/classify-post.ts
 *
 * Pure, deterministic caption-keyword heuristic for `insights_posts.content_type`
 * — the ONE place the six-value theme vocabulary is defined. No DB, no IO, no
 * Hermes call: this module is a plain string classifier so it is trivially
 * unit-testable and pinnable in `npm run verify`.
 *
 * The stored vocabulary is a *theme* axis (what the post is ABOUT), which is
 * distinct from `media_type` — a *format* axis (video|reel|carousel|image|...).
 * A reel can be any theme, so `media_type` must never be mapped 1:1 onto
 * `content_type`; it is consulted only as a small tiebreaker bonus below a
 * single keyword hit, so it can never by itself promote a category that has
 * zero textual signal.
 *
 * `classifyPostContentType` returns `null` when no confident match is found —
 * NULL is the pending sentinel readers already COALESCE to a display default
 * (`'uncategorized'` in Activity/Top, `'other'` in Goal). Never return or
 * store those display strings here.
 */

/** The six canonical buckets — must stay in sync with the seed
 *  (scripts/seed-insights-extend.mjs CONTENT_TYPES) and the Top pattern
 *  card's CONTENT_TYPE_NOTES keys (backend/insights/top/top-template-builder.ts). */
export const CONTENT_TYPES = [
  'educational',
  'lifestyle',
  'testimonial',
  'announcement',
  'promotional',
  'engagement',
] as const;

export type ContentType = (typeof CONTENT_TYPES)[number];

export type ClassifyPostInput = {
  caption?: string | null;
  title?: string | null;
  mediaType?: string | null;
};

// ── Keyword matching helpers ─────────────────────────────────────────────────

/** Word-bounded match for short/generic single words that risk matching as a
 *  substring of an unrelated word (e.g. "sale" inside "salesperson"). */
function wb(word: string): RegExp {
  return new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
}

/** Word-bounded phrase match. Anchored with `\b` at BOTH the start and end
 *  of the phrase text so it can never match as a substring of a longer word
 *  or an unrelated compound (e.g. "drop a" must not match inside "backdrop
 *  and", "drop alert", or "Airdrop a"). Multi-word phrases were previously
 *  matched with an unbounded substring `includes`-style regex — that is no
 *  longer safe to assume, so every phrase is bounded the same way `wb()`
 *  bounds single words. */
function phrase(text: string): RegExp {
  return new RegExp(`\\b${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
}

/** Counts how many DISTINCT keyword patterns hit `text` — used as the
 *  category's text score (see precedence note below). */
function countHits(text: string, patterns: RegExp[]): number {
  let hits = 0;
  for (const pattern of patterns) {
    if (pattern.test(text)) hits++;
  }
  return hits;
}

// Tie-break precedence order — deliberately NOT the same order as the
// exported CONTENT_TYPES tuple above (that order is pinned to match the seed
// script for the vocabulary drift-tripwire test; this order controls which
// category wins when two buckets score an equal number of keyword hits).
//
// Most-specific/least-overlap first, most-generic/highest-overlap-risk last:
// testimonial > announcement > promotional > educational > engagement >
// lifestyle. Rationale: testimonial and announcement phrases ("customer
// story", "grand opening") are rare outside their theme and rarely co-occur
// with other categories' keywords. Promotional phrases ("% off", "shop now")
// are similarly specific. Educational and engagement phrases are somewhat
// broader ("tips", "comment below"). Lifestyle keywords ("team", "community",
// "vibes") are the most generic and most likely to appear incidentally
// inside a caption whose real theme is one of the other five — so lifestyle
// is checked last and only wins outright ties by losing them.
const PRECEDENCE: readonly ContentType[] = [
  'testimonial',
  'announcement',
  'promotional',
  'educational',
  'engagement',
  'lifestyle',
];

// ── Keyword sets ──────────────────────────────────────────────────────────────
const KEYWORDS: Record<ContentType, RegExp[]> = {
  testimonial: [
    wb('review'),
    wb('testimonial'),
    phrase('customer story'),
    phrase('client story'),
    phrase('success story'),
    phrase('thank you to our client'),
    phrase('thank you to our customer'),
    phrase('happy customer'),
    phrase('client love'),
    phrase('what our customers'),
    phrase('what our clients'),
    phrase('5-star'),
    phrase('five star'),
  ],
  announcement: [
    wb('launch'),
    wb('launching'),
    wb('launched'),
    phrase('introducing'),
    phrase('grand opening'),
    phrase('now open'),
    phrase('now available'),
    phrase('coming soon'),
    phrase('just dropped'),
    phrase('we are excited to announce'),
    phrase("we're excited to announce"),
    wb('announcement'),
    phrase('brand new'),
  ],
  promotional: [
    wb('sale'),
    wb('discount'),
    wb('promo'),
    phrase('% off'),
    phrase('percent off'),
    phrase('limited time'),
    phrase('shop now'),
    phrase('book now'),
    phrase('order now'),
    phrase('offer ends'),
    phrase('buy one get one'),
    wb('bogo'),
    // wb('deal') deliberately excluded — it misfires on idiomatic uses
    // ("deal with", "a great deal", "big deal"). Only commercial-context
    // "deal" signals are matched instead; "deals" carries a lookahead so the
    // verb idiom "deals with" stays out, and "deal of the" is pinned to its
    // day/week/month retail forms so "a great deal of the process" stays out.
    /\bdeals\b(?!\s+with\b)/i,
    phrase('deal ends'),
    phrase('deal of the day'),
    phrase('deal of the week'),
    phrase('deal of the month'),
    wb('discounted'),
  ],
  educational: [
    phrase('how to'),
    phrase("here's how"),
    phrase('here is how'),
    wb('tips'),
    wb('tip'),
    phrase('did you know'),
    wb('guide'),
    wb('tutorial'),
    phrase('step by step'),
    phrase('step-by-step'),
    // wb('learn') deliberately excluded — the bare "learn more" CTA is a
    // generic engagement/promotional link caption, not an educational post,
    // so it must NOT classify as educational. Only intent-bearing phrases
    // that actually signal instructional content are matched instead.
    phrase('learn how'),
    phrase('learn why'),
    phrase('what you need to know'),
    phrase('pro tip'),
    phrase('5 ways'),
    phrase('3 ways'),
  ],
  engagement: [
    phrase('tag a friend'),
    phrase('tag someone'),
    phrase('comment below'),
    phrase('drop a comment'),
    phrase('drop an emoji'),
    phrase('drop a like'),
    wb('giveaway'),
    wb('poll'),
    phrase('double tap if'),
    phrase('let us know'),
    phrase('what do you think'),
    phrase('comment your favorite'),
    phrase('which one is your favorite'),
  ],
  lifestyle: [
    phrase('behind the scenes'),
    phrase('day in the life'),
    phrase('meet the team'),
    phrase('meet our team'),
    wb('community'),
    wb('vibes'),
    phrase('our team'),
    wb('family'),
    phrase('weekend vibes'),
  ],
};

// Weak tiebreaker only: a small bonus applied to at most one plausible
// category per media type, deliberately kept below the weight of a single
// keyword hit (1) so a category with zero textual signal can never win on
// media_type alone (never a 1:1 format -> theme mapping).
// Only covers media_type values adapters actually emit (RawPost.mediaType is
// normalized to video|short|reel|image|carousel) — 'live' and 'story' were
// unreachable and have been removed.
const MEDIA_TYPE_BONUS: Partial<Record<string, ContentType>> = {
  carousel: 'educational',
};
const TIEBREAK_BONUS = 0.4;

/**
 * Classify a post's theme from its caption/title text. Pure and deterministic:
 * same input always yields the same output. Returns `null` when nothing
 * confidently matches (the honest "pending" state — never a fabricated bucket).
 */
export function classifyPostContentType(input: ClassifyPostInput): ContentType | null {
  const text = `${input.caption ?? ''} ${input.title ?? ''}`.trim().toLowerCase();
  if (!text) return null;

  const mediaType = typeof input.mediaType === 'string' ? input.mediaType.trim().toLowerCase() : '';
  const bonusCategory = MEDIA_TYPE_BONUS[mediaType];

  let best: ContentType | null = null;
  let bestScore = 0;

  for (const type of PRECEDENCE) {
    let score = countHits(text, KEYWORDS[type]);
    if (score > 0 && bonusCategory === type) score += TIEBREAK_BONUS;
    if (score > bestScore) {
      bestScore = score;
      best = type;
    }
    // Equal-score ties keep the earlier (higher-precedence) category — `best`
    // is only overwritten on a strictly greater score, and PRECEDENCE is
    // already ordered from most- to least-specific above.
  }

  return bestScore > 0 ? best : null;
}
