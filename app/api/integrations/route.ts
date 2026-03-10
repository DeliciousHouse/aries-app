import { oauthStatus } from '../../../backend/integrations/status';
import { PROVIDER_REGISTRY } from '../../../backend/integrations/provider-registry';

const platforms = Object.keys(PROVIDER_REGISTRY) as Array<keyof typeof PROVIDER_REGISTRY>;

function mapState(connectionStatus: string) {
  if (connectionStatus === 'connected') return 'connected';
  if (connectionStatus === 'pending_oauth') return 'connection_pending';
  return 'not_connected';
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
      health: status.health === 'healthy' ? 'healthy' : 'unknown',
      available_actions: status.connection_status === 'connected' ? ['sync_now', 'disconnect', 'view_permissions'] : ['connect', 'view_permissions'],
      last_synced_at: status.last_success_at || null,
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
