import { NextResponse } from 'next/server';

import pool from '@/lib/db';
import { describeInvitationByToken } from '@/backend/tenant/workspace-invitations';

// Read-only token check for the accept page. Returns the invited email when the
// token is live so the page can greet the teammate; otherwise reports that the
// link is unusable without distinguishing invalid / expired / already-accepted
// to a caller who is not the invitee.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = (url.searchParams.get('token') || '').trim();

  if (!token) {
    return NextResponse.json({ valid: false });
  }

  let client;
  try {
    client = await pool.connect();
    const result = await describeInvitationByToken(client, token);
    if (result.status === 'valid') {
      return NextResponse.json({ valid: true, email: result.email });
    }
    return NextResponse.json({ valid: false });
  } catch (error) {
    console.error('[invite-validate] unexpected error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ valid: false }, { status: 500 });
  } finally {
    client?.release();
  }
}
