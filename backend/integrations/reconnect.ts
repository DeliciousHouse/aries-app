import { brokerError, isAllowedProvider, type OAuthBrokerError } from './connect';
import { buildProviderAuthorizationUrl } from './oauth-authorize-urls';
import { dbAuditEvent, dbGetConnectionById, dbInsertPendingState, dbUpsertConnection, type DbProvider } from './oauth-db';

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

  const connectionId = payload.connection_id.trim();
  const existingConnection = await dbGetConnectionById(connectionId);

  if (!existingConnection || existingConnection.provider !== provider) {
    return brokerError('connection_not_found', { provider, connection_id: connectionId });
  }

  const state = randomStateToken();
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const scopes = normalizeScopes(payload.scopes, existingConnection.granted_scopes);

  await dbInsertPendingState({
    state,
    provider,
    tenantId: existingConnection.tenant_id,
    redirectUri,
    scopes,
    connectionId,
    expiresAt,
  });

  await dbUpsertConnection({
    tenantId: existingConnection.tenant_id,
    provider,
    status: 'reauthorization_required',
    grantedScopes: scopes,
    disconnectedAt: null,
  });

  await dbAuditEvent({
    tenantId: existingConnection.tenant_id,
    connectionId,
    provider,
    eventType: 'oauth.reconnect.initiated',
    eventStatus: 'ok',
    detail: { redirect_uri: redirectUri, scopes },
  });

  const built = buildProviderAuthorizationUrl({
    provider: provider as DbProvider,
    redirectUri,
    state,
    scopes,
  });

  return {
    broker_status: 'ok',
    provider,
    connection_id: connectionId,
    connection_status: 'reauthorization_required',
    authorization_url: built.toString(),
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
  let result: Awaited<ReturnType<typeof oauthReconnect>>;
  try {
    result = await oauthReconnect(provider, payload);
  } catch (error) {
    result = brokerError('internal_error', {
      provider,
      message: error instanceof Error ? error.message : 'internal_error',
    });
  }

  const status =
    result.broker_status === 'ok'
      ? 200
      : result.reason === 'missing_required_fields' || result.reason === 'invalid_provider' || result.reason === 'validation_error'
        ? 400
        : result.reason === 'connection_not_found'
          ? 404
          : result.reason === 'internal_error'
            ? 500
            : 500;

  return new Response(JSON.stringify(result), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
