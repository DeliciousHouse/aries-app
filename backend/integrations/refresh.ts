import { isAllowedProvider, oauthStore, brokerError } from './connect';

export async function oauthRefresh(provider: string, tenantId?: string) {
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
  store.connectionsById.set(connectionId, connection);

  return {
    broker_status: 'ok' as const,
    provider,
    connection_id: connection.connection_id,
    connection_status: 'connected' as const,
    refreshed_at: connection.updated_at
  };
}
