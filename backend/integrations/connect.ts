import { createHash, randomBytes } from 'node:crypto';

type Provider = 'facebook' | 'instagram' | 'linkedin' | 'x' | 'youtube' | 'reddit' | 'tiktok';

type BrokerStatus = 'ok' | 'error';
type OAuthConnectionStatus = 'connected' | 'disconnected' | 'pending' | 'reauthorization_required';

type OAuthBrokerErrorReason =
  | 'missing_required_fields'
  | 'invalid_provider'
  | 'invalid_state'
  | 'authorization_denied'
  | 'provider_callback_error'
  | 'connection_not_found'
  | 'already_connected'
  | 'disconnect_failed'
  | 'reconnect_failed'
  | 'validation_error'
  | 'internal_error';

export type OAuthBrokerError = {
  broker_status: 'error';
  reason: OAuthBrokerErrorReason;
  message?: string;
  provider?: string;
  connection_id?: string;
  retry_after_seconds?: number;
};

type OAuthConnectRequest = {
  tenant_id?: string;
  redirect_uri?: string;
  scopes?: string[];
  state_hint?: string;
};

export type OAuthConnectSuccess = {
  broker_status: 'ok';
  provider: string;
  connection_status: 'pending';
  authorization_url: string;
  state: string;
  expires_at?: string;
};

type ConnectionRecord = {
  connection_id: string;
  provider: Provider;
  tenant_id: string;
  connection_status: OAuthConnectionStatus;
  granted_scopes: string[];
  created_at: string;
  updated_at: string;
  token_expires_at?: string;
  refresh_token_expires_at?: string;
  disconnected_at?: string;
  external_account_id?: string;
  external_account_name?: string;
};

type PendingAuthRecord = {
  state: string;
  provider: Provider;
  tenant_id: string;
  redirect_uri: string;
  scopes: string[];
  expires_at: string;
  connection_id?: string;
  code_verifier?: string;
};

type OauthBrokerStore = {
  pendingByState: Map<string, PendingAuthRecord>;
  connectionsById: Map<string, ConnectionRecord>;
  connectedByTenantProvider: Map<string, string>;
};

const PROVIDERS = ['facebook', 'instagram', 'linkedin', 'x', 'youtube', 'reddit', 'tiktok'] as const;

function nowIso(): string {
  return new Date().toISOString();
}

function randomToken(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
  }
  return `${prefix}_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeScopes(scopes: unknown): string[] {
  if (!Array.isArray(scopes)) return [];
  const clean = scopes.filter(isNonEmptyString).map((s) => s.trim());
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

export function isAllowedProvider(provider: string): provider is Provider {
  return (PROVIDERS as readonly string[]).includes(provider);
}

export function oauthStore(): OauthBrokerStore {
  const key = '__aries_oauth_broker_store_v2_2__';
  const g = globalThis as Record<string, unknown>;
  if (!g[key]) {
    g[key] = {
      pendingByState: new Map<string, PendingAuthRecord>(),
      connectionsById: new Map<string, ConnectionRecord>(),
      connectedByTenantProvider: new Map<string, string>()
    } satisfies OauthBrokerStore;
  }
  return g[key] as OauthBrokerStore;
}

export function brokerError(reason: OAuthBrokerErrorReason, extras?: Omit<OAuthBrokerError, 'broker_status' | 'reason'>): OAuthBrokerError {
  return { broker_status: 'error', reason, ...(extras || {}) };
}

function providerTenantKey(tenantId: string, provider: Provider): string {
  return `${tenantId}::${provider}`;
}

function xClientId(): string {
  return process.env.X_CLIENT_ID?.trim() || '';
}

function base64Url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function createCodeVerifier(): string {
  return base64Url(randomBytes(32));
}

function createCodeChallenge(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier).digest());
}

export async function oauthConnect(provider: string, payload: OAuthConnectRequest): Promise<OAuthConnectSuccess | OAuthBrokerError> {
  if (!isAllowedProvider(provider)) {
    return brokerError('invalid_provider', { provider });
  }

  const missing: string[] = [];
  if (!isNonEmptyString(payload.tenant_id)) missing.push('tenant_id');
  if (!isNonEmptyString(payload.redirect_uri)) missing.push('redirect_uri');
  if (missing.length > 0) {
    return brokerError('missing_required_fields', {
      provider,
      message: `missing_required_fields:${missing.join(',')}`
    });
  }

  const tenantIdRaw = payload.tenant_id;
  const redirectUriRaw = payload.redirect_uri;
  if (!isNonEmptyString(tenantIdRaw) || !isNonEmptyString(redirectUriRaw)) {
    return brokerError('missing_required_fields', {
      provider,
      message: 'missing_required_fields:tenant_id,redirect_uri'
    });
  }

  if (!isValidUri(redirectUriRaw)) {
    return brokerError('validation_error', { provider, message: 'redirect_uri must be a valid uri' });
  }

  const tenantId = tenantIdRaw.trim();
  const store = oauthStore();
  const existingConnectionId = store.connectedByTenantProvider.get(providerTenantKey(tenantId, provider));
  if (existingConnectionId) {
    const existing = store.connectionsById.get(existingConnectionId);
    if (existing && existing.connection_status === 'connected') {
      return brokerError('already_connected', {
        provider,
        connection_id: existing.connection_id,
        message: 'provider is already connected for tenant'
      });
    }
  }

  const state = randomToken(payload.state_hint ? payload.state_hint.replace(/[^a-z0-9_-]/gi, '').slice(0, 16) || 'state' : 'state');
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const scopes = normalizeScopes(payload.scopes);
  const redirectUri = redirectUriRaw.trim();
  const codeVerifier = provider === 'x' && xClientId() ? createCodeVerifier() : undefined;

  store.pendingByState.set(state, {
    state,
    provider,
    tenant_id: tenantId,
    redirect_uri: redirectUri,
    scopes,
    expires_at: expiresAt,
    code_verifier: codeVerifier,
  });

  const authUrl =
    provider === 'x' && xClientId()
      ? (() => {
          const url = new URL('https://twitter.com/i/oauth2/authorize');
          url.searchParams.set('response_type', 'code');
          url.searchParams.set('client_id', xClientId());
          url.searchParams.set('redirect_uri', redirectUri);
          url.searchParams.set('state', state);
          if (scopes.length > 0) {
            url.searchParams.set('scope', scopes.join(' '));
          }
          if (codeVerifier) {
            url.searchParams.set('code_challenge', createCodeChallenge(codeVerifier));
            url.searchParams.set('code_challenge_method', 'S256');
          }
          return url;
        })()
      : new URL(`https://oauth.${provider}.example/authorize`);

  if (!(provider === 'x' && xClientId())) {
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', `${provider}_client`);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('state', state);
    if (scopes.length > 0) authUrl.searchParams.set('scope', scopes.join(' '));
  }

  return {
    broker_status: 'ok',
    provider,
    connection_status: 'pending',
    authorization_url: authUrl.toString(),
    state,
    expires_at: expiresAt
  };
}

export async function handleOauthConnectHttp(req: Request, providerFromPath?: string): Promise<Response> {
  let payload: OAuthConnectRequest = {};
  try {
    payload = (await req.json()) as OAuthConnectRequest;
  } catch {
    payload = {};
  }

  const url = new URL(req.url);
  const provider = (providerFromPath || url.searchParams.get('provider') || '').toLowerCase();
  const result = await oauthConnect(provider, payload);

  const status =
    result.broker_status === 'ok'
      ? 200
      : result.reason === 'missing_required_fields' || result.reason === 'invalid_provider' || result.reason === 'validation_error'
        ? 400
        : result.reason === 'already_connected'
          ? 409
          : 500;

  return new Response(JSON.stringify(result), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

export type { Provider, BrokerStatus, OAuthConnectionStatus, ConnectionRecord, PendingAuthRecord };
