import { linkedInClientCredentials } from './oauth-provider-runtime';
import {
  ProviderRefreshError,
  type ProviderRefreshResult,
} from './refresh-meta';

type LinkedInRefreshResponse = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
};

export type LinkedInRefreshInput = {
  refreshToken: string | null;
};

export async function refreshLinkedIn(input: LinkedInRefreshInput): Promise<ProviderRefreshResult> {
  const creds = linkedInClientCredentials();
  if (!creds) {
    throw new ProviderRefreshError('configuration_error', 'linkedin_oauth_not_configured');
  }
  if (!input.refreshToken) {
    throw new ProviderRefreshError('unauthorized', 'linkedin_refresh_token_missing');
  }

  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('refresh_token', input.refreshToken);
  body.set('client_id', creds.clientId);
  body.set('client_secret', creds.clientSecret);

  let response: Response;
  try {
    response = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProviderRefreshError('transient_provider_error', `linkedin_network_error:${message}`);
  }

  let parsed: LinkedInRefreshResponse | null = null;
  try {
    parsed = (await response.json()) as LinkedInRefreshResponse;
  } catch {
    parsed = null;
  }

  if (response.status === 401 || response.status === 403 || parsed?.error === 'invalid_grant') {
    throw new ProviderRefreshError(
      'unauthorized',
      parsed?.error_description || parsed?.error || 'linkedin_token_invalid_or_revoked',
      { httpStatus: response.status, providerCode: parsed?.error ?? null },
    );
  }
  if (response.status >= 500) {
    throw new ProviderRefreshError(
      'transient_provider_error',
      parsed?.error_description || `linkedin_status_${response.status}`,
      { httpStatus: response.status },
    );
  }
  if (!response.ok || !parsed?.access_token) {
    throw new ProviderRefreshError(
      'provider_error',
      parsed?.error_description || parsed?.error || `linkedin_status_${response.status}`,
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
    refreshExpiresInSeconds:
      typeof parsed.refresh_token_expires_in === 'number' && parsed.refresh_token_expires_in > 0
        ? parsed.refresh_token_expires_in
        : undefined,
    scope: typeof parsed.scope === 'string' ? parsed.scope : undefined,
    tokenType: typeof parsed.token_type === 'string' ? parsed.token_type : undefined,
  };
}
