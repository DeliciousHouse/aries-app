/**
 * AA-165 — config for the INTERNAL usage & cost attribution dashboard.
 *
 * Two independent gates, because they answer different questions:
 *
 *   ARIES_INTERNAL_USAGE_DASHBOARD_ENABLED — does this surface exist at all?
 *   ARIES_INTERNAL_OPS_EMAILS              — who is allowed to see it?
 *
 * The allow-list is the whole access-control model, and it is deliberate. Aries
 * has no platform-staff role: `TenantRole` is `tenant_admin | tenant_analyst |
 * tenant_viewer`, all tenant-scoped, and the existing `app/api/internal/admin/*`
 * routes gate on `tenant_admin` — which is the CUSTOMER's admin. Reusing that
 * check for a cross-company dashboard would let every customer admin read every
 * other customer's usage. An env allow-list adds no schema, is revocable by
 * editing one variable, and cannot be granted by anything inside the product.
 *
 * An EMPTY or unset allow-list denies everyone. There is no "no list means open"
 * fallback: the failure mode of that mistake is disclosing every company's usage
 * to every logged-in customer.
 */
type Env = Partial<Record<string, string | undefined>>;

export function isInternalUsageDashboardEnabled(env: Env = process.env): boolean {
  const v = env.ARIES_INTERNAL_USAGE_DASHBOARD_ENABLED?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * The configured staff emails, normalized for comparison. Accepts comma,
 * semicolon, whitespace or newline separation so a pasted list works.
 */
export function resolveInternalOpsEmails(env: Env = process.env): Set<string> {
  const raw = env.ARIES_INTERNAL_OPS_EMAILS ?? '';
  const entries = raw
    .split(/[,;\s]+/)
    .map((entry) => entry.trim().toLowerCase())
    // A bare token with no '@' is a typo, not an identity — never match on it.
    .filter((entry) => entry.length > 0 && entry.includes('@'));
  return new Set(entries);
}

/**
 * True only when this exact email is on the configured list. Case-insensitive
 * (emails are normalized to lowercase everywhere in auth), and an empty list
 * matches nobody.
 */
export function isInternalOpsEmail(email: string | null | undefined, env: Env = process.env): boolean {
  if (typeof email !== 'string') return false;
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;
  return resolveInternalOpsEmails(env).has(normalized);
}
