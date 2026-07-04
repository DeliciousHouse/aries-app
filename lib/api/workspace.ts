import type { WorkspaceSwitcherData } from '@/backend/tenant/workspace-switcher';
import type { TenantRole } from '@/lib/tenant-context';

/**
 * Browser client for the multi-workspace switcher (plan Phase 3). Both calls use
 * a bare `fetch` and deliberately bypass lib/api/http.ts so the switch request
 * can never pick up the x-aries-workspace-id mutation-guard header (the switch
 * is the ONE mutation the guard must not block — the tab is pinned to the OLD
 * workspace by definition). The memberships read is a GET and carries no header
 * regardless.
 */

export type WorkspaceSwitchSuccess = {
  status: 'ok';
  workspace: { id: string; slug: string; name: string | null; role: TenantRole };
  redirectTo: string;
};

export type WorkspaceSwitchFailure = {
  status: 'error';
  code: string;
  message: string;
  httpStatus: number;
};

export type WorkspaceSwitchResult = WorkspaceSwitchSuccess | WorkspaceSwitchFailure;

const SWITCH_PATH = '/api/tenant/workspace/switch';
const MEMBERSHIPS_PATH = '/api/tenant/workspace/memberships';

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed = (await response.json()) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Refetch the switcher list (used when the menu opens to catch membership changes). */
export async function fetchWorkspaceSwitcherData(): Promise<WorkspaceSwitcherData> {
  const response = await fetch(MEMBERSHIPS_PATH, {
    method: 'GET',
    headers: { accept: 'application/json' },
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`workspace_memberships_failed:${response.status}`);
  }
  const body = await readJson(response);
  return {
    currentWorkspaceId: body.currentWorkspaceId != null ? String(body.currentWorkspaceId) : null,
    workspaces: Array.isArray(body.workspaces)
      ? (body.workspaces as WorkspaceSwitcherData['workspaces'])
      : [],
    pendingInvites: Array.isArray(body.pendingInvites)
      ? (body.pendingInvites as WorkspaceSwitcherData['pendingInvites'])
      : [],
  };
}

/**
 * POST the workspace switch. On 200 the caller HARD-navigates to redirectTo (do
 * NOT preserve the current route — it points at cross-tenant data). Errors are
 * returned (never thrown) so the switcher can show an inline error inside the
 * flyout without a toast system.
 */
export async function requestWorkspaceSwitch(organizationId: string): Promise<WorkspaceSwitchResult> {
  let response: Response;
  try {
    response = await fetch(SWITCH_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ organizationId }),
      cache: 'no-store',
    });
  } catch {
    return {
      status: 'error',
      code: 'network_error',
      message: 'Could not reach the server. Check your connection and try again.',
      httpStatus: 0,
    };
  }

  const body = await readJson(response);

  if (response.ok && body.status === 'ok' && typeof body.workspace === 'object' && body.workspace !== null) {
    const workspace = body.workspace as Record<string, unknown>;
    return {
      status: 'ok',
      workspace: {
        id: String(workspace.id ?? organizationId),
        slug: String(workspace.slug ?? ''),
        name: workspace.name != null ? String(workspace.name) : null,
        role: workspace.role as TenantRole,
      },
      redirectTo: typeof body.redirectTo === 'string' ? body.redirectTo : '/dashboard',
    };
  }

  const code =
    typeof body.error === 'string'
      ? body.error
      : typeof body.code === 'string'
        ? body.code
        : 'switch_failed';
  return {
    status: 'error',
    code,
    message: typeof body.message === 'string' ? body.message : switchErrorMessage(code),
    httpStatus: response.status,
  };
}

export function switchErrorMessage(code: string): string {
  switch (code) {
    case 'not_a_member':
      return 'You are no longer a member of that workspace.';
    case 'invitation_pending':
      return 'Accept your invite to this workspace first.';
    case 'invalid_workspace_id':
      return 'That workspace cannot be selected.';
    case 'sign_in_required':
      return 'Your session expired — sign in again.';
    default:
      return 'Could not switch workspaces. Try again.';
  }
}
