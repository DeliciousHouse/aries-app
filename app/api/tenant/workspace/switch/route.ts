import { NextResponse } from 'next/server';

import pool from '@/lib/db';
import { auth } from '@/auth';
import { isMultiWorkspaceEnabled } from '@/backend/tenant/multi-workspace-env';
import { switchActiveWorkspace } from '@/backend/tenant/workspace-switch';

// Workspace switch endpoint (multi-workspace plan Phase 3, Decision 2 + CEO
// hardening 3).
//
// Auth model: REQUIRES a signed-in session. It deliberately does NOT gate on
// getTenantContext() — this is the ONE mutation that moves the account's active
// workspace, so the WORKSPACE_ID_HEADER guard inside getTenantContext() would
// 409 the very switch it is performing (the tab is, by definition, pinned to
// the OLD workspace). Membership in the target is validated server-side inside
// switchActiveWorkspace's transaction; the client's claim of membership is
// never trusted. (This is why inv-01b allowlists this route.)
//
// Flag OFF: the endpoint is invisible — a real 404, no DB reads (no switcher
// exists when the flag is off).

type SwitchBody = {
  organizationId?: unknown;
  workspaceId?: unknown;
};

function errorResponse(code: string, message: string, status: number) {
  return NextResponse.json({ error: code, message }, { status });
}

function parseTargetId(body: SwitchBody): string | null {
  // Accept `organizationId` (canonical) or `workspaceId` (alias) — both name the
  // target workspace/org id (== the tenantId the switcher rendered).
  const raw = body.organizationId ?? body.workspaceId;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) {
    return String(raw);
  }
  if (typeof raw === 'string' && /^[1-9]\d*$/.test(raw.trim())) {
    return raw.trim();
  }
  return null;
}

export async function POST(req: Request) {
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
    return errorResponse('sign_in_required', 'Sign in to switch workspaces.', 401);
  }

  let body: SwitchBody = {};
  try {
    body = (await req.json()) as SwitchBody;
  } catch {
    body = {};
  }

  const targetOrganizationId = parseTargetId(body);
  if (!targetOrganizationId) {
    return errorResponse('invalid_workspace_id', 'A valid target workspace id is required.', 400);
  }

  const client = await pool.connect();
  try {
    const result = await switchActiveWorkspace(client, {
      userId: session.user.id,
      targetOrganizationId,
    });

    switch (result.status) {
      case 'ok':
        // Structured switch LOG LINE (Decision 1 — switches are logs, not event
        // rows). The jwt re-hydrate propagates the new pointer on the next
        // request; the client hard-navigates to the new workspace's /dashboard.
        console.info('[workspace-switch] active workspace changed', {
          userId: String(session.user.id),
          fromWorkspaceId: session.user.tenantId ? String(session.user.tenantId) : null,
          toWorkspaceId: result.tenantId,
          role: result.role,
        });
        return NextResponse.json({
          status: 'ok',
          workspace: {
            id: result.tenantId,
            slug: result.tenantSlug,
            name: result.workspaceName,
            role: result.role,
          },
          // Hard-navigate target (design decision: never preserve the current
          // route across a switch — it points at cross-tenant data).
          redirectTo: '/dashboard',
        });
      case 'not_member':
        console.warn('[workspace-switch] rejected — not a member', {
          userId: String(session.user.id),
          targetWorkspaceId: targetOrganizationId,
        });
        return errorResponse('not_a_member', 'You are not a member of that workspace.', 403);
      case 'invited':
        return errorResponse(
          'invitation_pending',
          'Accept your invite to this workspace before switching to it.',
          403,
        );
      default:
        // 'invalid' — flag-off domain guard or a corrupt target row.
        return errorResponse('invalid_workspace_id', 'That workspace cannot be selected.', 400);
    }
  } catch (error) {
    console.error('[workspace-switch] unexpected error', {
      userId: String(session.user.id),
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('switch_failed', 'Unable to switch workspaces right now.', 500);
  } finally {
    client.release();
  }
}
