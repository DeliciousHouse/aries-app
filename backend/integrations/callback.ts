import {
  brokerError,
  isAllowedProvider,
  type OAuthBrokerError,
  type Provider
} from './connect';
import { dbAuditEvent, dbDeletePendingState, dbGetPendingState, dbUpsertConnection } from './oauth-db';
import { dbInsertOAuthToken } from './oauth-tokens-db';

type OAuthCallbackQuery = {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
  expires_in?: string;
  refresh_expires_in?: string;
};

type OAuthCallbackSuccess = {
  broker_status: 'ok';
  provider: string;
  connection_id: string;
  connection_status: 'connected';
  connected_at?: string;
  granted_scopes?: string[];
};

type XTokenResponse = {
  token_type?: string;
  expires_in?: number;
  access_token?: string;
  scope?: string;
  refresh_token?: string;
  error?: string;
  error_description?: string;
};

type XMeResponse = {
  data?: {
    id?: string;
    name?: string;
    username?: string;
  };
  errors?: Array<{ detail?: string }>;
};

type LinkedInTokenResponse = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function addSeconds(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
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

function resolveBaseUrl(req: Request): string {
  const configuredBaseUrl = process.env.APP_BASE_URL?.trim();
  if (configuredBaseUrl) {
    try {
      return new URL(configuredBaseUrl).origin;
    } catch {
      // ignore invalid configured URL and fall back to request origin
    }
  }

  return new URL(req.url).origin;
}

function shouldRedirectToUi(req: Request): boolean {
  const accept = req.headers.get('accept') || '';
  return accept.includes('text/html');
}

function xClientCredentials(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.X_CLIENT_ID?.trim() || '';
  const clientSecret = process.env.X_CLIENT_SECRET?.trim() || '';
  if (!clientId || !clientSecret) {
    return null;
  }
  return { clientId, clientSecret };
}

async function exchangeXCodeForToken(input: {
  code: string;
  redirectUri: string;
  codeVerifier?: string;
}): Promise<{ accessToken: string; expiresIn?: number }> {
  const creds = xClientCredentials();
  if (!creds) {
    throw new Error('x_oauth_not_configured');
  }
  if (!input.codeVerifier) {
    throw new Error('x_oauth_missing_code_verifier');
  }

  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('code', input.code);
  body.set('redirect_uri', input.redirectUri);
  body.set('code_verifier', input.codeVerifier);

  const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
  const response = await fetch('https://api.twitter.com/2/oauth2/token', {
    method: 'POST',
    headers: {
      authorization: `Basic ${basic}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  const parsed = (await response.json().catch(() => ({}))) as XTokenResponse;
  if (!response.ok || !parsed.access_token) {
    throw new Error(parsed.error_description || parsed.error || 'X OAuth token exchange failed.');
  }

  return {
    accessToken: parsed.access_token,
    expiresIn: typeof parsed.expires_in === 'number' && parsed.expires_in > 0 ? parsed.expires_in : undefined,
  };
}

async function fetchXProfile(accessToken: string): Promise<{ id?: string; label?: string }> {
  const url = new URL('https://api.twitter.com/2/users/me');
  url.searchParams.set('user.fields', 'name,username');
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${accessToken}`,
    },
  });
  if (!response.ok) {
    return {};
  }
  const parsed = (await response.json().catch(() => ({}))) as XMeResponse;
  const id = typeof parsed.data?.id === 'string' ? parsed.data.id : undefined;
  const name = typeof parsed.data?.name === 'string' ? parsed.data.name : undefined;
  const username = typeof parsed.data?.username === 'string' ? parsed.data.username : undefined;
  return {
    id,
    label: [name, username ? `@${username}` : ''].filter(Boolean).join(' ') || undefined,
  };
}

function linkedInClientCredentials(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.LINKEDIN_CLIENT_ID?.trim() || '';
  const clientSecret = process.env.LINKEDIN_CLIENT_SECRET?.trim() || '';
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

async function exchangeLinkedInCodeForToken(input: {
  code: string;
  redirectUri: string;
}): Promise<{
  accessToken: string;
  expiresIn?: number;
  refreshToken?: string;
  refreshExpiresIn?: number;
  scope?: string;
  tokenType?: string;
}> {
  const creds = linkedInClientCredentials();
  if (!creds) {
    throw new Error('linkedin_oauth_not_configured');
  }

  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('code', input.code);
  body.set('redirect_uri', input.redirectUri);
  body.set('client_id', creds.clientId);
  body.set('client_secret', creds.clientSecret);

  const response = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const parsed = (await response.json().catch(() => ({}))) as LinkedInTokenResponse;
  if (!response.ok || !parsed.access_token) {
    throw new Error(parsed.error_description || parsed.error || 'LinkedIn OAuth token exchange failed.');
  }
  return {
    accessToken: parsed.access_token,
    expiresIn: typeof parsed.expires_in === 'number' && parsed.expires_in > 0 ? parsed.expires_in : undefined,
    refreshToken: typeof parsed.refresh_token === 'string' && parsed.refresh_token.length > 0 ? parsed.refresh_token : undefined,
    refreshExpiresIn:
      typeof parsed.refresh_token_expires_in === 'number' && parsed.refresh_token_expires_in > 0
        ? parsed.refresh_token_expires_in
        : undefined,
    scope: typeof parsed.scope === 'string' ? parsed.scope : undefined,
    tokenType: typeof parsed.token_type === 'string' ? parsed.token_type : undefined,
  };
}

export async function oauthCallback(provider: string, query: OAuthCallbackQuery): Promise<OAuthCallbackSuccess | OAuthBrokerError> {
  if (!isAllowedProvider(provider)) return brokerError('invalid_provider', { provider });

  if (!query.state || query.state.trim().length < 8) {
    return brokerError('invalid_state', { provider, message: 'missing or invalid state' });
  }

  const state = query.state.trim();
  const pending = await dbGetPendingState(state);

  if (!pending || pending.provider !== provider) {
    return brokerError('invalid_state', { provider, message: 'state not found or provider mismatch' });
  }

  if (new Date(pending.expires_at).getTime() <= Date.now()) {
    await dbDeletePendingState(state);
    return brokerError('invalid_state', { provider, message: 'state expired' });
  }

  if (query.error && query.error.trim().length > 0) {
    await dbDeletePendingState(state);
    await dbAuditEvent({
      tenantId: pending.tenant_id,
      connectionId: pending.connection_id,
      provider,
      eventType: 'oauth.callback.error',
      eventStatus: 'error',
      detail: { error: query.error.trim(), error_description: query.error_description?.trim() || null },
    });
    return brokerError(resolveProviderErrorReason(query.error.trim()), {
      provider,
      message: query.error_description?.trim() || query.error.trim()
    });
  }

  if (!query.code || query.code.trim().length === 0) {
    return brokerError('missing_required_fields', { provider, message: 'missing_required_fields:code' });
  }

  const connectedAt = nowIso();
  const connectionId = pending.connection_id || null;
  let accessTtlSeconds = parsePositiveInt(query.expires_in);
  const refreshTtlSeconds = parsePositiveInt(query.refresh_expires_in);

  // Real X OAuth code exchange when credentials are configured.
  if (provider === 'x' && xClientCredentials()) {
    try {
      const token = await exchangeXCodeForToken({
        code: query.code.trim(),
        redirectUri: pending.redirect_uri,
        codeVerifier: pending.code_verifier,
      });
      accessTtlSeconds = token.expiresIn;
      const profile = await fetchXProfile(token.accessToken);

      const externalAccountId =
        (profile && (profile.id ?? profile.data?.id)) ?? null;
      const externalAccountName =
        (profile && (profile.name ?? profile.data?.name ?? profile.username ?? profile.data?.username)) ?? null;

      await dbUpsertConnection({
        id: connectionId,
        provider,
        tenantId: pending.tenant_id,
        connectedAt,
        externalAccountId,
        externalAccountName,
      });

      const accessExpiresAt =
        typeof accessTtlSeconds === 'number'
          ? new Date(Date.now() + accessTtlSeconds * 1000).toISOString()
          : null;

      const refreshTtlFromToken =
        typeof (token as any).refreshExpiresIn === 'number'
          ? (token as any).refreshExpiresIn
          : refreshTtlSeconds;

      const refreshExpiresAt =
        typeof refreshTtlFromToken === 'number'
          ? new Date(Date.now() + refreshTtlFromToken * 1000).toISOString()
          : null;

      await dbInsertOAuthToken({
        connectionId,
        provider,
        accessToken: token.accessToken,
        refreshToken: (token as any).refreshToken ?? null,
        tokenType: (token as any).tokenType ?? null,
        scope: (token as any).scope ?? null,
        accessExpiresAt,
        refreshExpiresAt,
        createdAt: connectedAt,
      });
    } catch (error) {
      await dbDeletePendingState(state);
      return brokerError('provider_callback_error', {
        provider,
        message: error instanceof Error ? error.message : 'X OAuth token exchange failed.',
      });
    }
  }

  let linkedInToken:
    | {
        accessToken: string;
        expiresIn?: number;
        refreshToken?: string;
        refreshExpiresIn?: number;
        scope?: string;
        tokenType?: string;
      }
    | null = null;

  if (provider === 'linkedin') {
    try {
      linkedInToken = await exchangeLinkedInCodeForToken({ code: query.code.trim(), redirectUri: pending.redirect_uri });
      accessTtlSeconds = linkedInToken.expiresIn;
    } catch (error) {
      await dbDeletePendingState(state);
      await dbAuditEvent({
        tenantId: pending.tenant_id,
        connectionId: pending.connection_id,
        provider,
        eventType: 'oauth.callback.exchange_failed',
        eventStatus: 'error',
        detail: { message: error instanceof Error ? error.message : String(error) },
      });
      return brokerError('provider_callback_error', {
        provider,
        message: error instanceof Error ? error.message : 'LinkedIn OAuth token exchange failed.',
      });
    }
  }

  const tokenExpiresAt = typeof accessTtlSeconds === 'number' ? addSeconds(connectedAt, accessTtlSeconds) : null;
  const refreshExpiresAt =
    typeof (linkedInToken?.refreshExpiresIn ?? refreshTtlSeconds) === 'number'
      ? addSeconds(connectedAt, (linkedInToken?.refreshExpiresIn ?? refreshTtlSeconds) as number)
      : null;

  const connection = await dbUpsertConnection({
    tenantId: pending.tenant_id,
    provider,
    status: 'connected',
    grantedScopes: pending.scopes,
    tokenExpiresAt,
    refreshExpiresAt,
    connectedAt,
    disconnectedAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
  });

  if (provider === 'linkedin' && linkedInToken) {
    await dbInsertOAuthToken({
      connectionId: connection.id,
      accessToken: linkedInToken.accessToken,
      refreshToken: linkedInToken.refreshToken ?? null,
      tokenType: linkedInToken.tokenType ?? null,
      scope: linkedInToken.scope ?? null,
      expiresAt: tokenExpiresAt,
      refreshExpiresAt,
      issuedAt: connectedAt,
    });
  }

  await dbDeletePendingState(state);
  await dbAuditEvent({
    tenantId: pending.tenant_id,
    connectionId: connection.id,
    provider,
    eventType: 'oauth.callback.connected',
    eventStatus: 'ok',
    detail: { token_expires_at: tokenExpiresAt, refresh_expires_at: refreshExpiresAt },
  });

  return {
    broker_status: 'ok',
    provider,
    connection_id: connection.id,
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
    error_description: url.searchParams.get('error_description') || undefined,
    expires_in: url.searchParams.get('expires_in') || undefined,
    refresh_expires_in: url.searchParams.get('refresh_expires_in') || undefined
  };

  const result = await oauthCallback(provider, query);
  if (shouldRedirectToUi(req)) {
    const redirectUrl = new URL(`/oauth/connect/${encodeURIComponent(provider)}`, resolveBaseUrl(req));
    if (result.broker_status === 'ok') {
      redirectUrl.searchParams.set('result', 'connected');
      redirectUrl.searchParams.set('connection_id', result.connection_id);
      if (result.connected_at) redirectUrl.searchParams.set('connected_at', result.connected_at);
    } else {
      redirectUrl.searchParams.set('result', 'error');
      redirectUrl.searchParams.set('reason', result.reason);
      if (result.message) redirectUrl.searchParams.set('message', result.message);
    }

    return Response.redirect(redirectUrl.toString(), 302);
  }

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
