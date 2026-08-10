import type { PoolClient } from 'pg';

import {
  isAnyPlatformPublishEnabled,
  publishablePlatforms,
} from '@/backend/integrations/providers/integration-config';
import { getBusinessProfileWithDiagnostics } from '@/backend/tenant/business-profile';
import {
  queryConnectedMetaPlatformCount,
  queryConnectedPublishablePlatformCount,
  type PlatformCountQueryable,
} from '@/lib/connected-platform-counts';

export const GATE_REDIRECT_DESTINATION = '/onboarding/start' as const;
// Deep-link target for the Meta connect CTA on the dashboard nudge banner and
// the channel-integrations screen. This constant is informational-only:
// `evaluateOnboardingGate` no longer redirects to it. The gate softening turned
// `channel_not_connected` from a hard redirect reason into a soft UI advisory.
// The constant stays exported so CTAs and OAuth links keep one canonical URL.
export const META_CONNECT_REDIRECT_DESTINATION = '/oauth/connect/facebook' as const;

export const GUARDED_OPERATOR_PATH_PREFIXES: ReadonlyArray<string> = Object.freeze([
  '/dashboard',
  '/posts',
  '/calendar',
  '/social-content',
]);

export type OnboardingGateReason =
  | 'allowed'
  | 'profile_incomplete'
  | 'channel_not_connected';

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
  | 'channel_not_connected';

export type OnboardingAdvisorySeverity = 'info' | 'warning';

export type OnboardingAdvisory = {
  kind: OnboardingAdvisoryKind;
  severity: OnboardingAdvisorySeverity;
  message: string;
  ctaHref: string;
  /**
   * User-facing headline + CTA label, resolved SERVER-side.
   *
   * The banner is a client component and cannot read server flags, but the copy
   * for `channel_not_connected` depends on one: while
   * `ARIES_ANY_PLATFORM_PUBLISH_ENABLED` is OFF the system genuinely requires
   * Meta specifically, so telling a LinkedIn-connected tenant to "connect a
   * social account" would send them to do something that cannot unblock them
   * (the AA-168 confusion this ticket exists to fix). Carrying the copy on the
   * advisory keeps the flag on the server where it belongs. Optional so the
   * banner's own defaults remain the fallback.
   */
  title?: string;
  ctaLabel?: string;
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

export type ConnectedPlatformCounter = (
  client: OnboardingGateQueryable,
  tenantId: string,
) => Promise<number>;

/**
 * Count Meta connections in EITHER store: oauth_connections (direct-Meta OAuth)
 * OR connected_accounts (Composio). Composio brokers its own OAuth and persists
 * to connected_accounts, so a Composio-connected tenant was invisible to the
 * onboarding gate / publish precheck and short-circuited to
 * "requires_channel_connection" (#600/#605). `status='connected'` is required in
 * both branches — a pending link does not count.
 *
 * This is the LEGACY verdict, still used verbatim whenever
 * `ARIES_ANY_PLATFORM_PUBLISH_ENABLED` is OFF, which is what keeps a Meta-only
 * deployment byte-identical.
 */
export async function countConnectedMetaPlatforms(
  client: OnboardingGateQueryable,
  tenantId: string | number,
): Promise<number> {
  return queryConnectedMetaPlatformCount(client as unknown as PlatformCountQueryable, tenantId);
}

/**
 * AA-217: count connections across every platform this deployment can actually
 * publish to (`publishablePlatforms()` — Meta always, plus each crosspost
 * platform whose rollout flag is ON and whose config is complete).
 *
 * Strictly a SUPERSET of `countConnectedMetaPlatforms`: any tenant with a
 * connected Meta channel still counts >= 1, so no Meta tenant's gate verdict
 * can change. A LinkedIn-only / X-only tenant now counts >= 1 instead of 0 —
 * but only on the strength of a `connected_accounts` row, since that is the
 * only store the Composio publisher can dispatch from (see the dispatchability
 * note in lib/connected-platform-counts.ts). `status='connected'` is still
 * required, so pending never unblocks, and a tenant with zero connected
 * channels still counts 0 and stays blocked.
 */
export async function countConnectedPublishablePlatforms(
  client: OnboardingGateQueryable,
  tenantId: string | number,
): Promise<number> {
  return queryConnectedPublishablePlatformCount(
    client as unknown as PlatformCountQueryable,
    tenantId,
    publishablePlatforms(),
  );
}

/**
 * The counter the gate and the Stage 4 publish precheck should both use: the
 * flag decides which verdict is in force, and every caller resolves it through
 * this ONE function so the dashboard advisory and the orchestrator can never
 * disagree about whether a tenant is blocked.
 */
export function activeConnectionCounter(): ConnectedPlatformCounter {
  return isAnyPlatformPublishEnabled()
    ? countConnectedPublishablePlatforms
    : countConnectedMetaPlatforms;
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

/**
 * The "no publishing channel connected yet" advisory.
 *
 * Copy is FLAG-AWARE on purpose. With `ARIES_ANY_PLATFORM_PUBLISH_ENABLED` OFF
 * the product really does require Meta specifically, so channel-neutral copy
 * would be a lie that costs the reader a wasted connect attempt. With the flag
 * ON any connected channel unblocks publishing and the copy says so.
 */
export function channelNotConnectedAdvisory(): OnboardingAdvisory {
  const anyPlatform = isAnyPlatformPublishEnabled();
  return {
    kind: 'channel_not_connected',
    severity: 'warning',
    message: anyPlatform
      ? 'Connect a social account to publish automatically. Aries can plan, draft, and review without it.'
      : 'Connect Meta to publish automatically. Aries can plan, draft, and review without it.',
    ctaHref: '/dashboard/settings/channel-integrations',
    title: anyPlatform
      ? 'Connect a social account to publish automatically'
      : 'Connect Meta to publish automatically',
    ctaLabel: anyPlatform ? 'Connect a channel' : 'Connect Meta',
  };
}

export async function evaluateOnboardingGate(args: {
  client: OnboardingGateQueryable;
  tenantId: string | number;
  profileIncompleteResolver?: ProfileIncompleteResolver;
  connectionCounter?: ConnectedPlatformCounter;
}): Promise<OnboardingGateDecision> {
  const tenantIdString = String(args.tenantId);
  const profileIncompleteResolver = args.profileIncompleteResolver ?? defaultProfileIncompleteResolver;
  const connectionCounter = args.connectionCounter ?? activeConnectionCounter();

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
    // Soft gate: profile is complete, but no publishing channel connected yet.
    // Let the user into the dashboard and surface a banner advisory rather than
    // looping them back to the OAuth connect screen.
    return {
      allowed: true,
      reason: 'channel_not_connected',
      redirectTo: null,
      advisories: [channelNotConnectedAdvisory()],
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
