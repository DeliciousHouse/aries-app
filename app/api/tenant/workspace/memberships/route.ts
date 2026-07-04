import { NextResponse } from 'next/server';

import pool from '@/lib/db';
import { auth } from '@/auth';
import { isMultiWorkspaceEnabled } from '@/backend/tenant/multi-workspace-env';
import { loadWorkspaceSwitcherData } from '@/backend/tenant/workspace-switcher';

// Workspace switcher list endpoint (multi-workspace plan Phase 3).
//
// Read-only projection the app-shell switcher fetches to fill its menu (active
// memberships in MRU order + pending invites). Deliberately a GET: the shell's
// browser client must NOT attach the x-aries-workspace-id mutation-guard header
// to it (reads are allowed to be one render stale — plan Decision 2a).
//
// Flag OFF: invisible — a real 404 (no switcher exists), no DB reads. This
// mirrors the switch endpoint's flag-off contract so the two move together.

export async function GET() {
  if (!isMultiWorkspaceEnabled()) {
    return new Response(null, { status: 404 });
  }

  let session;
  try {
    session = await auth();
  } catch {
    session = null;
  }
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: 'sign_in_required', message: 'Sign in to view your workspaces.' },
      { status: 401 },
    );
  }

  const currentWorkspaceId = session.user.tenantId ? String(session.user.tenantId) : null;

  const client = await pool.connect();
  try {
    const data = await loadWorkspaceSwitcherData(client, session.user.id, currentWorkspaceId);
    return NextResponse.json({ status: 'ok', ...data });
  } catch (error) {
    console.error('[workspace-memberships] failed to load switcher data', {
      userId: String(session.user.id),
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: 'memberships_unavailable', message: 'Unable to load your workspaces right now.' },
      { status: 500 },
    );
  } finally {
    client.release();
  }
}
