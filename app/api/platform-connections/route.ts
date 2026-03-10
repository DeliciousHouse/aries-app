import { oauthStatus } from '../../../backend/integrations/status';
import { PROVIDER_REGISTRY } from '../../../backend/integrations/provider-registry';
import { resolveTokenHealth } from '../../../backend/integrations/connection-schema';

const platforms = Object.keys(PROVIDER_REGISTRY) as Array<keyof typeof PROVIDER_REGISTRY>;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const tenantId = url.searchParams.get('tenant_id') || 'tenant_demo_001';

  const connections = platforms.map((provider) => {
    const state = oauthStatus(provider, tenantId);
    if ('broker_status' in state) return null;
    return {
      schema_name: 'aries_platform_connection',
      schema_version: '1.0.0',
      tenant_id: tenantId,
      provider,
      connection_id: state.integration_id || `pending_${provider}`,
      status: state.connection_status === 'connected' ? 'connected' : 'disconnected',
      token_health: resolveTokenHealth(state.last_success_at),
      expires_at: undefined,
      updated_at: state.updated_at
    };
  }).filter(Boolean);

  return new Response(JSON.stringify({ status: 'ok', connections }), { status: 200, headers: { 'content-type': 'application/json' } });
}
