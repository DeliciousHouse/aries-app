import { isMultiWorkspaceEnabled } from '@/backend/tenant/multi-workspace-env';
import { isTenantRole } from '@/lib/auth-tenant-membership';
import type { TenantRole } from '@/lib/tenant-context';

// Workspace switch (multi-workspace plan Phase 3, Decision 2 + CEO hardening 3).
//
// Repoints the account's ACTIVE-workspace pointer (users.organization_id) to a
// target the caller is an ACTIVE member of, moving the legacy users.role mirror
// in the SAME transaction so no request in the skew window carries the target's
// tenantId with the source's role. The jwt callback re-hydrates tenant claims
// from the DB row on the next request, so the switch propagates with no token
// surgery. `last_active_at` is stamped on the target membership (written on
// switch + sign-in only — never per-request; write-amplification rule).
//
// Membership is ALWAYS validated server-side against organization_memberships —
// the client's claim of membership is never trusted. A non-member target is a
// 'not_member' refusal; an 'invited' (unaccepted) membership is 'invited'.
//
// Switches are structured LOG LINES only, never event rows (Decision 1 —
// unbounded volume, no retention story). The caller logs; this function returns
// the resolved workspace identity the caller needs to hard-navigate.

// Matches the Queryable shape used across backend/tenant (workspace-invitations,
// user-profiles): `rows` is loosely typed so a PoolClient and the test doubles
// both satisfy it.
type Queryable = {
  query: (sql: string, params: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
};

export type SwitchWorkspaceResult =
  | {
      status: 'ok';
      tenantId: string;
      tenantSlug: string;
      role: TenantRole;
      workspaceName: string | null;
    }
  | { status: 'not_member' }
  | { status: 'invited' }
  | { status: 'invalid' };

type SwitchTargetRow = {
  membership_role: string | null;
  membership_status: string | null;
  org_id: string | number | null;
  org_name: string | null;
  org_slug: string | null;
};

/**
 * Validate + perform an active-workspace switch for `userId` to
 * `targetOrganizationId`. Single transaction; membership-validated; idempotent
 * (re-switching to the already-active workspace succeeds and re-stamps
 * last_active_at).
 */
export async function switchActiveWorkspace(
  client: Queryable,
  input: { userId: number | string; targetOrganizationId: number | string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<SwitchWorkspaceResult> {
  // Switching only exists flag-ON; the route also 404s flag-OFF, but guard the
  // domain function too so a stray caller can never repoint a pointer under the
  // single-workspace model.
  if (!isMultiWorkspaceEnabled(env)) {
    return { status: 'invalid' };
  }

  const userId = Number(input.userId);
  const targetOrgId = Number(input.targetOrganizationId);
  if (!Number.isInteger(userId) || userId <= 0 || !Number.isInteger(targetOrgId) || targetOrgId <= 0) {
    return { status: 'invalid' };
  }

  await client.query('BEGIN', []);
  try {
    // Lock the membership row so a concurrent remove/role-change serializes
    // against the switch. A deleted org cascade-deletes its memberships, so a
    // missing row also covers "workspace no longer exists" → 'not_member'.
    const targetResult = await client.query(
      `
        SELECT
          m.role AS membership_role,
          m.status AS membership_status,
          o.id AS org_id,
          o.name AS org_name,
          CASE
            WHEN o.id IS NULL THEN NULL
            ELSE COALESCE(NULLIF(o.slug, ''), 'org-' || o.id::text)
          END AS org_slug
        FROM organization_memberships m
        JOIN organizations o ON o.id = m.organization_id
        WHERE m.user_id = $1 AND m.organization_id = $2
        LIMIT 1
        FOR UPDATE OF m
      `,
      [userId, targetOrgId],
    );

    const target = targetResult.rows[0] as SwitchTargetRow | undefined;
    if (!target || target.org_id === null || target.org_id === undefined) {
      await client.query('ROLLBACK', []);
      return { status: 'not_member' };
    }
    if (target.membership_status !== 'active') {
      await client.query('ROLLBACK', []);
      return { status: 'invited' };
    }
    if (!isTenantRole(target.membership_role)) {
      // A membership without a valid role is a corrupt row; refuse rather than
      // mint a bad active-role mirror.
      await client.query('ROLLBACK', []);
      return { status: 'invalid' };
    }

    const role = target.membership_role;

    // Pointer + legacy role mirror move together — ONE statement, no skew window
    // (CEO hardening 3).
    await client.query(
      'UPDATE users SET organization_id = $1, role = $2 WHERE id = $3',
      [targetOrgId, role, userId],
    );

    // Most-recently-used marker for the deterministic default workspace.
    await client.query(
      `
        UPDATE organization_memberships
           SET last_active_at = now(), updated_at = now()
         WHERE user_id = $1 AND organization_id = $2
      `,
      [userId, targetOrgId],
    );

    await client.query('COMMIT', []);

    return {
      status: 'ok',
      tenantId: String(target.org_id),
      tenantSlug: String(target.org_slug),
      role,
      workspaceName: target.org_name,
    };
  } catch (error) {
    await client.query('ROLLBACK', []).catch(() => undefined);
    throw error;
  }
}
