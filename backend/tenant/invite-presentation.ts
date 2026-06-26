import type { TenantRole } from '@/lib/tenant-context';

// Mirror of INVITE_TTL_MS (7 days) in workspace-invitations.ts, expressed in
// days for the email copy. Kept here so the route/email layer doesn't import
// the crypto module just for a number.
export const INVITE_EXPIRES_IN_DAYS = 7;

/** Friendly, non-jargon role names for emails and the member UI. */
export function roleLabel(role: TenantRole): string {
  switch (role) {
    case 'tenant_admin':
      return 'Admin';
    case 'tenant_analyst':
      return 'Editor';
    case 'tenant_viewer':
      return 'Viewer';
    default:
      return role;
  }
}

/**
 * Absolute URL the invited teammate clicks to set a password. Resolves the
 * public base URL from APP_BASE_URL (the canonical deploy var) with NEXTAUTH_URL
 * as a fallback, trimming any trailing slash so we never emit a double slash.
 */
export function buildInviteAcceptUrl(rawToken: string): string {
  const base = (process.env.APP_BASE_URL || process.env.NEXTAUTH_URL || '').replace(/\/+$/, '');
  return `${base}/invite/accept?token=${encodeURIComponent(rawToken)}`;
}
