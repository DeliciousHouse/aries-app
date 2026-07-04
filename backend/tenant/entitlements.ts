/**
 * Multi-workspace entitlement seam (multi-workspace plan Decision 13).
 *
 * Aries is free for ONE workspace per account; attaching a SECOND active
 * membership to the same account requires the paid plan (`users.plan = 'pro'`).
 * This is the single server-side enforcement helper, called at every choke
 * point that would attach an additional active membership:
 *   (a) the consent-accept activation transaction (Phase 2, acceptJoinInvitation);
 *   (b) second-workspace creation (Phase 4 onboarding path).
 * It is deliberately NOT called for:
 *   - the absorb-orphan flow (absorb REPLACES the old workspace — Decision 13c);
 *   - a first membership (a teammate's first workspace never pays — 13d);
 *   - switching among already-attached workspaces (13e).
 *
 * MUST be called INSIDE the caller's transaction: the active-membership count
 * locks the rows `FOR UPDATE` so two concurrent accepts serialize (together
 * with the caller's user-row lock) and can't both slip under the free limit
 * (TOCTOU discipline, Decision 13b).
 *
 * Denial is a RESULT, not an exception — the caller rolls back its transaction
 * (the invited membership + invitation persist; the invite is never destroyed
 * by the paywall) and the API maps it to `402 { code: 'multi_workspace_requires_pro' }`.
 *
 * v1 pricing policy (recorded in the plan, relaxable without migration): ALL
 * active memberships count toward the limit. Enforcement is at ATTACH time
 * only — a pro account that reverts to free keeps its existing memberships.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Queryable = {
  query: (sql: string, params: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
};

export type MultiWorkspaceEntitlementResult =
  | { allowed: true }
  | { allowed: false; code: 'multi_workspace_requires_pro' };

export async function assertMultiWorkspaceEntitlement(
  queryable: Queryable,
  userId: string | number,
): Promise<MultiWorkspaceEntitlementResult> {
  // Lock the account's ACTIVE membership rows. Counting under FOR UPDATE (plus
  // the accept transaction's user-row lock) serializes concurrent activations:
  // the second accept blocks here until the first commits, then sees the fresh
  // count and is denied instead of both slipping under the free limit.
  const memberships = await queryable.query(
    `SELECT organization_id FROM organization_memberships WHERE user_id = $1 AND status = 'active' FOR UPDATE`,
    [Number(userId)],
  );
  const activeCount = memberships.rows.length;
  if (activeCount === 0) {
    // First active membership — always free (Decision 13d).
    return { allowed: true };
  }

  const planResult = await queryable.query(`SELECT plan FROM users WHERE id = $1 LIMIT 1`, [
    Number(userId),
  ]);
  const plan = (planResult.rows[0] as { plan?: string | null } | undefined)?.plan;
  if (plan === 'pro') {
    return { allowed: true };
  }

  return { allowed: false, code: 'multi_workspace_requires_pro' };
}
