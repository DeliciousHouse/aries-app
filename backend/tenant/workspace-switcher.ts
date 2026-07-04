import type { TenantRole } from '@/lib/tenant-context';
import { isTenantRole } from '@/lib/auth-tenant-membership';

/**
 * Read model for the app-shell workspace switcher (multi-workspace plan Phase 3).
 * The switcher needs the user's ACTIVE memberships (in most-recently-used order,
 * to render the current + other-workspace rows) and their pending 'invited'
 * memberships (rendered as disabled rows with an Accept affordance — design E2).
 * The session already carries workspaceCount (Phase 1) so the shell can decide
 * whether the switcher renders; this list is what fills it.
 *
 * One indexed query on organization_memberships ⋈ organizations (served by
 * idx_organization_memberships_user). Never trusts a client id — always scoped
 * to the resolved user id.
 */

type Queryable = {
  query: (
    sql: string,
    params: unknown[],
  ) => Promise<{ rowCount?: number | null; rows: Array<Record<string, unknown>> }>;
};

export type WorkspaceMembershipSummary = {
  organizationId: string;
  name: string | null;
  slug: string;
  role: TenantRole | null;
  status: 'active' | 'invited';
  lastActiveAt: string | null;
  invitedAt: string | null;
};

/** Frontend-safe active-workspace row rendered in the switcher. */
export type SwitcherWorkspace = {
  organizationId: string;
  name: string;
  role: TenantRole | null;
  /** True for the workspace the account is currently active in. */
  current: boolean;
};

/** Frontend-safe pending-invite row (disabled + Accept affordance). */
export type SwitcherPendingInvite = {
  organizationId: string;
  name: string;
  role: TenantRole | null;
};

export type WorkspaceSwitcherData = {
  currentWorkspaceId: string | null;
  /** ACTIVE memberships, MRU order, including the current workspace. */
  workspaces: SwitcherWorkspace[];
  /** Pending 'invited' memberships, newest first. */
  pendingInvites: SwitcherPendingInvite[];
};

function toIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.trim()) return value;
  return null;
}

function displayName(name: string | null, slug: string, organizationId: string): string {
  if (name && name.trim()) return name.trim();
  if (slug && slug.trim()) return slug.trim();
  return `Workspace ${organizationId}`;
}

/**
 * The signed-in user's memberships (active + invited), joined to their
 * organizations. Active rows come first in most-recently-used order (the
 * deterministic default-workspace ordering, plan E1); invited rows follow,
 * newest first.
 */
export async function listWorkspaceMembershipsForUser(
  queryable: Queryable,
  userId: string | number,
): Promise<WorkspaceMembershipSummary[]> {
  const result = await queryable.query(
    `
      SELECT
        m.organization_id,
        m.role,
        m.status,
        m.last_active_at,
        m.invited_at,
        o.name AS org_name,
        COALESCE(NULLIF(o.slug, ''), 'org-' || o.id::text) AS org_slug
      FROM organization_memberships m
      JOIN organizations o ON o.id = m.organization_id
      WHERE m.user_id = $1 AND m.status IN ('active', 'invited')
      ORDER BY
        (m.status = 'active') DESC,
        m.last_active_at DESC NULLS LAST,
        m.invited_at DESC NULLS LAST,
        m.created_at DESC
    `,
    [Number(userId)],
  );

  return result.rows.map((row) => {
    const organizationId = String(row.organization_id);
    const rawStatus = String(row.status);
    const status: 'active' | 'invited' = rawStatus === 'active' ? 'active' : 'invited';
    return {
      organizationId,
      name: typeof row.org_name === 'string' && row.org_name ? row.org_name : null,
      slug: String(row.org_slug ?? `org-${organizationId}`),
      role: isTenantRole(row.role) ? row.role : null,
      status,
      lastActiveAt: toIso(row.last_active_at),
      invitedAt: toIso(row.invited_at),
    };
  });
}

/**
 * Project the raw membership list into the frontend-safe switcher payload,
 * marking the current workspace from the resolved active pointer.
 */
export function buildWorkspaceSwitcherData(
  memberships: WorkspaceMembershipSummary[],
  currentWorkspaceId: string | null,
): WorkspaceSwitcherData {
  const workspaces: SwitcherWorkspace[] = [];
  const pendingInvites: SwitcherPendingInvite[] = [];

  for (const membership of memberships) {
    if (membership.status === 'active') {
      workspaces.push({
        organizationId: membership.organizationId,
        name: displayName(membership.name, membership.slug, membership.organizationId),
        role: membership.role,
        current: currentWorkspaceId != null && membership.organizationId === String(currentWorkspaceId),
      });
    } else {
      pendingInvites.push({
        organizationId: membership.organizationId,
        name: displayName(membership.name, membership.slug, membership.organizationId),
        role: membership.role,
      });
    }
  }

  return {
    currentWorkspaceId: currentWorkspaceId != null ? String(currentWorkspaceId) : null,
    workspaces,
    pendingInvites,
  };
}

/** Convenience: load + project in one call for a resolved user + active pointer. */
export async function loadWorkspaceSwitcherData(
  queryable: Queryable,
  userId: string | number,
  currentWorkspaceId: string | null,
): Promise<WorkspaceSwitcherData> {
  const memberships = await listWorkspaceMembershipsForUser(queryable, userId);
  return buildWorkspaceSwitcherData(memberships, currentWorkspaceId);
}
