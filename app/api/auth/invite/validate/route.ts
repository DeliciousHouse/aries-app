import { NextResponse } from 'next/server';

import pool from '@/lib/db';
import { auth } from '@/auth';
import { describeInvitationAcceptContext } from '@/backend/tenant/workspace-invitations';
import { roleLabel } from '@/backend/tenant/invite-presentation';

// Read-only token check for the accept page. Returns the invited email when the
// token is live so the page can greet the teammate; otherwise reports that the
// link is unusable without distinguishing invalid / expired / already-accepted
// to a caller who is not the invitee.
//
// Phase 0.5 (absorb-orphan): when the invitation targets an existing active
// account in another workspace, the response also carries `mode: 'absorb'`,
// the consent-page disclosure context (workspace name, inviter, role), and the
// signed-in viewer state — so the client can render the right auth state
// (sign-in prompt / wrong-account / consent) without a second fetch.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = (url.searchParams.get('token') || '').trim();

  if (!token) {
    return NextResponse.json({ valid: false });
  }

  let client;
  try {
    client = await pool.connect();
    const result = await describeInvitationAcceptContext(client, token);
    if (result.status !== 'valid') {
      return NextResponse.json({ valid: false });
    }
    if (result.mode === 'set_password') {
      return NextResponse.json({ valid: true, email: result.email, mode: 'set_password' });
    }

    // Absorb consent context. The viewer block only ever discloses the
    // caller's OWN session email back to them.
    let viewer: { signedIn: boolean; email: string | null; matchesInvite: boolean } = {
      signedIn: false,
      email: null,
      matchesInvite: false,
    };
    try {
      const session = await auth();
      if (session?.user?.id) {
        const sessionEmail = session.user.email?.trim().toLowerCase() ?? null;
        viewer = {
          signedIn: true,
          email: sessionEmail,
          matchesInvite: Boolean(sessionEmail && sessionEmail === result.email.trim().toLowerCase()),
        };
      }
    } catch {
      // Session resolution failure renders the signed-out state; the absorb
      // POST re-verifies consent auth server-side regardless.
    }

    return NextResponse.json({
      valid: true,
      email: result.email,
      mode: 'absorb',
      workspaceName: result.workspaceName,
      inviterName: result.inviterName,
      roleLabel: roleLabel(result.role),
      viewer,
    });
  } catch (error) {
    console.error('[invite-validate] unexpected error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ valid: false }, { status: 500 });
  } finally {
    client?.release();
  }
}
