import { metaFacebookClientCredentials } from './oauth-provider-runtime';

export type ProviderRefreshResult = {
  accessToken: string;
  expiresInSeconds?: number;
  refreshToken?: string;
  refreshExpiresInSeconds?: number;
  scope?: string;
  tokenType?: string;
};

export type ProviderRefreshErrorKind =
  | 'configuration_error'
  | 'unauthorized'
  | 'transient_provider_error'
  | 'provider_error';

export class ProviderRefreshError extends Error {
  readonly kind: ProviderRefreshErrorKind;
  readonly httpStatus: number | null;
  readonly providerCode: string | null;

  constructor(
    kind: ProviderRefreshErrorKind,
    message: string,
    options: { httpStatus?: number | null; providerCode?: string | null } = {},
  ) {
    super(message);
    this.name = 'ProviderRefreshError';
    this.kind = kind;
    this.httpStatus = options.httpStatus ?? null;
    this.providerCode = options.providerCode ?? null;
  }
}

type MetaTokenResponse = {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
};

export type MetaRefreshInput = {
  accessToken: string;
};

export async function refreshMetaLongLived(input: MetaRefreshInput): Promise<ProviderRefreshResult> {
  const creds = metaFacebookClientCredentials();
  if (!creds) {
    throw new ProviderRefreshError('configuration_error', 'meta_oauth_not_configured');
  }
  if (!input.accessToken || input.accessToken.trim().length === 0) {
    throw new ProviderRefreshError('configuration_error', 'meta_refresh_missing_access_token');
  }

  const url = new URL('https://graph.facebook.com/oauth/access_token');
  url.searchParams.set('grant_type', 'fb_exchange_token');
  url.searchParams.set('client_id', creds.clientId);
  url.searchParams.set('client_secret', creds.clientSecret);
  url.searchParams.set('fb_exchange_token', input.accessToken);

  let response: Response;
  try {
    response = await fetch(url, { method: 'GET' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProviderRefreshError('transient_provider_error', `meta_network_error:${message}`);
  }

  let parsed: MetaTokenResponse | null = null;
  try {
    parsed = (await response.json()) as MetaTokenResponse;
  } catch {
    parsed = null;
  }

  if (response.status === 401 || response.status === 403) {
    throw new ProviderRefreshError(
      'unauthorized',
      parsed?.error?.message || 'meta_token_expired_or_revoked',
      { httpStatus: response.status, providerCode: parsed?.error?.code != null ? String(parsed.error.code) : null },
    );
  }

  if (response.status >= 500) {
    throw new ProviderRefreshError(
      'transient_provider_error',
      parsed?.error?.message || `meta_status_${response.status}`,
      { httpStatus: response.status },
    );
  }

  if (!response.ok || !parsed?.access_token) {
    throw new ProviderRefreshError(
      'provider_error',
      parsed?.error?.message || `meta_status_${response.status}`,
      { httpStatus: response.status, providerCode: parsed?.error?.code != null ? String(parsed.error.code) : null },
    );
  }

  return {
    accessToken: parsed.access_token,
    expiresInSeconds:
      typeof parsed.expires_in === 'number' && parsed.expires_in > 0 ? parsed.expires_in : undefined,
    tokenType: typeof parsed.token_type === 'string' ? parsed.token_type : 'bearer',
  };
}
