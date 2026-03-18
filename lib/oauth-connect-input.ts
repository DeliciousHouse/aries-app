import { PROVIDER_REGISTRY } from '@/backend/integrations/provider-registry';
import type { TenantContext } from '@/lib/tenant-context';

function resolveBaseUrl(req: Request): string {
  const configuredBaseUrl = process.env.APP_BASE_URL?.trim();
  if (configuredBaseUrl) {
    try {
      return new URL(configuredBaseUrl).origin;
    } catch {
      // Fall back to the incoming request origin when APP_BASE_URL is invalid.
    }
  }

  return new URL(req.url).origin;
}

export async function buildOauthConnectInput(
  req: Request,
  tenantContext: TenantContext,
  providerOverride?: string
) {
  const body = await req.json();
  const provider = String(providerOverride || body.platform || '').toLowerCase();

  return {
    provider,
    payload: {
      tenant_id: tenantContext.tenantId,
      redirect_uri: `${resolveBaseUrl(req)}/api/auth/oauth/${provider}/callback`,
      scopes: PROVIDER_REGISTRY[provider as keyof typeof PROVIDER_REGISTRY]?.default_scopes || [],
    },
  };
}
