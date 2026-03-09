import {
  brokerError,
  isAllowedProvider,
  oauthStore,
  type OAuthBrokerError,
  type PendingAuthRecord,
  type Provider
} from './connect';

type OAuthCallbackQuery = {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
};

type OAuthCallbackSuccess = {
  broker_status: 'ok';
  provider: string;
  connection_id: string;
  connection_status: 'connected';
  connected_at?: string;
  granted_scopes?: string[];
};

function nowIso(): string {
  return new Date().toISOString();
}

function randomConnectionId(provider: Provider): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${provider}_${crypto.randomUUID().replace(/-/g, '')}`;
  }
  return `${provider}_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function providerTenantKey(tenantId: string, provider: Provider): string {
  return `${tenantId}::${provider}`;
}

function resolveProviderErrorReason(errorCode: string): OAuthBrokerError['reason'] {
  if (errorCode === 'access_denied') return 'authorization_denied';
  return 'provider_callback_error';
}

export async function oauthCallback(provider: string, query: OAuthCallbackQuery): Promise<OAuthCallbackSuccess | OAuthBrokerError> {
  if (!isAllowedProvider(provider)) return brokerError('invalid_provider', { provider });

  if (!query.state || query.state.trim().length < 8) {
    return brokerError('invalid_state', { provider, message: 'missing or invalid state' });
  }

  const state = query.state.trim();
  const store = oauthStore();
  const pending = store.pendingByState.get(state) as PendingAuthRecord | undefined;

  if (!pending || pending.provider !== provider) {
    return brokerError('invalid_state', { provider, message: 'state not found or provider mismatch' });
  }

  if (new Date(pending.expires_at).getTime() <= Date.now()) {
    store.pendingByState.delete(state);
    return brokerError('invalid_state', { provider, message: 'state expired' });
  }

  if (query.error && query.error.trim().length > 0) {
    store.pendingByState.delete(state);
    return brokerError(resolveProviderErrorReason(query.error.trim()), {
      provider,
      message: query.error_description?.trim() || query.error.trim()
    });
  }

  if (!query.code || query.code.trim().length === 0) {
    return brokerError('missing_required_fields', { provider, message: 'missing_required_fields:code' });
  }

  const connectedAt = nowIso();
  const connectionId = pending.connection_id || randomConnectionId(provider);

  store.connectionsById.set(connectionId, {
    connection_id: connectionId,
    provider,
    tenant_id: pending.tenant_id,
    connection_status: 'connected',
    granted_scopes: pending.scopes,
    created_at: connectedAt,
    updated_at: connectedAt
  });
  store.connectedByTenantProvider.set(providerTenantKey(pending.tenant_id, provider), connectionId);
  store.pendingByState.delete(state);

  return {
    broker_status: 'ok',
    provider,
    connection_id: connectionId,
    connection_status: 'connected',
    connected_at: connectedAt,
    granted_scopes: pending.scopes
  };
}

export async function handleOauthCallbackHttp(req: Request, providerFromPath?: string): Promise<Response> {
  const url = new URL(req.url);
  const provider = (providerFromPath || url.searchParams.get('provider') || '').toLowerCase();
  const query: OAuthCallbackQuery = {
    code: url.searchParams.get('code') || undefined,
    state: url.searchParams.get('state') || undefined,
    error: url.searchParams.get('error') || undefined,
    error_description: url.searchParams.get('error_description') || undefined
  };

  const result = await oauthCallback(provider, query);
  const status =
    result.broker_status === 'ok'
      ? 200
      : result.reason === 'invalid_provider' || result.reason === 'missing_required_fields' || result.reason === 'invalid_state'
        ? 400
        : result.reason === 'authorization_denied'
          ? 401
          : result.reason === 'provider_callback_error'
            ? 409
            : 500;

  return new Response(JSON.stringify(result), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
