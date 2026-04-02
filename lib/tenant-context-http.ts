import { getTenantContext, TenantContextError, type TenantContext } from '@/lib/tenant-context';

export type TenantContextLoader = () => Promise<TenantContext>;

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
