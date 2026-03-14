import { oauthStatus } from '../../../backend/integrations/status';
import { resolveTokenHealth } from '../../../backend/integrations/connection-schema';
import { PROVIDER_REGISTRY } from '../../../backend/integrations/provider-registry';

const platforms = Object.keys(PROVIDER_REGISTRY) as Array<keyof typeof PROVIDER_REGISTRY>;

function mapState(connectionStatus: string) {
  if (connectionStatus === 'connected') return 'connected';
  if (connectionStatus === 'pending_oauth') return 'connection_pending';
  if (connectionStatus === 'token_expired' || connectionStatus === 'revoked' || connectionStatus === 'permission_denied') {
    return 'reauth_required';
  }
  return 'not_connected';
}

function mapHealth(connectionStatus: string, tokenExpiresAt?: string) {
  if (connectionStatus !== 'connected' && connectionStatus !== 'token_expired') return 'unknown';

  switch (resolveTokenHealth(tokenExpiresAt)) {
    case 'healthy':
      return 'healthy';
    case 'expiring_soon':
      return 'degraded';
    case 'expired':
      return 'error';
    default:
      return 'unknown';
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const tenantId = url.searchParams.get('tenant_id') || 'tenant_demo_001';

  const cards = platforms.map((platform) => {
    const status = oauthStatus(platform, tenantId);
    if ('broker_status' in status) {
      return {
        platform,
        display_name: PROVIDER_REGISTRY[platform].display_name,
        description: `Connect ${PROVIDER_REGISTRY[platform].display_name}`,
        connection_state: 'connection_error',
        health: 'error',
        available_actions: ['connect'],
        permissions: []
      };
    }

    return {
      platform,
      display_name: PROVIDER_REGISTRY[platform].display_name,
      description: `Connect ${PROVIDER_REGISTRY[platform].display_name}`,
      connection_state: mapState(status.connection_status),
      health: mapHealth(status.connection_status, status.token_expires_at),
      available_actions: status.connection_status === 'connected' ? ['sync_now', 'disconnect', 'view_permissions'] : ['connect', 'view_permissions'],
      last_synced_at: null,
      expires_at: status.token_expires_at || null,
      permissions: []
    };
  });

  const summary = {
    total: platforms.length,
    connected: cards.filter((c) => c.connection_state === 'connected').length,
    not_connected: cards.filter((c) => c.connection_state === 'not_connected').length,
    attention_required: cards.filter((c) => c.connection_state === 'connection_error').length
  };

  return new Response(JSON.stringify({ status: 'ok', page_state: 'ready', supported_platforms: platforms, cards, summary }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}
