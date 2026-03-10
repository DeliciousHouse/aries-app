import { isAllowedProvider, oauthStore, brokerError } from './connect';

type OAuthRefreshInput = {
  token_expires_in_seconds?: number;
  refresh_expires_in_seconds?: number;
};

function addSeconds(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

export async function oauthRefresh(provider: string, tenantId?: string, input: OAuthRefreshInput = {}) {
  if (!isAllowedProvider(provider)) return brokerError('invalid_provider', { provider });
  if (!tenantId) return brokerError('missing_required_fields', { provider, message: 'missing_required_fields:tenant_id' });

  const store = oauthStore();
  const key = `${tenantId}::${provider}`;
  const connectionId = store.connectedByTenantProvider.get(key);
  if (!connectionId) return brokerError('connection_not_found', { provider });
  const connection = store.connectionsById.get(connectionId);
  if (!connection) return brokerError('connection_not_found', { provider });

  connection.updated_at = new Date().toISOString();
  connection.connection_status = 'connected';
  if (typeof input.token_expires_in_seconds === 'number' && input.token_expires_in_seconds > 0) {
    connection.token_expires_at = addSeconds(connection.updated_at, input.token_expires_in_seconds);
  }
  if (typeof input.refresh_expires_in_seconds === 'number' && input.refresh_expires_in_seconds > 0) {
    connection.refresh_token_expires_at = addSeconds(connection.updated_at, input.refresh_expires_in_seconds);
  }
  store.connectionsById.set(connectionId, connection);

  return {
    broker_status: 'ok' as const,
    provider,
    connection_id: connection.connection_id,
    connection_status: 'connected' as const,
    refreshed_at: connection.updated_at
  };
}
