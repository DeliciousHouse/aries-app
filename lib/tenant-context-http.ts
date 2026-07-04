import {
  getTenantContext,
  TenantContextError,
  WorkspaceMismatchError,
  type TenantContext,
} from '@/lib/tenant-context';

export type TenantContextLoader = () => Promise<TenantContext>;

/**
 * Map a caught error to the shared `409 workspace_mismatch` response when (and
 * only when) it is a WorkspaceMismatchError thrown by the getTenantContext()
 * mutation guard (plan Decision 2a). Returns null otherwise so callers keep
 * their existing error handling.
 *
 * This is the ONE place the 409 body is shaped. It is consumed BOTH by the
 * loadTenantContextOrResponse wrapper below (the ~43 wrapper routes) AND by the
 * ~9 mutating routes that call getTenantContext() directly — both styles route
 * the mismatch into the frontend's stale-workspace interlock via this shape.
 * The body is frontend-safe: both ids are workspaces the caller is (or was)
 * associated with; no tokens or internal state leak.
 */
export function workspaceMismatchResponse(error: unknown): Response | null {
  if (!(error instanceof WorkspaceMismatchError)) {
    return null;
  }
  return new Response(
    JSON.stringify({
      status: 'error',
      reason: 'workspace_mismatch',
      code: 'workspace_mismatch',
      message:
        'This tab was working in a different workspace than your account is now active in. Your action was not performed.',
      active_workspace_id: error.activeWorkspaceId,
      requested_workspace_id: error.requestedWorkspaceId,
    }),
    { status: 409, headers: { 'content-type': 'application/json' } },
  );
}

export interface TenantContextHttpOptions {
  missingMembershipResponse?: {
    status: number;
    reason: string;
    message: string;
  };
}

export async function loadTenantContextOrResponse(
  tenantContextLoader: TenantContextLoader = getTenantContext,
  options: TenantContextHttpOptions = {}
): Promise<{ tenantContext: TenantContext } | { response: Response }> {
  try {
    return { tenantContext: await tenantContextLoader() };
  } catch (error) {
    // Multi-workspace mutation guard (Decision 2a): a pinned-workspace mismatch
    // is a 409, never the generic 403 — the frontend routes it into the
    // stale-workspace interlock.
    const mismatch = workspaceMismatchResponse(error);
    if (mismatch) {
      return { response: mismatch };
    }

    const message = error instanceof Error ? error.message : 'Authentication required.';
    const tenantContextError = error instanceof TenantContextError ? error : null;
    const missingMembership =
      tenantContextError?.reason === 'tenant_membership_missing'
        ? options.missingMembershipResponse
        : undefined;

    return {
      response: new Response(
        JSON.stringify({
          status: 'error',
          reason:
            missingMembership?.reason ??
            tenantContextError?.reason ??
            'tenant_context_required',
          message: missingMembership?.message ?? message,
          ...(tenantContextError?.missingClaims.length
            ? { missing_claims: tenantContextError.missingClaims }
            : {}),
        }),
        {
          status: missingMembership?.status ?? 403,
          headers: { 'content-type': 'application/json' },
        }
      ),
    };
  }
}
