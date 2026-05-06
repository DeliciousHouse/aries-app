import { redditClientCredentials } from './oauth-provider-runtime';
import {
  ProviderRefreshError,
  type ProviderRefreshResult,
} from './refresh-meta';

type RedditRefreshResponse = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
};

export type RedditRefreshInput = {
  refreshToken: string | null;
};

function redditUserAgent(): string {
  return process.env.REDDIT_USER_AGENT?.trim() || 'AriesOAuthBroker/1.0';
}

export async function refreshReddit(input: RedditRefreshInput): Promise<ProviderRefreshResult> {
  const creds = redditClientCredentials();
  if (!creds) {
    throw new ProviderRefreshError('configuration_error', 'reddit_oauth_not_configured');
  }
  if (!input.refreshToken) {
    throw new ProviderRefreshError('unauthorized', 'reddit_refresh_token_missing');
  }

  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('refresh_token', input.refreshToken);

  const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
  let response: Response;
  try {
    response = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': redditUserAgent(),
      },
      body: body.toString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProviderRefreshError('transient_provider_error', `reddit_network_error:${message}`);
  }

  let parsed: RedditRefreshResponse | null = null;
  try {
    parsed = (await response.json()) as RedditRefreshResponse;
  } catch {
    parsed = null;
  }

  if (response.status === 401 || response.status === 403 || parsed?.error === 'invalid_grant') {
    throw new ProviderRefreshError(
      'unauthorized',
      parsed?.error_description || parsed?.error || 'reddit_token_invalid_or_revoked',
      { httpStatus: response.status, providerCode: parsed?.error ?? null },
    );
  }
  if (response.status >= 500) {
    throw new ProviderRefreshError(
      'transient_provider_error',
      parsed?.error_description || `reddit_status_${response.status}`,
      { httpStatus: response.status },
    );
  }
  if (!response.ok || !parsed?.access_token) {
    throw new ProviderRefreshError(
      'provider_error',
      parsed?.error_description || parsed?.error || `reddit_status_${response.status}`,
      { httpStatus: response.status },
    );
  }

  return {
    accessToken: parsed.access_token,
    expiresInSeconds:
      typeof parsed.expires_in === 'number' && parsed.expires_in > 0 ? parsed.expires_in : undefined,
    refreshToken:
      typeof parsed.refresh_token === 'string' && parsed.refresh_token.length > 0
        ? parsed.refresh_token
        : undefined,
    scope: typeof parsed.scope === 'string' ? parsed.scope : undefined,
    tokenType: typeof parsed.token_type === 'string' ? parsed.token_type : undefined,
  };
}
