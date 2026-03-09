import { brokerError, isAllowedProvider, oauthStore, type OAuthBrokerError } from './connect';

type OAuthDisconnectRequest = {
  connection_id?: string;
  revoke_provider_token?: boolean;
  reason?: string;
};

type OAuthDisconnectSuccess = {
  broker_status: 'ok';
  provider: string;
  connection_id: string;
  connection_status: 'disconnected';
  disconnected: true;
  disconnected_at?: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function providerTenantKey(tenantId: string, provider: string): string {
  return `${tenantId}::${provider}`;
}

export async function oauthDisconnect(provider: string, payload: OAuthDisconnectRequest): Promise<OAuthDisconnectSuccess | OAuthBrokerError> {
  if (!isAllowedProvider(provider)) return brokerError('invalid_provider', { provider });
  if (!payload.connection_id || payload.connection_id.trim().length === 0) {
    return brokerError('missing_required_fields', { provider, message: 'missing_required_fields:connection_id' });
  }

  const connectionId = payload.connection_id.trim();
  const store = oauthStore();
  const connection = store.connectionsById.get(connectionId);

  if (!connection || connection.provider !== provider) {
    return brokerError('connection_not_found', { provider, connection_id: connectionId });
  }

  try {
    const at = nowIso();
    connection.connection_status = 'disconnected';
    connection.updated_at = at;
    connection.disconnected_at = at;
    store.connectionsById.set(connectionId, connection);
    store.connectedByTenantProvider.delete(providerTenantKey(connection.tenant_id, provider));

    return {
      broker_status: 'ok',
      provider,
      connection_id: connectionId,
      connection_status: 'disconnected',
      disconnected: true,
      disconnected_at: at
    };
  } catch {
    return brokerError('disconnect_failed', { provider, connection_id: connectionId });
  }
}

export async function handleOauthDisconnectHttp(req: Request, providerFromPath?: string): Promise<Response> {
  let payload: OAuthDisconnectRequest = {};
  try {
    payload = (await req.json()) as OAuthDisconnectRequest;
  } catch {
    payload = {};
  }

  const url = new URL(req.url);
  const provider = (providerFromPath || url.searchParams.get('provider') || '').toLowerCase();
  const result = await oauthDisconnect(provider, payload);

  const status =
    result.broker_status === 'ok'
      ? 200
      : result.reason === 'invalid_provider' || result.reason === 'missing_required_fields'
        ? 400
        : result.reason === 'connection_not_found'
          ? 404
          : 500;

  return new Response(JSON.stringify(result), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
