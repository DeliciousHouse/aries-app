import type { TenantRole } from '@/lib/tenant-context';

/**
 * Zero-membership workspace chooser (multi-workspace plan Decision 7 / eng
 * finding 9). When ARIES_MULTI_WORKSPACE_ENABLED is ON, an authenticated
 * account with no active workspace membership lands here instead of silently
 * minting a personal org. The page lives OUTSIDE the gated dashboard layout
 * (app/workspace/choose) so the onboarding gate can redirect to it without a
 * loop, and it is invite-aware: a pending 'invited' membership surfaces an
 * accept path before any "create a workspace" suggestion.
 */
export const WORKSPACE_CHOOSER_PATH = '/workspace/choose';

type Queryable = {
  query: (
    sql: string,
    params: unknown[],
  ) => Promise<{ rowCount?: number | null; rows: Array<Record<string, unknown>> }>;
};

export type PendingWorkspaceInvite = {
  organizationId: string;
  workspaceName: string | null;
  role: TenantRole | null;
  invitedAt: string | null;
};

/**
 * The signed-in user's pending workspace invitations, newest first — the
 * membership rows with status='invited' (the invited-but-not-accepted state
 * the Phase 0 dual-write creates alongside every invitation).
 */
export async function listPendingWorkspaceInvites(
  queryable: Queryable,
  userId: string | number,
): Promise<PendingWorkspaceInvite[]> {
  const result = await queryable.query(
    `
      SELECT
        m.organization_id,
        m.role,
        m.invited_at,
        o.name AS workspace_name
      FROM organization_memberships m
      JOIN organizations o ON o.id = m.organization_id
      WHERE m.user_id = $1 AND m.status = 'invited'
      ORDER BY m.invited_at DESC NULLS LAST, m.created_at DESC
    `,
    [Number(userId)],
  );

  return result.rows.map((row) => ({
    organizationId: String(row.organization_id),
    workspaceName: typeof row.workspace_name === 'string' && row.workspace_name ? row.workspace_name : null,
    role: (row.role as TenantRole | null) ?? null,
    invitedAt:
      row.invited_at instanceof Date
        ? row.invited_at.toISOString()
        : typeof row.invited_at === 'string'
          ? row.invited_at
          : null,
  }));
}
