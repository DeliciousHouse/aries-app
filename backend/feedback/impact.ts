/**
 * Impact → Jira priority mapping and label builders for customer incident
 * reports (SC-70 port). Pure — no I/O, no env.
 *
 * INVARIANT (SC-70): the priority is derived server-side from the impact enum;
 * a client-supplied priority is never honored. Unknown impact defaults to
 * "P2 - High".
 *
 * Aries adaptation: project AA (team-managed) does not currently expose the
 * `priority` field on its Bug create screen (verified live 2026-07-03), so the
 * mapped priority is ALSO carried as an `impact-<pX>` label. Board quick
 * filters can key on the labels until the SC-71 priority scheme is associated
 * with AA; the Jira service degrades gracefully when the priority field is
 * rejected (see jira-report-client.ts callers).
 */

import type { FeedbackImpact } from '@/lib/feedback/report-options';

/** SC-71 instance-wide priority names, keyed by impact. */
const IMPACT_PRIORITY: Record<FeedbackImpact, string> = {
  p0_system_blocked: 'P0 - Crit Sit',
  p1_account_blocked: 'P1 - Critical',
  p2_feature_degraded: 'P2 - High',
  p3_minor_glitch: 'P3 - Minor',
  p4_question: 'P4 - Informational',
};

export const DEFAULT_PRIORITY = 'P2 - High';

/** Authoritative server-side mapping; unknown values fall back to P2. */
export function priorityForImpact(impact: string): string {
  // Own-property check so prototype names ('constructor', '__proto__') can
  // never leak an Object.prototype value through the record lookup.
  return Object.prototype.hasOwnProperty.call(IMPACT_PRIORITY, impact)
    ? IMPACT_PRIORITY[impact as keyof typeof IMPACT_PRIORITY]
    : DEFAULT_PRIORITY;
}

/** Short label token per impact ("impact-p0" .. "impact-p4"). */
export function impactLabel(impact: string): string {
  const known = /^p([0-4])_/.exec(impact);
  return known ? `impact-p${known[1]}` : 'impact-p2';
}

const CUSTOMER_SLUG_MAX = 50;

/**
 * Slugify a tenant/company name for the `customer-<slug>` label: lowercase →
 * strip to [a-z0-9-] → collapse dashes → trim dashes → cap 50. Returns '' when
 * nothing survives (e.g. unicode-only input) so callers can fall through.
 */
export function slugifyCustomer(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, CUSTOMER_SLUG_MAX)
    .replace(/-+$/g, '');
}

/**
 * Resolve the customer slug from the best available identity source: tenant
 * slug (already the product's company handle), then tenant display name, then
 * the tenant id, then "unknown". Lookup failures upstream simply pass null
 * here — a missing tenant row must never fail the submit.
 */
export function resolveCustomerSlug(sources: {
  tenantSlug?: string | null;
  tenantName?: string | null;
  tenantId?: string | null;
}): string {
  return (
    slugifyCustomer(sources.tenantSlug) ||
    slugifyCustomer(sources.tenantName) ||
    slugifyCustomer(sources.tenantId) ||
    'unknown'
  );
}

/**
 * INVARIANT (SC-70): the idempotency label prefix is product-unique —
 * `aries-sub-` (Sequence uses `crm-sub-`) so cross-product JQL searches never
 * collide. The report id is a lowercase UUID, so the whole label stays within
 * the JQL-safe ^[a-z0-9-]+$ alphabet the client enforces before searching.
 */
export const IDEMPOTENCY_LABEL_PREFIX = 'aries-sub-';

export function idempotencyLabel(reportId: string): string {
  return `${IDEMPOTENCY_LABEL_PREFIX}${reportId}`;
}

/**
 * The full label set for a created issue. Order: triage label, customer label,
 * idempotency label, impact label (Aries adaptation — see header).
 */
export function reportLabels(reportId: string, customerSlug: string, impact: string): string[] {
  return [
    'customer-incident',
    `customer-${customerSlug || 'unknown'}`,
    idempotencyLabel(reportId),
    impactLabel(impact),
  ];
}
