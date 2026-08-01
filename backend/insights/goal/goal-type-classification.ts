/**
 * backend/insights/goal/goal-type-classification.ts
 *
 * S6-2 / AA-115 (gap F3b) — the canonical goal vocabulary, the keyword families
 * that map free-text `business_profiles.primary_goal` onto it, and the
 * CONFIDENCE classifier the goal_type backfill writes from.
 *
 * Why this module exists at all: `primary_goal` is free-form (four writers, all
 * free-form) and `normalizeGoalValue` re-derives a canonical goal by regex on
 * every read, first-match-wins, defaulting every miss to brand_awareness. That
 * default is a GUESS. F3b's requirement is to freeze the guesses that are NOT
 * guesses into a durable `goal_type` column and leave the genuine guesses NULL
 * so the S1-5 "Goal inferred — confirm" chip still asks the operator.
 *
 * The keyword families live HERE, and `goal-snapshot-builder.ts` imports them,
 * so the read path and the backfill can never drift into disagreeing about what
 * "Generate more leads" means. That shared-vocabulary property is what makes the
 * central safety invariant hold:
 *
 *   a CONFIDENT classification always equals what the read path resolves today.
 *
 * i.e. backfilling `goal_type` never changes which metric a tenant sees — only
 * whether they are still being asked to confirm it. Pinned in
 * tests/insights-goal-type-backfill.test.ts.
 */

export type GoalType = 'lead_generation' | 'content_growth' | 'product_sales' | 'brand_awareness';

export const GOAL_TYPES: readonly GoalType[] = [
  'lead_generation',
  'content_growth',
  'product_sales',
  'brand_awareness',
];

/**
 * The default bucket the read path falls through to when nothing matches.
 * It is the most universal metric (reach), which makes it a safe thing to
 * RENDER — and an unsafe thing to PERSIST, because persisting it would bake a
 * guess in as if it were a decision. The backfill therefore never writes a
 * goal_type on the fallthrough path.
 */
export const GOAL_FALLBACK: GoalType = 'brand_awareness';

/**
 * Keyword families, in the exact order `normalizeGoalValue` evaluates them
 * (most specific intent first). Order is load-bearing for the read path's
 * first-match-wins behavior; the classifier below is order-insensitive because
 * it evaluates every family and refuses to pick when more than one hits.
 *
 * The patterns are reproduced verbatim from the shipped read path — including
 * their loose `\b` anchoring, which only binds the first and last alternative.
 * Tightening them would silently move live tenants between goal buckets, which
 * is a behavior change this card does not authorize.
 */
export const GOAL_KEYWORD_FAMILIES: ReadonlyArray<{ goal: GoalType; pattern: RegExp }> = [
  { goal: 'lead_generation', pattern: /\blead|inquir|enquir|contact|sign[- ]?up|booking|appointment\b/ },
  { goal: 'product_sales',   pattern: /\bsale|sell|revenue|purchase|buy|checkout|conversion|order|product|shop|ecommerce\b/ },
  { goal: 'content_growth',  pattern: /\bfollow|grow|audience|subscriber|community|reach more|build.*following\b/ },
  { goal: 'brand_awareness', pattern: /\baware|reach|visib|impression|discover|exposure|brand\b/ },
];

export function isGoalType(value: unknown): value is GoalType {
  return typeof value === 'string' && (GOAL_TYPES as readonly string[]).includes(value);
}

/**
 * Why a classification is (or is not) confident.
 *
 *  exact_key             the stored text IS a canonical key already
 *  single_keyword_family exactly one family matched — nothing to choose between
 *  ambiguous             2+ families matched; the read path silently takes the
 *                        first, so this is precisely where a persisted key
 *                        would bake in an arbitrary tie-break
 *  unmatched             no family matched; the read path silently renders
 *                        brand_awareness. This is the misclassification the
 *                        card names ("Increase social media presence",
 *                        "Book more qualified calls").
 */
export type GoalClassificationReason =
  | 'exact_key'
  | 'single_keyword_family'
  | 'ambiguous'
  | 'unmatched';

export type GoalClassification = {
  /** The canonical key to persist, or null when we are not confident enough. */
  goalType: GoalType | null;
  confident: boolean;
  reason: GoalClassificationReason;
  /** Every family that matched — 2+ entries is what makes a row ambiguous. */
  matchedGoals: GoalType[];
};

/**
 * Classify free-text goal copy into a canonical key WITH a confidence verdict.
 *
 * Confident only when the answer is forced: an exact canonical key, or exactly
 * one matching keyword family. Anything else returns goalType:null, which the
 * backfill leaves as a NULL column and the read path keeps resolving the way it
 * does today (fallthrough render + the confirm chip).
 */
export function classifyGoalText(raw: string | null | undefined): GoalClassification {
  const s = (raw ?? '').trim().toLowerCase();
  if (!s) {
    return { goalType: null, confident: false, reason: 'unmatched', matchedGoals: [] };
  }

  if (isGoalType(s)) {
    return { goalType: s, confident: true, reason: 'exact_key', matchedGoals: [s] };
  }

  const matchedGoals = GOAL_KEYWORD_FAMILIES.filter(({ pattern }) => pattern.test(s)).map(({ goal }) => goal);

  if (matchedGoals.length === 1) {
    return {
      goalType: matchedGoals[0],
      confident: true,
      reason: 'single_keyword_family',
      matchedGoals,
    };
  }

  if (matchedGoals.length > 1) {
    // The read path resolves this to matchedGoals[0] (family order). That
    // tie-break is fine to RENDER and wrong to PERSIST — a stored key reads as
    // settled, and this one was decided by regex ordering, not by the operator.
    return { goalType: null, confident: false, reason: 'ambiguous', matchedGoals };
  }

  return { goalType: null, confident: false, reason: 'unmatched', matchedGoals };
}

/**
 * The single derivation used by every `primary_goal` write path AND by the
 * backfill, so a stored goal_type is always the confident-only projection of
 * the free text sitting next to it. Returns null whenever we are guessing.
 *
 * Note this is deliberately a pure function of the free text: a profile save
 * that leaves `primary_goal` untouched recomputes the same key, and a save that
 * CHANGES the goal text re-derives it, so a stale key can never outlive the
 * text it was derived from. (Once F3's canonical `<select>` ships, an
 * operator-chosen key becomes authoritative and this stays the fallback for
 * text-only writes.)
 */
export function deriveStoredGoalType(primaryGoal: string | null | undefined): GoalType | null {
  return classifyGoalText(primaryGoal).goalType;
}
