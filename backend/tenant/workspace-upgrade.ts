/**
 * Upgrade-required screen for the second-workspace paywall (multi-workspace plan
 * Decision 13 + the design review's "create-second-workspace path" note). When a
 * free account tries to CREATE a second workspace (the Phase-4 onboarding create
 * path), `assertMultiWorkspaceEntitlement` denies it — nothing is created — and
 * the onboarding resume RSC routes here. This mirrors the invite-accept
 * upgrade-required variant, but framed for the create path rather than an invite.
 *
 * The page lives OUTSIDE the gated dashboard layout so it is reachable regardless
 * of onboarding/tenant state, matching the workspace chooser.
 */
export const WORKSPACE_UPGRADE_PATH = '/workspace/upgrade';
