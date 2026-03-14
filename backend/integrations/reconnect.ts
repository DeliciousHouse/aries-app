import { brokerError, isAllowedProvider, oauthStore, type OAuthBrokerError } from './connect';

type OAuthReconnectRequest = {
  connection_id?: string;
  redirect_uri?: string;
  scopes?: string[];
};

type OAuthReconnectSuccess = {
  broker_status: 'ok';
  provider: string;
  connection_id: string;
  connection_status: 'reauthorization_required';
  authorization_url: string;
  state: string;
  expires_at?: string;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeScopes(scopes: unknown, fallback: string[]): string[] {
  if (!Array.isArray(scopes)) {
    return fallback;
  }

  const clean = scopes.filter(isNonEmptyString).map((scope) => scope.trim());
  return clean.length > 0 ? Array.from(new Set(clean)) : fallback;
}

function isValidUri(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function randomStateToken(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `state_${crypto.randomUUID().replace(/-/g, '')}`;
  }

  return `state_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

export async function oauthReconnect(
  provider: string,
  payload: OAuthReconnectRequest
): Promise<OAuthReconnectSuccess | OAuthBrokerError> {
  if (!isAllowedProvider(provider)) {
    return brokerError('invalid_provider', { provider });
  }

  if (!isNonEmptyString(payload.connection_id) || !isNonEmptyString(payload.redirect_uri)) {
    return brokerError('missing_required_fields', {
      provider,
      message: 'missing_required_fields:connection_id,redirect_uri',
    });
  }

  const redirectUri = payload.redirect_uri.trim();
  if (!isValidUri(redirectUri)) {
    return brokerError('validation_error', { provider, message: 'redirect_uri must be a valid uri' });
  }

  const store = oauthStore();
  const connectionId = payload.connection_id.trim();
  const existingConnection = store.connectionsById.get(connectionId);

  if (!existingConnection || existingConnection.provider !== provider) {
    return brokerError('connection_not_found', { provider, connection_id: connectionId });
  }

  const state = randomStateToken();
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const scopes = normalizeScopes(payload.scopes, existingConnection.granted_scopes);

  store.pendingByState.set(state, {
    state,
    provider,
    tenant_id: existingConnection.tenant_id,
    redirect_uri: redirectUri,
    scopes,
    expires_at: expiresAt,
    connection_id: connectionId,
  });

  existingConnection.connection_status = 'reauthorization_required';
  existingConnection.updated_at = new Date().toISOString();
  store.connectionsById.set(connectionId, existingConnection);

  const authorizationUrl = new URL(`https://oauth.${provider}.example/authorize`);
  authorizationUrl.searchParams.set('response_type', 'code');
  authorizationUrl.searchParams.set('client_id', `${provider}_client`);
  authorizationUrl.searchParams.set('redirect_uri', redirectUri);
  authorizationUrl.searchParams.set('state', state);
  if (scopes.length > 0) {
    authorizationUrl.searchParams.set('scope', scopes.join(' '));
  }

  return {
    broker_status: 'ok',
    provider,
    connection_id: connectionId,
    connection_status: 'reauthorization_required',
    authorization_url: authorizationUrl.toString(),
    state,
    expires_at: expiresAt,
  };
}

export async function handleOauthReconnectHttp(req: Request, providerFromPath?: string): Promise<Response> {
  let payload: OAuthReconnectRequest = {};
  try {
    payload = (await req.json()) as OAuthReconnectRequest;
  } catch {
    payload = {};
  }

  const url = new URL(req.url);
  const provider = (providerFromPath || url.searchParams.get('provider') || '').toLowerCase();
  const result = await oauthReconnect(provider, payload);

  const status =
    result.broker_status === 'ok'
      ? 200
      : result.reason === 'missing_required_fields' || result.reason === 'invalid_provider' || result.reason === 'validation_error'
        ? 400
        : result.reason === 'connection_not_found'
          ? 404
          : 500;

  return new Response(JSON.stringify(result), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
