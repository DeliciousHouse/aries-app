/**
 * Canonical "does this tenant still need to connect Meta?" helper.
 *
 * Used by:
 * - The Stage 4 publish precheck in `backend/marketing/orchestrator.ts`
 *   (`advancePublishStage`), so the orchestrator reaches the same conclusion
 *   as the gate when deciding whether to short-circuit to
 *   `requires_channel_connection`.
 *
 * Note: the dashboard banner does NOT call this helper directly — it consumes
 * `decision.advisories` from `evaluateOnboardingGate` (see
 * `components/redesign/layout/app-shell.tsx`). Both paths call the same
 * `countConnectedMetaPlatforms` SQL underneath, so they agree, but the UI
 * never imports this helper. If you want a single import-level source of
 * truth for UI + orchestrator + gate, wire this helper into the gate's
 * advisory builder.
 *
 * Returns true when the tenant has zero connected Meta/Instagram OAuth
 * connections (i.e. publishing is not yet wired). Failsafe: invalid tenant
 * ids resolve to "true" (needs connection) because `countConnectedMetaPlatforms`
 * already coerces those to zero.
 */
import {
  countConnectedMetaPlatforms,
  type ConnectedMetaPlatformCounter,
  type OnboardingGateQueryable,
} from '@/lib/onboarding-gate';

export async function tenantNeedsMetaConnection(
  client: OnboardingGateQueryable,
  tenantId: string | number,
  connectionCounter: ConnectedMetaPlatformCounter = countConnectedMetaPlatforms,
): Promise<boolean> {
  const count = await connectionCounter(client, String(tenantId));
  return count < 1;
}
