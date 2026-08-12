/**
 * backend/insights/goal/goal-options.ts
 *
 * AA-114 (S6-1, gaps A6a/F3) — the canonical goal vocabulary the WRITE path
 * offers, and the explicit preset → goal_type map onboarding uses.
 *
 * The point of this module is to end the guessing. Before it, a tenant's goal
 * was free text and every consumer re-derived a canonical key from it by
 * keyword — on the backend when persisting, and again in onboarding when
 * deciding which preset to re-select. Both guesses defaulted quietly, and the
 * shipped preset "Increase social media presence" verifiably landed on the
 * wrong bucket (gap A6a).
 *
 * That miss now costs more than a mislabelled chart. PR #964 put explicit
 * follower-growth KPIs into the strategy and publish instructions, and
 * `content_growth` is the goal whose metric is SUM(followers_delta)
 * (goal-snapshot-builder.ts). A tenant who picks "Increase social media
 * presence" and silently lands on brand_awareness gets prompts optimising for
 * follower growth while the dashboard measures reach — the two halves of the
 * growth loop pointing at different numbers.
 *
 * Now the operator PICKS, and the pick is stored in `business_profiles.goal_type`.
 *
 * `primary_goal` (free text) is deliberately kept and unchanged: it has four
 * free-form writers and it feeds the Hermes brand prompts, so it is descriptive
 * copy, not a key. The two fields answer different questions —
 * "what do you want, in your words" vs "which metric should Aries report".
 *
 * Pure data + pure functions: no DB, no React, so both the server write path and
 * the client forms import the same list.
 */

import { deriveStoredGoalType, type GoalType } from './goal-type-classification';

export interface CanonicalGoalOption {
  value: GoalType;
  label: string;
  /** One line explaining what Aries will optimise and report for this goal. */
  description: string;
}

/** The four canonical goals, in the order the selects render them. */
export const CANONICAL_GOAL_OPTIONS: readonly CanonicalGoalOption[] = [
  {
    value: 'lead_generation',
    label: 'Generate leads',
    description: 'Contact details, sign-ups, consultations, and quote enquiries.',
  },
  {
    value: 'product_sales',
    label: 'Sell a product or service',
    description: 'Direct purchases, bookings, and paid sign-ups.',
  },
  {
    value: 'content_growth',
    label: 'Grow the audience',
    description: 'Followers, subscribers, and community growth.',
  },
  {
    value: 'brand_awareness',
    label: 'Build brand awareness',
    description: 'Reach, impressions, and discovery by new people.',
  },
];

/** Human label for a stored goal_type; null → the honest "not set yet" copy. */
export function goalTypeLabel(goalType: GoalType | null | undefined): string {
  if (!goalType) return 'Not set';
  return CANONICAL_GOAL_OPTIONS.find((o) => o.value === goalType)?.label ?? 'Not set';
}

export interface OnboardingGoalPreset {
  label: string;
  description: string;
  /**
   * The canonical goal this preset MEANS. Null is a real answer, not an
   * oversight: "Gather information" and "Other" do not correspond to any of the
   * four metrics Aries reports, so they leave goal_type unset and the S1-5
   * "Goal inferred — confirm" chip keeps asking. Quietly mapping them onto
   * brand_awareness would turn a visible unknown into a settled-looking fact.
   */
  goalType: GoalType | null;
}

/**
 * Onboarding's goal step. The labels are the operator-facing wording that
 * already shipped; what is new is that each one carries its canonical goal
 * EXPLICITLY instead of being keyword-matched back later.
 *
 * "Increase social media presence" is the case gap A6a names: read as free text
 * it matches no keyword family and falls through to the brand_awareness
 * default, even though the option's own description is about followers and
 * engagement — content_growth. Stating it here is what fixes it.
 */
export const ONBOARDING_GOAL_PRESETS: readonly OnboardingGoalPreset[] = [
  {
    label: 'Get leads',
    description: 'Collect contact info, sign-ups, consultation requests, or quote inquiries.',
    goalType: 'lead_generation',
  },
  {
    label: 'Sell a product or service',
    description: 'Drive direct purchases, bookings, or paid sign-ups.',
    goalType: 'product_sales',
  },
  {
    label: 'Increase social media presence',
    description: 'Grow followers, engagement, and brand visibility across platforms.',
    goalType: 'content_growth',
  },
  {
    label: 'Gather information',
    description: 'Run quizzes, surveys, or polls to learn about your audience.',
    goalType: null,
  },
  {
    label: 'Other',
    description: 'Define a custom business outcome.',
    goalType: null,
  },
];

/** The canonical goal a preset label means, or null when it maps to none. */
export function goalTypeForPresetLabel(label: string | null | undefined): GoalType | null {
  const trimmed = label?.trim();
  if (!trimmed) return null;
  return ONBOARDING_GOAL_PRESETS.find((p) => p.label === trimmed)?.goalType ?? null;
}

/**
 * The preset to re-select for a stored goal_type. This REPLACES onboarding's
 * keyword chain over the free text — the same map, read in the other direction,
 * so the option shown back to an operator is always the one their stored goal
 * actually means.
 */
export function presetLabelForGoalType(goalType: GoalType | null | undefined): string {
  if (!goalType) return '';
  return ONBOARDING_GOAL_PRESETS.find((p) => p.goalType === goalType)?.label ?? '';
}

/** Runtime guard for a value arriving from a form or an API body. */
export function isCanonicalGoalType(value: unknown): value is GoalType {
  return (
    typeof value === 'string' && CANONICAL_GOAL_OPTIONS.some((option) => option.value === value)
  );
}

/**
 * What the free text MEANS, for a write. A shipped preset label is matched
 * explicitly first; only genuinely free-form text falls through to the keyword
 * derivation.
 *
 * This is the fix for gap A6a at the boundary where it actually bites.
 * Onboarding stores its preset's LABEL as `primary_goal`, and reading that label
 * back through keyword families is what mislabels it.
 *
 * Deliberately NOT folded into `deriveStoredGoalType`: that function is shared
 * with the S6-2 backfill, whose pinned invariant is that a confident
 * classification always equals what the read path resolves today. Changing it
 * would move live tenants between buckets.
 */
export function goalTypeForWrittenText(text: string | null | undefined): GoalType | null {
  return goalTypeForPresetLabel(text) ?? deriveStoredGoalType(text);
}

/**
 * AA-114 — the ONE decision every `business_profiles` write makes about
 * `goal_type`, now that an operator can choose it explicitly.
 *
 * Precedence, and why each step is where it is:
 *
 *  1. An explicitly supplied key WINS. A human picked it in a select; nothing
 *     derived from prose may overrule that. Passing `null` explicitly clears the
 *     key (back to "not set"), which is different from not supplying one at all
 *     — hence `undefined` vs `null`.
 *
 *  2. Otherwise, if the free text CHANGED in this same write, re-resolve from
 *     the new text. This preserves the pre-existing contract that a stored key
 *     never outlives the text it came from: a tenant who rewrites "get leads" as
 *     "sell more" gets the matching metric rather than a stale one.
 *
 *  3. Otherwise KEEP the stored key. This is the case the old code got wrong.
 *     Re-deriving on a write that did not touch the goal text can only either
 *     reproduce the same value (a no-op) or overwrite an operator's explicit
 *     choice with a keyword guess — so editing an unrelated field, like the
 *     competitor URL, could silently undo their goal.
 *
 *  4. Only with no key at all do we fall back to resolving the text, for legacy
 *     rows that predate the select.
 */
export function resolveGoalTypeForWrite(input: {
  /** From the canonical select. `undefined` = not supplied; `null` = cleared. */
  explicitGoalType?: GoalType | null;
  storedGoalType: GoalType | null | undefined;
  previousPrimaryGoal: string | null | undefined;
  nextPrimaryGoal: string | null | undefined;
}): GoalType | null {
  if (input.explicitGoalType !== undefined) return input.explicitGoalType;

  const before = (input.previousPrimaryGoal ?? '').trim().toLowerCase();
  const after = (input.nextPrimaryGoal ?? '').trim().toLowerCase();
  if (before !== after) return goalTypeForWrittenText(input.nextPrimaryGoal);

  return input.storedGoalType ?? goalTypeForWrittenText(input.nextPrimaryGoal);
}
