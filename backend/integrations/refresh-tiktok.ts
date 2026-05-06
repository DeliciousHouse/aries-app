import { tikTokClientCredentials } from './oauth-provider-runtime';
import {
  ProviderRefreshError,
  type ProviderRefreshResult,
} from './refresh-meta';

type TikTokRefreshEnvelope = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
  message?: string;
  data?: {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    refresh_expires_in?: number;
    scope?: string;
    token_type?: string;
  };
};

export type TikTokRefreshInput = {
  refreshToken: string | null;
};

export async function refreshTikTok(input: TikTokRefreshInput): Promise<ProviderRefreshResult> {
  const creds = tikTokClientCredentials();
  if (!creds) {
    throw new ProviderRefreshError('configuration_error', 'tiktok_oauth_not_configured');
  }
  if (!input.refreshToken) {
    throw new ProviderRefreshError('unauthorized', 'tiktok_refresh_token_missing');
  }

  const body = new URLSearchParams();
  body.set('client_key', creds.clientId);
  body.set('client_secret', creds.clientSecret);
  body.set('grant_type', 'refresh_token');
  body.set('refresh_token', input.refreshToken);

  let response: Response;
  try {
    response = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProviderRefreshError('transient_provider_error', `tiktok_network_error:${message}`);
  }

  let parsed: TikTokRefreshEnvelope | null = null;
  try {
    parsed = (await response.json()) as TikTokRefreshEnvelope;
  } catch {
    parsed = null;
  }
  const token = parsed?.data ?? parsed;

  if (response.status === 401 || response.status === 403 || parsed?.error === 'invalid_grant') {
    throw new ProviderRefreshError(
      'unauthorized',
      parsed?.error_description || parsed?.message || parsed?.error || 'tiktok_token_invalid_or_revoked',
      { httpStatus: response.status, providerCode: parsed?.error ?? null },
    );
  }
  if (response.status >= 500) {
    throw new ProviderRefreshError(
      'transient_provider_error',
      parsed?.error_description || parsed?.message || `tiktok_status_${response.status}`,
      { httpStatus: response.status },
    );
  }
  if (!response.ok || !token?.access_token) {
    throw new ProviderRefreshError(
      'provider_error',
      parsed?.error_description || parsed?.message || parsed?.error || `tiktok_status_${response.status}`,
      { httpStatus: response.status },
    );
  }

  return {
    accessToken: token.access_token,
    expiresInSeconds:
      typeof token.expires_in === 'number' && token.expires_in > 0 ? token.expires_in : undefined,
    refreshToken:
      typeof token.refresh_token === 'string' && token.refresh_token.length > 0
        ? token.refresh_token
        : undefined,
    refreshExpiresInSeconds:
      typeof token.refresh_expires_in === 'number' && token.refresh_expires_in > 0
        ? token.refresh_expires_in
        : undefined,
    scope: typeof token.scope === 'string' ? token.scope : undefined,
    tokenType: typeof token.token_type === 'string' ? token.token_type : undefined,
  };
}
