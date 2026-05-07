import { googleClientCredentials } from './oauth-provider-runtime';
import {
  ProviderRefreshError,
  type ProviderRefreshResult,
} from './refresh-meta';

type GoogleRefreshResponse = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
};

export type GoogleRefreshInput = {
  refreshToken: string | null;
};

export async function refreshGoogle(input: GoogleRefreshInput): Promise<ProviderRefreshResult> {
  const creds = googleClientCredentials();
  if (!creds) {
    throw new ProviderRefreshError('configuration_error', 'google_oauth_not_configured');
  }
  if (!input.refreshToken) {
    throw new ProviderRefreshError('unauthorized', 'google_refresh_token_missing');
  }

  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('refresh_token', input.refreshToken);
  body.set('client_id', creds.clientId);
  body.set('client_secret', creds.clientSecret);

  let response: Response;
  try {
    response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProviderRefreshError('transient_provider_error', `google_network_error:${message}`);
  }

  let parsed: GoogleRefreshResponse | null = null;
  try {
    parsed = (await response.json()) as GoogleRefreshResponse;
  } catch {
    parsed = null;
  }

  if (response.status === 401 || response.status === 403 || parsed?.error === 'invalid_grant') {
    throw new ProviderRefreshError(
      'unauthorized',
      parsed?.error_description || parsed?.error || 'google_token_invalid_or_revoked',
      { httpStatus: response.status, providerCode: parsed?.error ?? null },
    );
  }
  if (response.status >= 500) {
    throw new ProviderRefreshError(
      'transient_provider_error',
      parsed?.error_description || `google_status_${response.status}`,
      { httpStatus: response.status },
    );
  }
  if (!response.ok || !parsed?.access_token) {
    throw new ProviderRefreshError(
      'provider_error',
      parsed?.error_description || parsed?.error || `google_status_${response.status}`,
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
