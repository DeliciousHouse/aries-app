import { xClientCredentials } from './oauth-provider-runtime';
import {
  ProviderRefreshError,
  type ProviderRefreshResult,
} from './refresh-meta';

type XRefreshResponse = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
};

export type XRefreshInput = {
  refreshToken: string | null;
};

export async function refreshX(input: XRefreshInput): Promise<ProviderRefreshResult> {
  const creds = xClientCredentials();
  if (!creds) {
    throw new ProviderRefreshError('configuration_error', 'x_oauth_not_configured');
  }
  if (!input.refreshToken) {
    throw new ProviderRefreshError('unauthorized', 'x_refresh_token_missing');
  }

  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('refresh_token', input.refreshToken);
  body.set('client_id', creds.clientId);

  const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
  let response: Response;
  try {
    response = await fetch('https://api.twitter.com/2/oauth2/token', {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProviderRefreshError('transient_provider_error', `x_network_error:${message}`);
  }

  let parsed: XRefreshResponse | null = null;
  try {
    parsed = (await response.json()) as XRefreshResponse;
  } catch {
    parsed = null;
  }

  if (response.status === 401 || response.status === 403 || parsed?.error === 'invalid_grant') {
    throw new ProviderRefreshError(
      'unauthorized',
      parsed?.error_description || parsed?.error || 'x_token_invalid_or_revoked',
      { httpStatus: response.status, providerCode: parsed?.error ?? null },
    );
  }
  if (response.status >= 500) {
    throw new ProviderRefreshError(
      'transient_provider_error',
      parsed?.error_description || `x_status_${response.status}`,
      { httpStatus: response.status },
    );
  }
  if (!response.ok || !parsed?.access_token) {
    throw new ProviderRefreshError(
      'provider_error',
      parsed?.error_description || parsed?.error || `x_status_${response.status}`,
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
