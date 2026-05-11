import type { PoolClient } from 'pg';

import { getBusinessProfileWithDiagnostics } from '@/backend/tenant/business-profile';

export const GATE_REDIRECT_DESTINATION = '/onboarding/start' as const;
export const META_CONNECT_REDIRECT_DESTINATION = '/onboarding/connect/meta/select-page' as const;

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

export type OnboardingGateDecision = {
  allowed: boolean;
  reason: OnboardingGateReason;
  redirectTo:
    | typeof GATE_REDIRECT_DESTINATION
    | typeof META_CONNECT_REDIRECT_DESTINATION
    | null;
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
    };
  }

  const connectedCount = await connectionCounter(args.client, tenantIdString);
  if (connectedCount < 1) {
    return {
      allowed: false,
      reason: 'meta_not_connected',
      redirectTo: META_CONNECT_REDIRECT_DESTINATION,
    };
  }

  return { allowed: true, reason: 'allowed', redirectTo: null };
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
