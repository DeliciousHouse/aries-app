import type {
  GetIntegrationsPageQuery,
  GetIntegrationsPageResponse,
  OauthConnectRequest,
  OauthConnectSuccess,
  OauthDisconnectRequest,
  OauthDisconnectSuccess,
  OauthReconnectRequest,
  OauthReconnectSuccess,
  OauthCallbackQueryParams,
  OauthCallbackSuccess,
  OauthBrokerError
} from '../contracts/integrations';

export interface IntegrationsClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

type OauthResult<T> = T | OauthBrokerError;

function mkUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

function appendQuery(path: string, query?: Record<string, string | undefined>): string {
  if (!query) return path;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) qs.set(key, value);
  }
  const suffix = qs.toString();
  return suffix ? `${path}?${suffix}` : path;
}

export function createIntegrationsClient(options: IntegrationsClientOptions = {}) {
  const baseUrl = options.baseUrl ?? '';
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async getPage(query?: GetIntegrationsPageQuery): Promise<GetIntegrationsPageResponse> {
      const path = appendQuery('/api/integrations', {
        filter: query?.filter,
        sort: query?.sort,
        search: query?.search
      });
      const res = await fetchImpl(mkUrl(baseUrl, path), { method: 'GET' });
      return res.json();
    },

    async oauthConnect(provider: string, body: OauthConnectRequest): Promise<OauthResult<OauthConnectSuccess>> {
      const res = await fetchImpl(mkUrl(baseUrl, `/api/auth/oauth/${encodeURIComponent(provider)}/connect`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      return res.json();
    },

    async oauthDisconnect(
      provider: string,
      body: OauthDisconnectRequest
    ): Promise<OauthResult<OauthDisconnectSuccess>> {
      const res = await fetchImpl(mkUrl(baseUrl, `/api/auth/oauth/${encodeURIComponent(provider)}/disconnect`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      return res.json();
    },

    async oauthReconnect(provider: string, body: OauthReconnectRequest): Promise<OauthResult<OauthReconnectSuccess>> {
      const res = await fetchImpl(mkUrl(baseUrl, `/api/auth/oauth/${encodeURIComponent(provider)}/reconnect`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      return res.json();
    },

    async oauthCallback(
      provider: string,
      query: OauthCallbackQueryParams
    ): Promise<OauthResult<OauthCallbackSuccess>> {
      const path = appendQuery(`/api/auth/oauth/${encodeURIComponent(provider)}/callback`, {
        code: query.code,
        state: query.state,
        error: query.error,
        error_description: query.error_description
      });
      const res = await fetchImpl(mkUrl(baseUrl, path), { method: 'GET' });
      return res.json();
    }
  };
}
