import type { PoolClient } from 'pg';

import { getBusinessProfileWithDiagnostics } from '@/backend/tenant/business-profile';

export const GATE_REDIRECT_DESTINATION = '/onboarding/start' as const;
// Deep-link target for the "Connect Meta" CTA on the dashboard nudge banner and
// the channel-integrations screen. This constant is informational-only now:
// `evaluateOnboardingGate` no longer redirects to it. The gate softening (see
// `2026-05-12-soften-meta-gate-plan.md`) turned `meta_not_connected` from a
// hard redirect reason into a soft UI advisory. The constant stays exported so
// CTAs and OAuth links keep one canonical URL.
export const META_CONNECT_REDIRECT_DESTINATION = '/oauth/connect/facebook' as const;

export const GUARDED_OPERATOR_PATH_PREFIXES: ReadonlyArray<string> = Object.freeze([
  '/dashboard',
  '/posts',
  '/calendar',
  '/platforms',
  '/social-content',
]);

export type OnboardingGateReason =
  | 'allowed'
  | 'profile_incomplete'
  | 'meta_not_connected';

/**
 * Onboarding advisories are soft UI signals attached to a gate decision when
 * `allowed === true`. They are how the gate communicates "user can enter the
 * dashboard, but something is worth nudging them about" without taking a hard
 * redirect. Designed extensibly so future advisories (Slack-not-connected,
 * billing-overdue, etc.) snap in without churning the shape.
 *
 * Each advisory carries a `kind` discriminator, a `severity` for UI styling,
 * a default `message` (UI may override with its own copy), and a `ctaHref`
 * deep-link to the appropriate settings or connect screen.
 */
export type OnboardingAdvisoryKind =
  | 'meta_not_connected';

export type OnboardingAdvisorySeverity = 'info' | 'warning';

export type OnboardingAdvisory = {
  kind: OnboardingAdvisoryKind;
  severity: OnboardingAdvisorySeverity;
  message: string;
  ctaHref: string;
};

export type OnboardingGateDecision = {
  allowed: boolean;
  reason: OnboardingGateReason;
  redirectTo: typeof GATE_REDIRECT_DESTINATION | null;
  advisories: ReadonlyArray<OnboardingAdvisory>;
};

export type OnboardingGateQueryable = Pick<PoolClient, 'query'>;

export type ProfileIncompleteResolver = (
  client: OnboardingGateQueryable,
  tenantId: string,
) => Promise<boolean>;

export type ConnectedMetaPlatformCounter = (
  client: OnboardingGateQueryable,
  tenantId: string,
) => Promise<number>;

function toPositiveTenantId(tenantId: string | number): number | null {
  const parsed = typeof tenantId === 'number' ? tenantId : Number.parseInt(String(tenantId).trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

export async function countConnectedMetaPlatforms(
  client: OnboardingGateQueryable,
  tenantId: string | number,
): Promise<number> {
  const numericTenantId = toPositiveTenantId(tenantId);
  if (numericTenantId === null) {
    return 0;
  }

  const result = await client.query(
    `SELECT COUNT(*)::int AS connected_count
     FROM oauth_connections
     WHERE tenant_id = $1
       AND status = 'connected'
       AND provider IN ('facebook', 'instagram')`,
    [numericTenantId],
  );

  const row = result.rows?.[0] as { connected_count?: number | string } | undefined;
  if (!row) {
    return 0;
  }
  const value = row.connected_count;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function defaultProfileIncompleteResolver(
  client: OnboardingGateQueryable,
  tenantId: string,
): Promise<boolean> {
  const resolved = await getBusinessProfileWithDiagnostics(
    client as PoolClient,
    String(tenantId),
  );
  return Boolean(resolved.profile.incomplete);
}

function metaNotConnectedAdvisory(): OnboardingAdvisory {
  return {
    kind: 'meta_not_connected',
    severity: 'warning',
    message:
      'Connect Meta to publish automatically. Aries can plan, draft, and review without it.',
    ctaHref: '/dashboard/settings/channel-integrations',
  };
}

export async function evaluateOnboardingGate(args: {
  client: OnboardingGateQueryable;
  tenantId: string | number;
  profileIncompleteResolver?: ProfileIncompleteResolver;
  connectionCounter?: ConnectedMetaPlatformCounter;
}): Promise<OnboardingGateDecision> {
  const tenantIdString = String(args.tenantId);
  const profileIncompleteResolver = args.profileIncompleteResolver ?? defaultProfileIncompleteResolver;
  const connectionCounter = args.connectionCounter ?? countConnectedMetaPlatforms;

  // Fail closed on any resolver error so transient DB failures never sneak a
  // partially-set-up tenant past the gate.
  let profileIncomplete = true;
  try {
    profileIncomplete = Boolean(await profileIncompleteResolver(args.client, tenantIdString));
  } catch {
    profileIncomplete = true;
  }

  if (profileIncomplete) {
    return {
      allowed: false,
      reason: 'profile_incomplete',
      redirectTo: GATE_REDIRECT_DESTINATION,
      advisories: [],
    };
  }

  const connectedCount = await connectionCounter(args.client, tenantIdString);
  if (connectedCount < 1) {
    // Soft gate: profile is complete, but no Meta/IG connection yet. Let the
    // user into the dashboard and surface a banner advisory rather than
    // looping them back to the OAuth connect screen.
    return {
      allowed: true,
      reason: 'meta_not_connected',
      redirectTo: null,
      advisories: [metaNotConnectedAdvisory()],
    };
  }

  return { allowed: true, reason: 'allowed', redirectTo: null, advisories: [] };
}

export function shouldGuardPathname(pathname: string): boolean {
  if (!pathname) {
    return false;
  }
  for (const prefix of GUARDED_OPERATOR_PATH_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return true;
    }
  }
  return false;
}
