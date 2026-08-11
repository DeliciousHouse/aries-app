/**
 * Canonical "does this tenant still need to connect a publishing channel?"
 * helper.
 *
 * Used by:
 * - The Stage 4 publish precheck in `backend/marketing/orchestrator.ts`
 *   (`advancePublishStage`), so the orchestrator reaches the same conclusion
 *   as the gate when deciding whether to short-circuit to
 *   `requires_channel_connection`.
 *
 * Note: the dashboard banner does NOT call this helper directly — it consumes
 * `decision.advisories` from `evaluateOnboardingGate` (see
 * `components/redesign/layout/app-shell.tsx`). Both paths resolve their counter
 * through `activeConnectionCounter()`, so they always agree about which verdict
 * (Meta-only vs. any publishable platform) is in force.
 *
 * WHICH platforms count is decided by `ARIES_ANY_PLATFORM_PUBLISH_ENABLED`
 * (AA-217): OFF => Meta only, the historical behavior; ON => every platform in
 * `publishablePlatforms()`. In both cases only `status='connected'` rows count,
 * so a pending link never unblocks, and a tenant with zero connected channels
 * is always still blocked.
 *
 * Returns true when the tenant has zero connected publishing channels (i.e.
 * publishing is not yet wired). Failsafe: invalid tenant ids resolve to "true"
 * (needs connection) because the counters coerce those to zero.
 */
import {
  activeConnectionCounter,
  type ConnectedPlatformCounter,
  type OnboardingGateQueryable,
} from '@/lib/onboarding-gate';

export async function tenantNeedsChannelConnection(
  client: OnboardingGateQueryable,
  tenantId: string | number,
  connectionCounter?: ConnectedPlatformCounter,
): Promise<boolean> {
  const counter = connectionCounter ?? activeConnectionCounter();
  const count = await counter(client, String(tenantId));
  return count < 1;
}
