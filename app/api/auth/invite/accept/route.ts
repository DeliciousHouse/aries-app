import { NextResponse } from 'next/server';

import pool from '@/lib/db';
import { acceptWorkspaceInvitation } from '@/backend/tenant/workspace-invitations';

type AcceptInviteBody = {
  token?: unknown;
  password?: unknown;
};

function errorResponse(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: Request) {
  let body: AcceptInviteBody = {};
  try {
    body = (await req.json()) as AcceptInviteBody;
  } catch {
    body = {};
  }

  const token = typeof body.token === 'string' ? body.token.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!token) {
    return errorResponse('This invite link is invalid or has expired.');
  }

  let client;
  try {
    client = await pool.connect();
    const result = await acceptWorkspaceInvitation(client, { rawToken: token, password });

    if (result.status !== 'ok') {
      if (result.status === 'weak_password') {
        return errorResponse(
          'Password must be at least 8 characters and include an uppercase letter, a number, and a special character.',
        );
      }
      // Collapse all token-state failures to one client message so we never
      // disclose whether an email is invited, expired, or already accepted.
      return errorResponse('This invite link is invalid or has expired.');
    }

    return NextResponse.json({ success: true, email: result.email });
  } catch (error) {
    console.error('[invite-accept] unexpected error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('Unable to accept this invite right now.', 500);
  } finally {
    client?.release();
  }
}
