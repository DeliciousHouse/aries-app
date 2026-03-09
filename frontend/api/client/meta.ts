import type {
  MetaCallbackQuery,
  MetaCallbackResponse,
  MetaConnectBody,
  MetaConnectResponse,
  MetaDisconnectBody,
  MetaDisconnectResponse,
  MetaStatusQuery,
  MetaStatusResponse
} from '../contracts/meta';

export interface MetaClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

function mkUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

export function createMetaClient(options: MetaClientOptions = {}) {
  const baseUrl = options.baseUrl ?? '';
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async connect(body: MetaConnectBody): Promise<MetaConnectResponse> {
      const res = await fetchImpl(mkUrl(baseUrl, '/api/integrations/meta/connect'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      return res.json();
    },

    async callback(query: MetaCallbackQuery): Promise<MetaCallbackResponse> {
      const url = new URL(mkUrl(baseUrl, '/api/integrations/meta/callback'));
      url.searchParams.set('tenant_id', query.tenant_id);
      url.searchParams.set('provider', query.provider);
      url.searchParams.set('state', query.state);
      if (query.code) url.searchParams.set('code', query.code);
      if (query.error) url.searchParams.set('error', query.error);
      if (query.error_description) url.searchParams.set('error_description', query.error_description);
      const res = await fetchImpl(url.toString(), { method: 'GET' });
      return res.json();
    },

    async status(query: MetaStatusQuery): Promise<MetaStatusResponse> {
      const url = new URL(mkUrl(baseUrl, '/api/integrations/meta/status'));
      url.searchParams.set('tenant_id', query.tenant_id);
      const res = await fetchImpl(url.toString(), { method: 'GET' });
      return res.json();
    },

    async disconnect(body: MetaDisconnectBody): Promise<MetaDisconnectResponse> {
      const res = await fetchImpl(mkUrl(baseUrl, '/api/integrations/meta/disconnect'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      return res.json();
    }
  };
}
