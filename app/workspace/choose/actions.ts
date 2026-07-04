'use server';

import { redirect } from 'next/navigation';

import { auth } from '@/auth';
import pool from '@/lib/db';
import { isMultiWorkspaceEnabled } from '@/backend/tenant/multi-workspace-env';
import { WORKSPACE_CHOOSER_PATH } from '@/backend/tenant/workspace-chooser';
import { resendWorkspaceInvitation } from '@/backend/tenant/workspace-invitations';

/**
 * Chooser "Accept invite" action (multi-workspace Phase 1, design spec
 * "Zero-membership chooser is invite-aware"). Invitation tokens are stored
 * hashed, so the chooser cannot link to the emailed token directly; instead
 * this action re-issues the SIGNED-IN user's OWN pending invitation (the same
 * supersede semantics as the admin "Resend invite" path) and hands off to the
 * existing /invite/accept flow.
 *
 * Security model: the session must be authenticated, and the token is only
 * ever minted for the caller's own user row where (a) an organization_memberships
 * row with status='invited' exists for the requested org AND (b)
 * resendWorkspaceInvitation's own pending-profile checks pass. Being signed in
 * proves at least as much account control as the email link the token
 * replaces. A failure of any check redirects back with a frontend-safe error
 * code — never a token, never internals.
 */
export async function acceptPendingInviteAction(formData: FormData): Promise<void> {
  if (!isMultiWorkspaceEnabled()) {
    redirect(WORKSPACE_CHOOSER_PATH);
  }

  const session = await auth();
  if (!session?.user?.id) {
    redirect(`/login?callbackUrl=${encodeURIComponent(WORKSPACE_CHOOSER_PATH)}`);
  }

  const organizationId = String(formData.get('organizationId') ?? '');
  let rawToken: string | null = null;

  if (/^\d+$/.test(organizationId)) {
    const client = await pool.connect();
    try {
      const membership = await client.query(
        `SELECT 1
           FROM organization_memberships
          WHERE user_id = $1 AND organization_id = $2 AND status = 'invited'
          LIMIT 1`,
        [Number(session.user.id), Number(organizationId)],
      );
      if ((membership.rowCount ?? 0) > 0) {
        const result = await resendWorkspaceInvitation(client, {
          organizationId,
          userId: String(session.user.id),
          invitedByUserId: null,
        });
        if (result.status === 'ok') {
          rawToken = result.rawToken;
        }
      }
    } finally {
      client.release();
    }
  }

  if (!rawToken) {
    redirect(`${WORKSPACE_CHOOSER_PATH}?error=invite_link`);
  }
  redirect(`/invite/accept?token=${encodeURIComponent(rawToken)}`);
}
