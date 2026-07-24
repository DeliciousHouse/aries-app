/**
 * Single source of truth for the copy on the business-identity fields, shared by
 * the onboarding wizard, the settings screen, the business-profile screen, and
 * the social-content job form so the four surfaces cannot drift.
 *
 * ## Why "Industry" and not "Business goals"
 *
 * Demo feedback (David, item 1) was: rename "Business type" to "business goals"
 * or "sales goals", because "business type" reads as a LEGAL ENTITY question —
 * LLC / L3C / S-corp. The diagnosis is right; the suggested replacement is not,
 * for two reasons:
 *
 *  1. The wizard ALREADY has a dedicated goal step ("What outcome matters most
 *     right now?" -> Get leads / Sell a product or service / ...), persisted
 *     separately as `primaryGoal`. A second "business goals" field would ask the
 *     same question twice and make the two answers fight.
 *  2. This field is consumed downstream as an INDUSTRY signal, not a goal:
 *     `recommendedChannelsForBusinessType` keys off vertical keywords (saas,
 *     ecommerce, restaurant, salon, agency, clinic...) to pick the channel mix,
 *     and `offerPlaceholderForBusinessType` picks the example copy the same way.
 *     Feeding goal text ("get more leads") into either produces the generic
 *     fallback and quietly degrades the recommendation.
 *
 * So the field keeps its meaning and gets a name that cannot be read as a legal
 * structure, plus a hint that says so outright. The stored key stays
 * `businessType` / `business_type` — it is load-bearing across the DB column,
 * the marketing job payload, and the lobster scripts, and this is a display-only
 * rename.
 */

export const BUSINESS_TYPE_FIELD = {
  label: 'Industry',
  hint: 'The kind of business you run — not your legal structure. This shapes which channels Aries recommends.',
  placeholder: 'Executive and transformational coaching network',
  /** Shown when the field is required but empty. */
  requiredError: 'Add the industry — the kind of business, not the legal structure.',
} as const;

export const BUSINESS_NAME_FIELD = {
  label: 'Business name',
  hint: 'Use the client-facing name that should appear throughout the workspace.',
  placeholder: 'Sugar & Leather',
  requiredError: 'Add a business name before continuing.',
} as const;
