import type { TenantDeletionResult } from '@/backend/memory/tenant-deletion';
import { archiveTenantMemory } from '@/backend/memory/tenant-deletion';
import type { TenantRole } from '@/lib/tenant-context';
import { isTenantRole } from '@/lib/auth-tenant-membership';
import { isMultiWorkspaceEnabled } from '@/backend/tenant/multi-workspace-env';

// Loosely typed to match both pg's PoolClient and injected test fakes; the
// repair only issues `.query()`. Same shape used by entitlements.ts /
// user-profiles.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Queryable = {
  query: (sql: string, params: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
};

export type OrganizationDeletionResult = {
  /** Users whose active pointer targeted the deleted org and where they were repointed. */
  repointedUsers: Array<{ userId: string; repointedToOrganizationId: string | null }>;
  /** Number of organization_memberships rows removed for the deleted org. */
  membershipsRemoved: number;
};

/**
 * Archives the Honcho `aries-tenant-*` workspace for a Postgres `organizations.id`.
 * Invoke this **before** deleting the organization row (or any tenant-scoped data) so
 * derived memory is purged while Aries still knows the numeric tenant id.
 *
 * Postgres `DELETE FROM organizations` must be ordered by your migration policy
 * (for example reassigning or removing `users.organization_id` first when FKs require it).
 */
export async function archiveHonchoWorkspaceForOrganizationId(
  organizationId: number,
): Promise<TenantDeletionResult> {
  const ctx = {
    tenantId: String(organizationId),
    tenantSlug: '',
    userId: 'system',
    role: 'tenant_admin' as const,
  };

  return archiveTenantMemory(ctx);
}

/**
 * Org-deletion pointer repair (multi-workspace plan Decision 11 + the Error &
 * Rescue Registry "organization delete (Phase 4)" row). Deleting an organization
 * strands every member whose ACTIVE pointer (`users.organization_id`) targeted
 * it: on their next sign-in the DB-first resolver reads a dangling pointer and,
 * pre-repair, the login would hard-fail on incomplete claims. This function
 * removes the org's memberships AND repoints those users to a next workspace (or
 * NULL → the invite-aware chooser on next login) in ONE transaction so no
 * stranded pointer is ever committed.
 *
 * Runs INSIDE the caller's transaction (the caller owns the actual
 * `DELETE FROM organizations` + any other tenant-scoped cascade + the Honcho
 * archive ordering). It only touches `organization_memberships`,
 * `organization_membership_events`, and the strayed `users.organization_id`/
 * `role` pointers.
 *
 * Flag ON: repoint to the user's next active membership (MRU `last_active_at`,
 * else oldest), moving the legacy `users.role` mirror in the same statement; no
 * membership → NULL pointer (chooser on next login). Flag OFF: byte-identical to
 * today's behavior for the pointer — the strayed pointers are cleared to NULL
 * (no membership lookup), exactly what a bare cascade would require, and no
 * membership-derived repoint is introduced. Either way the memberships for the
 * deleted org are removed so nothing dangles.
 *
 * NEVER deletes a users row. The account and its OTHER memberships survive.
 */
export async function repairPointersForDeletedOrganization(
  client: Queryable,
  organizationId: number | string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<OrganizationDeletionResult> {
  const orgId = Number(organizationId);
  if (!Number.isFinite(orgId) || orgId <= 0) {
    return { repointedUsers: [], membershipsRemoved: 0 };
  }

  const flagOn = isMultiWorkspaceEnabled(env);

  // Lock every user whose active pointer targets the org being deleted so a
  // concurrent switch/sign-in can't re-strand the pointer mid-repair.
  const stranded = await client.query(
    `SELECT id FROM users WHERE organization_id = $1 ORDER BY id ASC FOR UPDATE`,
    [orgId],
  );
  const strandedUserIds = stranded.rows.map((row: { id: string | number }) => Number(row.id));

  // Remove the deleted org's membership + audit rows first so the next-workspace
  // lookup below never re-selects a membership on the org going away.
  await client.query(`DELETE FROM organization_membership_events WHERE organization_id = $1`, [orgId]);
  const removed = await client.query(
    `DELETE FROM organization_memberships WHERE organization_id = $1`,
    [orgId],
  );
  const membershipsRemoved = removed.rowCount ?? 0;

  const repointedUsers: Array<{ userId: string; repointedToOrganizationId: string | null }> = [];
  for (const userId of strandedUserIds) {
    let repointedTo: string | null = null;

    if (flagOn) {
      const next = await client.query(
        `
          SELECT organization_id, role
          FROM organization_memberships
          WHERE user_id = $1 AND status = 'active'
          ORDER BY last_active_at DESC NULLS LAST, created_at ASC, organization_id ASC
          LIMIT 1
        `,
        [userId],
      );
      const target = next.rows[0] as
        | { organization_id: string | number; role: TenantRole | string | null }
        | undefined;
      if (target) {
        const nextRole = isTenantRole(target.role) ? target.role : null;
        if (nextRole) {
          // Pointer + legacy role mirror move together (no skew window).
          await client.query(`UPDATE users SET organization_id = $1, role = $2 WHERE id = $3`, [
            Number(target.organization_id),
            nextRole,
            userId,
          ]);
        } else {
          await client.query(`UPDATE users SET organization_id = $1 WHERE id = $2`, [
            Number(target.organization_id),
            userId,
          ]);
        }
        repointedTo = String(target.organization_id);
      } else {
        await client.query(`UPDATE users SET organization_id = NULL WHERE id = $1`, [userId]);
      }
    } else {
      // Flag OFF: clear the strayed pointer only (no membership-derived repoint),
      // exactly what a bare org cascade requires.
      await client.query(`UPDATE users SET organization_id = NULL WHERE id = $1`, [userId]);
    }

    repointedUsers.push({ userId: String(userId), repointedToOrganizationId: repointedTo });
  }

  return { repointedUsers, membershipsRemoved };
}
