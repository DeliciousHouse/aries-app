/**
 * Pure helpers for the headless-QA session tooling (scripts/qa/*). Split from
 * the CLIs so the guard logic is unit-testable without env or DB.
 *
 * Security model: there is NO password for the QA account (its hash is random
 * bytes discarded at seed time). The ONLY way to authenticate as it is this
 * mint path, which requires host access to the app's own NEXTAUTH_SECRET —
 * the same trust boundary that already protects every session. The guards
 * below pin minting to the sandbox identity so the tooling can never be
 * pointed at a real tenant/user.
 */

/** The one identity the mint script will ever issue sessions for. */
export const QA_USER_EMAIL = 'qa-bot@aries-qa.internal';
export const QA_TENANT_SLUG = 'aries-qa-sandbox';
export const QA_TENANT_NAME = 'Aries QA Sandbox';
export const QA_USER_NAME = 'Aries QA Bot';

/** Hard ceiling on minted-session lifetime (minutes). */
export const QA_SESSION_MAX_TTL_MINUTES = 12 * 60;
export const QA_SESSION_DEFAULT_TTL_MINUTES = 120;

export interface QaClaimsRow {
  user_id: string | number;
  email: string;
  full_name: string | null;
  tenant_id: string | number | null;
  tenant_slug: string | null;
  role: string | null;
}

/**
 * INVARIANT: sessions are minted ONLY for the pinned sandbox identity — the
 * email must be the QA bot's and the tenant slug must be the sandbox's. A
 * drifted row (renamed org, reassigned user) fails closed with a reason.
 */
export function assertQaScoped(row: QaClaimsRow): { ok: true } | { ok: false; reason: string } {
  if (row.email !== QA_USER_EMAIL) {
    return { ok: false, reason: `refusing to mint for non-QA email (${row.email})` };
  }
  if (row.tenant_slug !== QA_TENANT_SLUG) {
    return {
      ok: false,
      reason: `refusing to mint: QA user is not on the sandbox tenant (slug=${String(row.tenant_slug)})`,
    };
  }
  if (row.tenant_id === null || row.tenant_id === undefined) {
    return { ok: false, reason: 'refusing to mint: QA user has no tenant id' };
  }
  return { ok: true };
}

export function clampTtlMinutes(requested: number | undefined): number {
  if (!Number.isFinite(requested) || (requested as number) <= 0) {
    return QA_SESSION_DEFAULT_TTL_MINUTES;
  }
  return Math.min(Math.floor(requested as number), QA_SESSION_MAX_TTL_MINUTES);
}

/**
 * Auth.js v5 default session cookie name: __Secure- prefixed on https (the
 * prefix is also the JWT encode/decode salt, so getting this wrong produces
 * an undecodable token, never a privilege problem).
 */
export function sessionCookieNameForBaseUrl(baseUrl: string): string {
  return baseUrl.startsWith('https://')
    ? '__Secure-authjs.session-token'
    : 'authjs.session-token';
}

/** JWT payload mirroring auth.ts's jwt-callback claim shape for the QA user. */
export function buildQaTokenClaims(row: QaClaimsRow): Record<string, unknown> {
  return {
    sub: String(row.user_id),
    userId: String(row.user_id),
    email: row.email,
    name: row.full_name ?? QA_USER_NAME,
    tenantId: String(row.tenant_id),
    tenantSlug: row.tenant_slug,
    tenantRole: row.role ?? 'tenant_admin',
  };
}

/** Playwright-format cookie for `browse cookie-import <file>`. */
export function buildSessionCookieJson(
  baseUrl: string,
  tokenValue: string,
  ttlMinutes: number,
  nowMs: number,
): Array<Record<string, unknown>> {
  const url = new URL(baseUrl);
  return [
    {
      name: sessionCookieNameForBaseUrl(baseUrl),
      value: tokenValue,
      domain: url.hostname,
      path: '/',
      expires: Math.floor(nowMs / 1000) + ttlMinutes * 60,
      httpOnly: true,
      secure: baseUrl.startsWith('https://'),
      sameSite: 'Lax',
    },
  ];
}
