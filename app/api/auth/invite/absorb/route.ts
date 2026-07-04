import { NextResponse } from 'next/server';

import pool from '@/lib/db';
import { auth } from '@/auth';
import {
  acceptAbsorbInvitation,
  declineAbsorbInvitation,
} from '@/backend/tenant/workspace-invitations';

// Absorb-orphan consent endpoint (multi-workspace plan Phase 0.5).
//
// Auth model: this route REQUIRES a signed-in session, and the domain function
// additionally verifies the session IS the invited account (user id + email
// match against the invitation row) inside the transaction — token possession
// alone can never absorb (eng review finding 3c). getTenantContext() is
// deliberately NOT the gate here: the invitee's tenant context still resolves
// to their OLD (source) workspace at this point, and mid-onboarding accounts
// may not resolve one at all.
//
// The repoint executes ONLY on this consent click — never on admin action.

type AbsorbBody = {
  token?: unknown;
  intent?: unknown;
};

function errorResponse(code: string, message: string, status: number) {
  return NextResponse.json({ error: code, message }, { status });
}

const INVALID_MESSAGE = 'This invite link is invalid or has expired.';

export async function POST(req: Request) {
  let body: AbsorbBody = {};
  try {
    body = (await req.json()) as AbsorbBody;
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

    const result = await acceptAbsorbInvitation(client, {
      rawToken: token,
      sessionUserId: session.user.id,
      sessionEmail: session.user.email ?? null,
    });

    switch (result.status) {
      case 'ok':
        return NextResponse.json({ success: true });
      case 'already_member':
        // Idempotent convergence: the account is already in the inviting
        // workspace — reloads and double-clicks land here, not on an error.
        return NextResponse.json({ success: true, alreadyMember: true });
      case 'email_mismatch':
        return errorResponse(
          'invitation_for_different_account',
          'This invitation was sent to a different account.',
          403,
        );
      case 'workspace_in_use':
        return errorResponse(
          'workspace_in_use',
          'Your workspace now has activity, so it can no longer be folded into another one. This invitation is no longer valid.',
          409,
        );
      default:
        // invalid / expired / already_accepted / not_absorb collapse to one
        // message so this endpoint never discloses token state to a caller who
        // is not the invitee.
        return errorResponse('invalid_or_expired', INVALID_MESSAGE, 400);
    }
  } catch (error) {
    console.error('[invite-absorb] unexpected error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('absorb_failed', 'Unable to accept this invite right now.', 500);
  } finally {
    client?.release();
  }
}
