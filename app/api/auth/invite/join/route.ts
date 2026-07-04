import { NextResponse } from 'next/server';

import pool from '@/lib/db';
import { auth } from '@/auth';
import { isMultiWorkspaceEnabled } from '@/backend/tenant/multi-workspace-env';
import {
  acceptJoinInvitation,
  declineAbsorbInvitation,
} from '@/backend/tenant/workspace-invitations';

// Join-as-existing-account consent endpoint (multi-workspace plan Phase 2,
// Decision 4). Activates the caller's status='invited' membership in the
// inviting workspace — activation ONLY, never a credential write.
//
// Auth model: REQUIRES a signed-in session, and the domain function verifies
// the session IS the invited account (user id + email match against the
// invitation row) inside the lock-based transaction — token possession alone
// can never join (the same consent-auth rule as the Phase 0.5 absorb route).
// getTenantContext() is deliberately NOT the gate here: the invitee's tenant
// context still resolves to their CURRENT workspace, not the one they are
// consenting to join.
//
// Flag OFF: the endpoint is invisible — a real 404, no DB reads.

type JoinBody = {
  token?: unknown;
  intent?: unknown;
};

function errorResponse(code: string, message: string, status: number) {
  return NextResponse.json({ error: code, message }, { status });
}

const INVALID_MESSAGE = 'This invite link is invalid or has expired.';

export async function POST(req: Request) {
  if (!isMultiWorkspaceEnabled()) {
    return new Response(null, { status: 404 });
  }

  let body: JoinBody = {};
  try {
    body = (await req.json()) as JoinBody;
  } catch {
    body = {};
  }

  const token = typeof body.token === 'string' ? body.token.trim() : '';
  const intent = body.intent === 'decline' ? 'decline' : 'accept';

  if (!token) {
    return errorResponse('invalid_or_expired', INVALID_MESSAGE, 400);
  }

  let session;
  try {
    session = await auth();
  } catch {
    session = null;
  }
  if (!session?.user?.id) {
    return errorResponse('sign_in_required', 'Sign in as the invited account to continue.', 401);
  }

  let client;
  try {
    client = await pool.connect();

    if (intent === 'decline') {
      // Decline is invitation-generic (expire the token for the invited
      // account only) — the invited membership row stays, so the admin's
      // "Resend invite" still works if the person changes their mind.
      const declined = await declineAbsorbInvitation(client, {
        rawToken: token,
        sessionUserId: session.user.id,
        sessionEmail: session.user.email ?? null,
      });
      if (declined.status === 'email_mismatch') {
        return errorResponse(
          'invitation_for_different_account',
          'This invitation was sent to a different account.',
          403,
        );
      }
      if (declined.status === 'invalid') {
        return errorResponse('invalid_or_expired', INVALID_MESSAGE, 400);
      }
      return NextResponse.json({ success: true, declined: true });
    }

    const result = await acceptJoinInvitation(client, {
      rawToken: token,
      sessionUserId: session.user.id,
      sessionEmail: session.user.email ?? null,
    });

    switch (result.status) {
      case 'ok':
        return NextResponse.json({ success: true });
      case 'already_member':
        // Idempotent convergence: reloads and double-clicks land here.
        return NextResponse.json({ success: true, alreadyMember: true });
      case 'email_mismatch':
        return errorResponse(
          'invitation_for_different_account',
          'This invitation was sent to a different account.',
          403,
        );
      case 'requires_pro':
        // Decision 13: the paywall never destroys the invite — the invited
        // membership + invitation persist, so the person can accept later
        // once upgraded. Frontend-safe code only.
        return NextResponse.json(
          {
            error: 'multi_workspace_requires_pro',
            code: 'multi_workspace_requires_pro',
            message:
              'Your account is on the free plan, which includes one workspace. Joining a second workspace needs Aries Pro. Your invitation stays valid.',
          },
          { status: 402 },
        );
      case 'workspace_gone':
        return errorResponse('workspace_gone', 'This workspace no longer exists.', 410);
      default:
        // invalid / expired / already_accepted / not_join collapse to one
        // message so this endpoint never discloses token state to a caller
        // who is not the invitee.
        return errorResponse('invalid_or_expired', INVALID_MESSAGE, 400);
    }
  } catch (error) {
    console.error('[invite-join] unexpected error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('join_failed', 'Unable to accept this invite right now.', 500);
  } finally {
    client?.release();
  }
}
