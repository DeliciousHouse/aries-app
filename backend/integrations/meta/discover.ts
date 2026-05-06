import { metaFacebookClientCredentials } from '../oauth-provider-runtime';

export type MetaDiscoveryErrorKind =
  | 'configuration_error'
  | 'unauthorized'
  | 'transient_provider_error'
  | 'provider_error';

export class MetaDiscoveryError extends Error {
  readonly kind: MetaDiscoveryErrorKind;
  readonly httpStatus: number | null;

  constructor(kind: MetaDiscoveryErrorKind, message: string, httpStatus: number | null = null) {
    super(message);
    this.name = 'MetaDiscoveryError';
    this.kind = kind;
    this.httpStatus = httpStatus;
  }
}

function metaGraphVersion(): string {
  const raw = (process.env.META_GRAPH_API_VERSION || 'v21.0').trim();
  return raw.startsWith('v') ? raw : `v${raw}`;
}

type MetaTokenResponse = {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: { message?: string };
};

export type MetaShortToLongResult = {
  longLivedAccessToken: string;
  expiresInSeconds?: number;
  tokenType?: string;
};

/**
 * Exchange a short-lived user access token for a long-lived (~60-day) one.
 * Required immediately after the OAuth code exchange, before any Page-token derivation.
 */
export async function exchangeMetaShortForLongLived(shortToken: string): Promise<MetaShortToLongResult> {
  const creds = metaFacebookClientCredentials();
  if (!creds) {
    throw new MetaDiscoveryError('configuration_error', 'meta_oauth_not_configured');
  }
  if (!shortToken || shortToken.trim().length === 0) {
    throw new MetaDiscoveryError('configuration_error', 'meta_short_token_missing');
  }

  const url = new URL(`https://graph.facebook.com/${metaGraphVersion()}/oauth/access_token`);
  url.searchParams.set('grant_type', 'fb_exchange_token');
  url.searchParams.set('client_id', creds.clientId);
  url.searchParams.set('client_secret', creds.clientSecret);
  url.searchParams.set('fb_exchange_token', shortToken);

  let response: Response;
  try {
    response = await fetch(url, { method: 'GET' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new MetaDiscoveryError('transient_provider_error', `meta_network_error:${message}`);
  }

  let parsed: MetaTokenResponse | null = null;
  try {
    parsed = (await response.json()) as MetaTokenResponse;
  } catch {
    parsed = null;
  }

  if (response.status === 401 || response.status === 403) {
    throw new MetaDiscoveryError(
      'unauthorized',
      parsed?.error?.message || 'meta_long_lived_exchange_unauthorized',
      response.status,
    );
  }
  if (response.status >= 500) {
    throw new MetaDiscoveryError(
      'transient_provider_error',
      parsed?.error?.message || `meta_long_lived_status_${response.status}`,
      response.status,
    );
  }
  if (!response.ok || !parsed?.access_token) {
    throw new MetaDiscoveryError(
      'provider_error',
      parsed?.error?.message || `meta_long_lived_status_${response.status}`,
      response.status,
    );
  }

  return {
    longLivedAccessToken: parsed.access_token,
    expiresInSeconds:
      typeof parsed.expires_in === 'number' && parsed.expires_in > 0 ? parsed.expires_in : undefined,
    tokenType: typeof parsed.token_type === 'string' ? parsed.token_type : 'bearer',
  };
}

export type DiscoveredPage = {
  id: string;
  name: string;
  pageAccessToken: string;
  instagramBusinessAccountId: string | null;
};

export type MetaPageDiscoveryResult =
  | { kind: 'no_pages' }
  | { kind: 'single_page'; page: DiscoveredPage }
  | { kind: 'multi_page'; pages: DiscoveredPage[] };

type AccountsResponse = {
  data?: Array<{ id?: string; name?: string; access_token?: string }>;
  error?: { message?: string };
};

type PageDetailResponse = {
  id?: string;
  name?: string;
  access_token?: string;
  instagram_business_account?: { id?: string };
  error?: { message?: string };
};

/**
 * Discover the Pages associated with the long-lived user token, then for each Page
 * fetch its Page Access Token and Instagram Business Account id.
 *
 * Returns one of three branches: no_pages, single_page, multi_page. Callers must
 * never persist the user token; only Page Access Tokens.
 */
export async function discoverMetaPages(longLivedAccessToken: string): Promise<MetaPageDiscoveryResult> {
  if (!longLivedAccessToken || longLivedAccessToken.trim().length === 0) {
    throw new MetaDiscoveryError('configuration_error', 'meta_long_lived_token_missing');
  }

  const accountsUrl = new URL(`https://graph.facebook.com/${metaGraphVersion()}/me/accounts`);
  accountsUrl.searchParams.set('access_token', longLivedAccessToken);

  let accountsResponse: Response;
  try {
    accountsResponse = await fetch(accountsUrl, { method: 'GET' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new MetaDiscoveryError('transient_provider_error', `meta_accounts_network_error:${message}`);
  }
  const accountsParsed = (await accountsResponse.json().catch(() => ({}))) as AccountsResponse;
  if (accountsResponse.status === 401 || accountsResponse.status === 403) {
    throw new MetaDiscoveryError(
      'unauthorized',
      accountsParsed.error?.message || 'meta_accounts_unauthorized',
      accountsResponse.status,
    );
  }
  if (!accountsResponse.ok) {
    throw new MetaDiscoveryError(
      'provider_error',
      accountsParsed.error?.message || `meta_accounts_status_${accountsResponse.status}`,
      accountsResponse.status,
    );
  }

  const baseList = Array.isArray(accountsParsed.data) ? accountsParsed.data : [];
  if (baseList.length === 0) {
    return { kind: 'no_pages' };
  }

  const enriched: DiscoveredPage[] = [];
  for (const candidate of baseList) {
    const pageId = typeof candidate?.id === 'string' ? candidate.id.trim() : '';
    const initialPageToken = typeof candidate?.access_token === 'string' ? candidate.access_token.trim() : '';
    if (!pageId || !initialPageToken) {
      continue;
    }

    const detailUrl = new URL(
      `https://graph.facebook.com/${metaGraphVersion()}/${encodeURIComponent(pageId)}`,
    );
    detailUrl.searchParams.set('fields', 'instagram_business_account,access_token,name');
    detailUrl.searchParams.set('access_token', initialPageToken);

    let detailResponse: Response;
    try {
      detailResponse = await fetch(detailUrl, { method: 'GET' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new MetaDiscoveryError(
        'transient_provider_error',
        `meta_page_detail_network_error:${message}`,
      );
    }
    const detailParsed = (await detailResponse.json().catch(() => ({}))) as PageDetailResponse;
    if (!detailResponse.ok) {
      throw new MetaDiscoveryError(
        detailResponse.status === 401 || detailResponse.status === 403 ? 'unauthorized' : 'provider_error',
        detailParsed.error?.message || `meta_page_detail_status_${detailResponse.status}`,
        detailResponse.status,
      );
    }

    const pageName =
      (typeof detailParsed.name === 'string' && detailParsed.name.trim()) ||
      (typeof candidate.name === 'string' && candidate.name.trim()) ||
      pageId;
    const pageAccessToken =
      (typeof detailParsed.access_token === 'string' && detailParsed.access_token.trim()) ||
      initialPageToken;
    const instagramBusinessAccountId =
      typeof detailParsed.instagram_business_account?.id === 'string' &&
      detailParsed.instagram_business_account.id.trim()
        ? detailParsed.instagram_business_account.id.trim()
        : null;

    enriched.push({
      id: pageId,
      name: pageName,
      pageAccessToken,
      instagramBusinessAccountId,
    });
  }

  if (enriched.length === 0) {
    return { kind: 'no_pages' };
  }
  if (enriched.length === 1) {
    return { kind: 'single_page', page: enriched[0] };
  }
  return { kind: 'multi_page', pages: enriched };
}

export type MetaCodeExchangeResult = {
  shortLivedAccessToken: string;
  expiresInSeconds?: number;
  tokenType?: string;
};

export async function exchangeMetaAuthorizationCode(input: {
  code: string;
  redirectUri: string;
}): Promise<MetaCodeExchangeResult> {
  const creds = metaFacebookClientCredentials();
  if (!creds) {
    throw new MetaDiscoveryError('configuration_error', 'meta_oauth_not_configured');
  }
  const url = new URL(`https://graph.facebook.com/${metaGraphVersion()}/oauth/access_token`);
  url.searchParams.set('client_id', creds.clientId);
  url.searchParams.set('client_secret', creds.clientSecret);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('code', input.code);

  let response: Response;
  try {
    response = await fetch(url, { method: 'GET' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new MetaDiscoveryError('transient_provider_error', `meta_code_exchange_network_error:${message}`);
  }
  const parsed = (await response.json().catch(() => ({}))) as MetaTokenResponse;
  if (response.status === 401 || response.status === 403) {
    throw new MetaDiscoveryError(
      'unauthorized',
      parsed?.error?.message || 'meta_code_exchange_unauthorized',
      response.status,
    );
  }
  if (!response.ok || !parsed?.access_token) {
    throw new MetaDiscoveryError(
      'provider_error',
      parsed?.error?.message || `meta_code_exchange_status_${response.status}`,
      response.status,
    );
  }
  return {
    shortLivedAccessToken: parsed.access_token,
    expiresInSeconds:
      typeof parsed.expires_in === 'number' && parsed.expires_in > 0 ? parsed.expires_in : undefined,
    tokenType: typeof parsed.token_type === 'string' ? parsed.token_type : 'bearer',
  };
}
