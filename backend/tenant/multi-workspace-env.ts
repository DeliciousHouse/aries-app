/**
 * Rollout gate for multi-workspace membership-aware auth resolution
 * (docs/plans/2026-07-03-multi-workspace-membership.md, Phase 1 / Decision 6).
 *
 * When ON, tenant claims/context resolution validates the users.organization_id
 * pointer against an ACTIVE organization_memberships row, takes the role from
 * the membership (Decision 3), and carries workspaceCount on the same single
 * query; sign-in stops minting personal orgs for zero-membership accounts and
 * instead surfaces the workspace chooser (Decision 7). When OFF (default) every
 * resolution path is byte-identical to the single-pointer model — pinned by
 * tests/auth/tenant-resolution-flag-off-golden.test.ts.
 *
 * Treat 1/true/yes/on as enabled, matching the ARIES_TASTE_BRIEF_INJECTION_ENABLED
 * convention. Process-wide (all tenants in the container); default OFF.
 */
type Env = Partial<Record<string, string | undefined>>;

export function isMultiWorkspaceEnabled(env: Env = process.env): boolean {
  const v = env.ARIES_MULTI_WORKSPACE_ENABLED?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}
