import { getTenantContext, type TenantContext } from '@/lib/tenant-context';

export type TenantContextLoader = () => Promise<TenantContext>;

export async function loadTenantContextOrResponse(
  tenantContextLoader: TenantContextLoader = getTenantContext
): Promise<{ tenantContext: TenantContext } | { response: Response }> {
  try {
    return { tenantContext: await tenantContextLoader() };
  } catch (error) {
    return {
      response: new Response(
        JSON.stringify({
          status: 'error',
          reason: 'tenant_context_required',
          message: error instanceof Error ? error.message : 'Authentication required.',
        }),
        { status: 403, headers: { 'content-type': 'application/json' } }
      ),
    };
  }
}
