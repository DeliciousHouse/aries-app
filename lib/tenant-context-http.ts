import { getTenantContext, type TenantContext } from '@/lib/tenant-context';

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
    const missingMembership =
      message === 'No tenant membership found for authenticated user.' &&
      options.missingMembershipResponse;

    return {
      response: new Response(
        JSON.stringify({
          status: 'error',
          reason: missingMembership?.reason ?? 'tenant_context_required',
          message: missingMembership?.message ?? message,
        }),
        {
          status: missingMembership?.status ?? 403,
          headers: { 'content-type': 'application/json' },
        }
      ),
    };
  }
}
