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

function randomStateToken(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `state_${crypto.randomUUID().replace(/-/g, '')}`;
  }
  return `state_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeScopes(scopes: unknown): string[] {
  if (!Array.isArray(scopes)) return [];
  const clean = scopes.filter((s) => typeof s === 'string' && s.trim().length > 0).map((s) => (s as string).trim());
  return Array.from(new Set(clean));
}

function isValidUri(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export async function oauthReconnect(provider: string, payload: OAuthReconnectRequest): Promise<OAuthReconnectSuccess | OAuthBrokerError> {
  if (!isAllowedProvider(provider)) return brokerError('invalid_provider', { provider });

  const missing: string[] = [];
  if (!isNonEmptyString(payload.connection_id)) missing.push('connection_id');
  if (!isNonEmptyString(payload.redirect_uri)) missing.push('redirect_uri');
  if (missing.length > 0) {
    return brokerError('missing_required_fields', { provider, message: `missing_required_fields:${missing.join(',')}` });
  }
  const connectionIdRaw = payload.connection_id;
  const redirectUriRaw = payload.redirect_uri;
  if (!isNonEmptyString(connectionIdRaw) || !isNonEmptyString(redirectUriRaw)) {
    return brokerError('missing_required_fields', { provider, message: 'missing_required_fields:connection_id,redirect_uri' });
  }

  if (!isValidUri(redirectUriRaw)) {
    return brokerError('validation_error', { provider, message: 'redirect_uri must be a valid uri' });
  }

  const connectionId = connectionIdRaw.trim();
  const redirectUri = redirectUriRaw.trim();
  const store = oauthStore();
  const connection = store.connectionsById.get(connectionId);

  if (!connection || connection.provider !== provider) {
    return brokerError('connection_not_found', { provider, connection_id: connectionId });
  }

  try {
    const state = randomStateToken();
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const scopes = normalizeScopes(payload.scopes);

    connection.connection_status = 'reauthorization_required';
    connection.updated_at = new Date().toISOString();
    store.connectionsById.set(connectionId, connection);

    store.pendingByState.set(state, {
      state,
      provider: connection.provider,
      tenant_id: connection.tenant_id,
      redirect_uri: redirectUri,
      scopes,
      expires_at: expiresAt,
      connection_id: connectionId
    });

    const authUrl = new URL(`https://oauth.${provider}.example/authorize`);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', `${provider}_client`);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('state', state);
    if (scopes.length > 0) authUrl.searchParams.set('scope', scopes.join(' '));

    return {
      broker_status: 'ok',
      provider,
      connection_id: connectionId,
      connection_status: 'reauthorization_required',
      authorization_url: authUrl.toString(),
      state,
      expires_at: expiresAt
    };
  } catch {
    return brokerError('reconnect_failed', { provider, connection_id: connectionId });
  }
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
      : result.reason === 'invalid_provider' || result.reason === 'missing_required_fields' || result.reason === 'validation_error'
        ? 400
        : result.reason === 'connection_not_found'
          ? 404
          : 500;

  return new Response(JSON.stringify(result), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
