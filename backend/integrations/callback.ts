import {
  brokerError,
  isAllowedProvider,
  type OAuthBrokerError
} from './connect';
import {
  dbAuditEvent,
  dbDeletePendingState,
  dbGetPendingState,
  dbSetPendingStatePicker,
  dbUpsertConnection,
  type DbPendingStateRow,
} from './oauth-db';
import {
  googleClientCredentials,
  getProviderOAuthAvailability,
  linkedInClientCredentials,
  metaFacebookClientCredentials,
  openAiClientCredentials,
  redditClientCredentials,
  slackClientCredentials,
  tikTokClientCredentials,
  xClientCredentials,
} from './oauth-provider-runtime';
import { dbInsertOAuthToken } from './oauth-tokens-db';
import {
  discoverMetaPages,
  exchangeMetaAuthorizationCode,
  exchangeMetaShortForLongLived,
  MetaDiscoveryError,
  type DiscoveredPage,
} from './meta/discover';

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

export type OAuthCallbackPickerRequired = {
  broker_status: 'picker_required';
  provider: 'facebook';
  state: string;
  picker_url: string;
  pages: Array<{
    id: string;
    name: string;
    has_instagram: boolean;
  }>;
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

type LinkedInUserInfoResponse = {
  sub?: string;
  name?: string;
  localizedFirstName?: string;
  localizedLastName?: string;
  error?: string;
  error_description?: string;
};

type MetaTokenResponse = {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: {
    message?: string;
  };
};

type MetaMeResponse = {
  id?: string;
  name?: string;
  error?: {
    message?: string;
  };
};

type RedditTokenResponse = {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  refresh_token?: string;
  error?: string;
  error_description?: string;
};

type RedditMeResponse = {
  id?: string;
  name?: string;
};

type TikTokTokenEnvelope = {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_expires_in?: number;
  scope?: string;
  open_id?: string;
  error?: string;
  error_description?: string;
  message?: string;
  data?: {
    access_token?: string;
    token_type?: string;
    expires_in?: number;
    refresh_token?: string;
    refresh_expires_in?: number;
    scope?: string;
    open_id?: string;
  };
};

type GoogleTokenResponse = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
};

type OpenAiTokenResponse = {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
};

type SlackOAuthV2Response = {
  ok?: boolean;
  access_token?: string;
  token_type?: string;
  scope?: string;
  bot_user_id?: string;
  app_id?: string;
  team?: {
    id?: string;
    name?: string;
  };
  authed_user?: {
    id?: string;
  };
  error?: string;
};

type YouTubeChannelsResponse = {
  items?: Array<{
    id?: string;
    snippet?: {
      title?: string;
    };
  }>;
  error?: {
    message?: string;
  };
};

type ExchangedOAuthToken = {
  accessToken: string;
  expiresIn?: number;
  refreshToken?: string;
  refreshExpiresIn?: number;
  scope?: string;
  tokenType?: string;
  externalAccountId?: string | null;
  externalAccountName?: string | null;
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

function metaGraphVersion(): string {
  const raw = (process.env.META_GRAPH_API_VERSION || 'v21.0').trim();
  return raw.startsWith('v') ? raw : `v${raw}`;
}

function redditUserAgent(): string {
  return process.env.REDDIT_USER_AGENT?.trim() || 'AriesOAuthBroker/1.0';
}

async function parseJson<T>(response: Response): Promise<T> {
  return (await response.json().catch(() => ({}))) as T;
}

function joinedName(parts: Array<string | undefined>): string | undefined {
  const value = parts.map((part) => part?.trim() || '').filter(Boolean).join(' ');
  return value || undefined;
}

function responseErrorMessage(
  parsed: Record<string, unknown> | undefined,
  fallback: string
): string {
  if (!parsed) {
    return fallback;
  }

  if (typeof parsed.error_description === 'string' && parsed.error_description.trim()) {
    return parsed.error_description;
  }
  if (typeof parsed.error === 'string' && parsed.error.trim()) {
    return parsed.error;
  }
  if (typeof parsed.message === 'string' && parsed.message.trim()) {
    return parsed.message;
  }

  const nestedError = parsed.error;
  if (nestedError && typeof nestedError === 'object') {
    const message = (nestedError as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) {
      return message;
    }
  }

  return fallback;
}

async function exchangeXCodeForToken(input: {
  code: string;
  redirectUri: string;
  codeVerifier?: string;
}): Promise<{
  accessToken: string;
  expiresIn?: number;
  refreshToken?: string;
  scope?: string;
  tokenType?: string;
}> {
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
    refreshToken: typeof parsed.refresh_token === 'string' ? parsed.refresh_token : undefined,
    scope: typeof parsed.scope === 'string' ? parsed.scope : undefined,
    tokenType: typeof parsed.token_type === 'string' ? parsed.token_type : undefined,
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

async function exchangeLinkedInCodeForToken(input: {
  code: string;
  redirectUri: string;
}): Promise<ExchangedOAuthToken> {
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
  const parsed = await parseJson<LinkedInTokenResponse>(response);
  if (!response.ok || !parsed.access_token) {
    throw new Error(responseErrorMessage(parsed as Record<string, unknown>, 'LinkedIn OAuth token exchange failed.'));
  }

  let externalAccountId: string | null = null;
  let externalAccountName: string | null = null;
  const scope = typeof parsed.scope === 'string' ? parsed.scope : undefined;
  if (scope?.includes('openid')) {
    const profileResponse = await fetch('https://api.linkedin.com/v2/userinfo', {
      method: 'GET',
      headers: {
        authorization: `Bearer ${parsed.access_token}`,
      },
    });
    if (profileResponse.ok) {
      const profile = await parseJson<LinkedInUserInfoResponse>(profileResponse);
      externalAccountId = typeof profile.sub === 'string' && profile.sub.trim() ? profile.sub : null;
      externalAccountName =
        joinedName([profile.name, profile.localizedFirstName, profile.localizedLastName]) || externalAccountName;
    }
  }

  return {
    accessToken: parsed.access_token,
    expiresIn: typeof parsed.expires_in === 'number' && parsed.expires_in > 0 ? parsed.expires_in : undefined,
    refreshToken: typeof parsed.refresh_token === 'string' && parsed.refresh_token.length > 0 ? parsed.refresh_token : undefined,
    refreshExpiresIn:
      typeof parsed.refresh_token_expires_in === 'number' && parsed.refresh_token_expires_in > 0
        ? parsed.refresh_token_expires_in
        : undefined,
    scope,
    tokenType: typeof parsed.token_type === 'string' ? parsed.token_type : undefined,
    externalAccountId,
    externalAccountName,
  };
}

async function exchangeFacebookCodeForToken(input: {
  code: string;
  redirectUri: string;
}): Promise<ExchangedOAuthToken> {
  const creds = metaFacebookClientCredentials();
  if (!creds) {
    throw new Error('meta_oauth_not_configured');
  }

  const url = new URL(`https://graph.facebook.com/${metaGraphVersion()}/oauth/access_token`);
  url.searchParams.set('client_id', creds.clientId);
  url.searchParams.set('client_secret', creds.clientSecret);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('code', input.code);

  const response = await fetch(url, { method: 'GET' });
  const parsed = await parseJson<MetaTokenResponse>(response);
  if (!response.ok || !parsed.access_token) {
    throw new Error(responseErrorMessage(parsed as Record<string, unknown>, 'Facebook OAuth token exchange failed.'));
  }

  let externalAccountId: string | null = null;
  let externalAccountName: string | null = null;
  const profileResponse = await fetch(
    new URL(`https://graph.facebook.com/${metaGraphVersion()}/me?fields=id,name&access_token=${encodeURIComponent(parsed.access_token)}`),
    { method: 'GET' },
  );
  if (profileResponse.ok) {
    const profile = await parseJson<MetaMeResponse>(profileResponse);
    externalAccountId = typeof profile.id === 'string' && profile.id.trim() ? profile.id : null;
    externalAccountName = typeof profile.name === 'string' && profile.name.trim() ? profile.name : null;
  }

  return {
    accessToken: parsed.access_token,
    expiresIn: typeof parsed.expires_in === 'number' && parsed.expires_in > 0 ? parsed.expires_in : undefined,
    tokenType: typeof parsed.token_type === 'string' ? parsed.token_type : undefined,
    externalAccountId,
    externalAccountName,
  };
}

async function exchangeRedditCodeForToken(input: {
  code: string;
  redirectUri: string;
}): Promise<ExchangedOAuthToken> {
  const creds = redditClientCredentials();
  if (!creds) {
    throw new Error('reddit_oauth_not_configured');
  }

  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('code', input.code);
  body.set('redirect_uri', input.redirectUri);

  const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
  const response = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      authorization: `Basic ${basic}`,
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': redditUserAgent(),
    },
    body: body.toString(),
  });
  const parsed = await parseJson<RedditTokenResponse>(response);
  if (!response.ok || !parsed.access_token) {
    throw new Error(responseErrorMessage(parsed as Record<string, unknown>, 'Reddit OAuth token exchange failed.'));
  }

  let externalAccountId: string | null = null;
  let externalAccountName: string | null = null;
  const profileResponse = await fetch('https://oauth.reddit.com/api/v1/me', {
    method: 'GET',
    headers: {
      authorization: `Bearer ${parsed.access_token}`,
      'user-agent': redditUserAgent(),
    },
  });
  if (profileResponse.ok) {
    const profile = await parseJson<RedditMeResponse>(profileResponse);
    externalAccountId = typeof profile.id === 'string' && profile.id.trim() ? profile.id : null;
    externalAccountName = typeof profile.name === 'string' && profile.name.trim() ? profile.name : null;
  }

  return {
    accessToken: parsed.access_token,
    expiresIn: typeof parsed.expires_in === 'number' && parsed.expires_in > 0 ? parsed.expires_in : undefined,
    refreshToken: typeof parsed.refresh_token === 'string' && parsed.refresh_token.length > 0 ? parsed.refresh_token : undefined,
    scope: typeof parsed.scope === 'string' ? parsed.scope : undefined,
    tokenType: typeof parsed.token_type === 'string' ? parsed.token_type : undefined,
    externalAccountId,
    externalAccountName,
  };
}

async function exchangeTikTokCodeForToken(input: {
  code: string;
  redirectUri: string;
}): Promise<ExchangedOAuthToken> {
  const creds = tikTokClientCredentials();
  if (!creds) {
    throw new Error('tiktok_oauth_not_configured');
  }

  const body = new URLSearchParams();
  body.set('client_key', creds.clientId);
  body.set('client_secret', creds.clientSecret);
  body.set('code', input.code);
  body.set('grant_type', 'authorization_code');
  body.set('redirect_uri', input.redirectUri);

  const response = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  const parsed = await parseJson<TikTokTokenEnvelope>(response);
  const token = parsed.data ?? parsed;
  if (!response.ok || !token.access_token) {
    throw new Error(responseErrorMessage(parsed as Record<string, unknown>, 'TikTok OAuth token exchange failed.'));
  }

  return {
    accessToken: token.access_token,
    expiresIn: typeof token.expires_in === 'number' && token.expires_in > 0 ? token.expires_in : undefined,
    refreshToken: typeof token.refresh_token === 'string' && token.refresh_token.length > 0 ? token.refresh_token : undefined,
    refreshExpiresIn:
      typeof token.refresh_expires_in === 'number' && token.refresh_expires_in > 0 ? token.refresh_expires_in : undefined,
    scope: typeof token.scope === 'string' ? token.scope : undefined,
    tokenType: typeof token.token_type === 'string' ? token.token_type : undefined,
    externalAccountId: typeof token.open_id === 'string' && token.open_id.trim() ? token.open_id : null,
  };
}

async function exchangeGoogleCodeForToken(input: {
  code: string;
  redirectUri: string;
}): Promise<ExchangedOAuthToken> {
  const creds = googleClientCredentials();
  if (!creds) {
    throw new Error('google_oauth_not_configured');
  }

  const body = new URLSearchParams();
  body.set('client_id', creds.clientId);
  body.set('client_secret', creds.clientSecret);
  body.set('code', input.code);
  body.set('grant_type', 'authorization_code');
  body.set('redirect_uri', input.redirectUri);

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const parsed = await parseJson<GoogleTokenResponse>(response);
  if (!response.ok || !parsed.access_token) {
    throw new Error(responseErrorMessage(parsed as Record<string, unknown>, 'Google OAuth token exchange failed.'));
  }

  let externalAccountId: string | null = null;
  let externalAccountName: string | null = null;
  const channelsUrl = new URL('https://www.googleapis.com/youtube/v3/channels');
  channelsUrl.searchParams.set('part', 'id,snippet');
  channelsUrl.searchParams.set('mine', 'true');
  const profileResponse = await fetch(channelsUrl, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${parsed.access_token}`,
    },
  });
  if (profileResponse.ok) {
    const profile = await parseJson<YouTubeChannelsResponse>(profileResponse);
    const firstChannel = profile.items?.[0];
    externalAccountId = typeof firstChannel?.id === 'string' && firstChannel.id.trim() ? firstChannel.id : null;
    externalAccountName =
      typeof firstChannel?.snippet?.title === 'string' && firstChannel.snippet.title.trim()
        ? firstChannel.snippet.title
        : null;
  }

  return {
    accessToken: parsed.access_token,
    expiresIn: typeof parsed.expires_in === 'number' && parsed.expires_in > 0 ? parsed.expires_in : undefined,
    refreshToken: typeof parsed.refresh_token === 'string' && parsed.refresh_token.length > 0 ? parsed.refresh_token : undefined,
    scope: typeof parsed.scope === 'string' ? parsed.scope : undefined,
    tokenType: typeof parsed.token_type === 'string' ? parsed.token_type : undefined,
    externalAccountId,
    externalAccountName,
  };
}

async function exchangeOpenAiCodeForToken(input: {
  code: string;
  redirectUri: string;
}): Promise<ExchangedOAuthToken> {
  const creds = openAiClientCredentials();
  if (!creds) {
    throw new Error('openai_oauth_not_configured');
  }

  const body = new URLSearchParams();
  body.set('client_id', creds.clientId);
  body.set('client_secret', creds.clientSecret);
  body.set('code', input.code);
  body.set('grant_type', 'authorization_code');
  body.set('redirect_uri', input.redirectUri);

  const response = await fetch('https://auth.openai.com/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const parsed = await parseJson<OpenAiTokenResponse>(response);
  if (!response.ok || !parsed.access_token) {
    throw new Error(responseErrorMessage(parsed as Record<string, unknown>, 'OpenAI OAuth token exchange failed.'));
  }

  return {
    accessToken: parsed.access_token,
    expiresIn: typeof parsed.expires_in === 'number' && parsed.expires_in > 0 ? parsed.expires_in : undefined,
    refreshToken: typeof parsed.refresh_token === 'string' && parsed.refresh_token.length > 0 ? parsed.refresh_token : undefined,
    scope: typeof parsed.scope === 'string' ? parsed.scope : undefined,
    tokenType: typeof parsed.token_type === 'string' ? parsed.token_type : undefined,
  };
}

async function exchangeSlackCodeForToken(input: {
  code: string;
  redirectUri: string;
}): Promise<ExchangedOAuthToken> {
  const creds = slackClientCredentials();
  if (!creds) {
    throw new Error('slack_oauth_not_configured');
  }

  const body = new URLSearchParams();
  body.set('client_id', creds.clientId);
  body.set('client_secret', creds.clientSecret);
  body.set('code', input.code);
  body.set('redirect_uri', input.redirectUri);

  const response = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const parsed = await parseJson<SlackOAuthV2Response>(response);
  // Slack returns HTTP 200 with `{ ok: false, error }` on failure, so the `ok`
  // flag — not just response.ok — is the source of truth for the exchange.
  if (!response.ok || parsed.ok !== true || !parsed.access_token) {
    throw new Error(responseErrorMessage(parsed as Record<string, unknown>, 'Slack OAuth token exchange failed.'));
  }

  const teamId = typeof parsed.team?.id === 'string' && parsed.team.id.trim() ? parsed.team.id : null;
  const teamName = typeof parsed.team?.name === 'string' && parsed.team.name.trim() ? parsed.team.name : null;

  return {
    // The bot token (`xoxb-`) is the top-level access_token in OAuth v2; it does
    // not expire and has no refresh token, so expiresIn / refreshToken stay unset.
    accessToken: parsed.access_token,
    scope: typeof parsed.scope === 'string' ? parsed.scope : undefined,
    tokenType: typeof parsed.token_type === 'string' ? parsed.token_type : undefined,
    externalAccountId: teamId,
    externalAccountName: teamName,
  };
}

function pickerRedirectUrl(state: string): string {
  const base = process.env.APP_BASE_URL?.trim();
  const path = `/onboarding/connect/meta/select-page?state=${encodeURIComponent(state)}`;
  if (!base) return path;
  try {
    return new URL(path, base).toString();
  } catch {
    return path;
  }
}

async function persistMetaPageConnections(args: {
  pending: DbPendingStateRow;
  page: DiscoveredPage;
  state: string;
  flow: 'auto_single_page' | 'meta_page_picker';
}): Promise<OAuthCallbackSuccess> {
  const connectedAt = nowIso();
  const facebookConnection = await dbUpsertConnection({
    tenantId: args.pending.tenant_id,
    provider: 'facebook',
    status: 'connected',
    grantedScopes: args.pending.scopes,
    externalAccountId: args.page.id,
    externalAccountName: args.page.name,
    connectedAt,
    disconnectedAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
  });
  await dbInsertOAuthToken({
    connectionId: facebookConnection.id,
    accessToken: args.page.pageAccessToken,
    tokenType: 'page',
    issuedAt: connectedAt,
  });

  let instagramConnectionId: string | null = null;
  if (args.page.instagramBusinessAccountId) {
    const instagramConnection = await dbUpsertConnection({
      tenantId: args.pending.tenant_id,
      provider: 'instagram',
      status: 'connected',
      grantedScopes: args.pending.scopes,
      externalAccountId: args.page.instagramBusinessAccountId,
      externalAccountName: args.page.name,
      connectedAt,
      disconnectedAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    });
    await dbInsertOAuthToken({
      connectionId: instagramConnection.id,
      accessToken: args.page.pageAccessToken,
      tokenType: 'page',
      issuedAt: connectedAt,
    });
    instagramConnectionId = instagramConnection.id;
  }

  await dbDeletePendingState(args.state);
  await dbAuditEvent({
    tenantId: args.pending.tenant_id,
    connectionId: facebookConnection.id,
    provider: 'facebook',
    eventType: 'oauth.callback.connected',
    eventStatus: 'ok',
    detail: {
      selected_page_id: args.page.id,
      instagram_connection_id: instagramConnectionId,
      flow: args.flow,
    },
  });

  return {
    broker_status: 'ok',
    provider: 'facebook',
    connection_id: facebookConnection.id,
    connection_status: 'connected',
    connected_at: connectedAt,
    granted_scopes: args.pending.scopes,
  };
}

async function runFacebookCallbackFlow(
  state: string,
  code: string,
  pending: DbPendingStateRow,
): Promise<OAuthCallbackSuccess | OAuthCallbackPickerRequired | OAuthBrokerError> {
  let shortLivedAccessToken: string;
  try {
    const exchange = await exchangeMetaAuthorizationCode({ code, redirectUri: pending.redirect_uri });
    shortLivedAccessToken = exchange.shortLivedAccessToken;
  } catch (error) {
    return handleMetaCallbackException(state, pending, error);
  }

  let longLivedAccessToken: string;
  try {
    const longLived = await exchangeMetaShortForLongLived(shortLivedAccessToken);
    longLivedAccessToken = longLived.longLivedAccessToken;
  } catch (error) {
    return handleMetaCallbackException(state, pending, error);
  }

  let discovery;
  try {
    discovery = await discoverMetaPages(longLivedAccessToken);
  } catch (error) {
    return handleMetaCallbackException(state, pending, error);
  }

  if (discovery.kind === 'no_pages') {
    await dbUpsertConnection({
      tenantId: pending.tenant_id,
      provider: 'facebook',
      status: 'error',
      grantedScopes: pending.scopes,
      lastErrorCode: 'meta_no_pages_available',
      lastErrorMessage:
        'The Meta account did not return any Pages. Connect a Facebook account that owns at least one Page with admin role.',
      disconnectedAt: null,
    });
    await dbDeletePendingState(state);
    await dbAuditEvent({
      tenantId: pending.tenant_id,
      connectionId: pending.connection_id,
      provider: 'facebook',
      eventType: 'oauth.callback.no_pages',
      eventStatus: 'error',
      detail: { reason: 'meta_no_pages_available' },
    });
    return brokerError('provider_callback_error', {
      provider: 'facebook',
      message: 'meta_no_pages_available: connect a Facebook account that owns at least one Page.',
    });
  }

  if (discovery.kind === 'single_page') {
    return persistMetaPageConnections({
      pending,
      page: discovery.page,
      state,
      flow: 'auto_single_page',
    });
  }

  const stashedPages = discovery.pages.map((page) => ({
    id: page.id,
    name: page.name,
    pageAccessToken: page.pageAccessToken,
    instagramBusinessAccountId: page.instagramBusinessAccountId,
  }));
  await dbSetPendingStatePicker(state, { pages: stashedPages });
  await dbAuditEvent({
    tenantId: pending.tenant_id,
    connectionId: pending.connection_id,
    provider: 'facebook',
    eventType: 'oauth.callback.picker_required',
    eventStatus: 'ok',
    detail: { page_count: stashedPages.length },
  });

  return {
    broker_status: 'picker_required',
    provider: 'facebook',
    state,
    picker_url: pickerRedirectUrl(state),
    pages: discovery.pages.map((page) => ({
      id: page.id,
      name: page.name,
      has_instagram: page.instagramBusinessAccountId != null,
    })),
  };
}

async function handleMetaCallbackException(
  state: string,
  pending: DbPendingStateRow,
  error: unknown,
): Promise<OAuthBrokerError> {
  const message = error instanceof Error ? error.message : String(error);
  const isProviderUnavailable =
    /_oauth_not_(configured|supported)$/.test(message) || message.includes('OAUTH_TOKEN_ENCRYPTION_KEY');
  const isUnauthorized =
    error instanceof MetaDiscoveryError && error.kind === 'unauthorized';
  const normalizedMessage =
    isProviderUnavailable
      ? getProviderOAuthAvailability('facebook').message || message
      : message;
  await dbDeletePendingState(state);
  await dbAuditEvent({
    tenantId: pending.tenant_id,
    connectionId: pending.connection_id,
    provider: 'facebook',
    eventType: 'oauth.callback.exchange_failed',
    eventStatus: 'error',
    detail: { message: normalizedMessage },
  });
  return brokerError(
    isProviderUnavailable
      ? 'provider_unavailable'
      : isUnauthorized
        ? 'authorization_denied'
        : 'provider_callback_error',
    { provider: 'facebook', message: normalizedMessage },
  );
}

export async function oauthCallback(
  provider: string,
  query: OAuthCallbackQuery,
): Promise<OAuthCallbackSuccess | OAuthCallbackPickerRequired | OAuthBrokerError> {
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

  if (provider === 'facebook') {
    return runFacebookCallbackFlow(state, query.code.trim(), pending);
  }

  const connectedAt = nowIso();
  let accessTtlSeconds = parsePositiveInt(query.expires_in);
  const refreshTtlSeconds = parsePositiveInt(query.refresh_expires_in);
  let exchangedToken: ExchangedOAuthToken | null = null;

  try {
    switch (provider) {
      case 'x': {
        const xToken = await exchangeXCodeForToken({
          code: query.code.trim(),
          redirectUri: pending.redirect_uri,
          codeVerifier: pending.code_verifier ?? undefined,
        });
        const profile = await fetchXProfile(xToken.accessToken);
        exchangedToken = {
          ...xToken,
          externalAccountId: profile.id ?? null,
          externalAccountName: profile.label ?? null,
        };
        break;
      }
      case 'linkedin':
        exchangedToken = await exchangeLinkedInCodeForToken({
          code: query.code.trim(),
          redirectUri: pending.redirect_uri,
        });
        break;
      case 'instagram':
        throw new Error('meta_oauth_not_supported');
      case 'reddit':
        exchangedToken = await exchangeRedditCodeForToken({
          code: query.code.trim(),
          redirectUri: pending.redirect_uri,
        });
        break;
      case 'tiktok':
        exchangedToken = await exchangeTikTokCodeForToken({
          code: query.code.trim(),
          redirectUri: pending.redirect_uri,
        });
        break;
      case 'youtube':
        exchangedToken = await exchangeGoogleCodeForToken({
          code: query.code.trim(),
          redirectUri: pending.redirect_uri,
        });
        break;
      case 'openai':
        exchangedToken = await exchangeOpenAiCodeForToken({
          code: query.code.trim(),
          redirectUri: pending.redirect_uri,
        });
        break;
      case 'slack':
        exchangedToken = await exchangeSlackCodeForToken({
          code: query.code.trim(),
          redirectUri: pending.redirect_uri,
        });
        break;
      default:
        exchangedToken = null;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const normalizedMessage =
      /_oauth_not_(configured|supported)$/.test(message) && isAllowedProvider(provider)
        ? getProviderOAuthAvailability(provider).message || message
        : message;
    const isProviderUnavailable =
      /_oauth_not_(configured|supported)$/.test(message) ||
      message.includes('OAUTH_TOKEN_ENCRYPTION_KEY');
    await dbDeletePendingState(state);
    await dbAuditEvent({
      tenantId: pending.tenant_id,
      connectionId: pending.connection_id,
      provider,
      eventType: 'oauth.callback.exchange_failed',
      eventStatus: 'error',
      detail: { message: normalizedMessage },
    });
    return brokerError(isProviderUnavailable ? 'provider_unavailable' : 'provider_callback_error', {
      provider,
      message: normalizedMessage,
    });
  }

  accessTtlSeconds = exchangedToken?.expiresIn ?? accessTtlSeconds;
  const externalAccountId = exchangedToken?.externalAccountId ?? null;
  const externalAccountName = exchangedToken?.externalAccountName ?? null;

  const tokenExpiresAt = typeof accessTtlSeconds === 'number' ? addSeconds(connectedAt, accessTtlSeconds) : null;
  const refreshExpiresAt =
    typeof (exchangedToken?.refreshExpiresIn ?? refreshTtlSeconds) === 'number'
      ? addSeconds(connectedAt, (exchangedToken?.refreshExpiresIn ?? refreshTtlSeconds) as number)
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
    externalAccountId,
    externalAccountName,
    lastErrorCode: null,
    lastErrorMessage: null,
  });

  if (exchangedToken) {
    await dbInsertOAuthToken({
      connectionId: connection.id,
      accessToken: exchangedToken.accessToken,
      refreshToken: exchangedToken.refreshToken ?? null,
      tokenType: exchangedToken.tokenType ?? null,
      scope: exchangedToken.scope ?? null,
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
    if (result.broker_status === 'picker_required') {
      const pickerUrl = new URL(
        `/onboarding/connect/meta/select-page?state=${encodeURIComponent(result.state)}`,
        resolveBaseUrl(req),
      );
      return Response.redirect(pickerUrl.toString(), 302);
    }
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
      : result.broker_status === 'picker_required'
        ? 200
      : result.reason === 'provider_unavailable'
        ? 503
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
