import { getProviderConnection, type Platform } from '../provider-state';

type MetaProvider = Extract<Platform, 'facebook' | 'instagram'>;

type StatusRecord = {
  provider: MetaProvider;
  connection_state: 'not_connected' | 'pending' | 'connected' | 'reauthorization_required' | 'error';
  connected_at?: string;
  disconnected_at?: string;
  account_label?: string;
};

type StatusSuccess = {
  status: 'ok';
  tenant_id: string;
  providers: StatusRecord[];
};

type StatusError = {
  status: 'error';
  reason: 'missing_required_fields';
};

const providers: MetaProvider[] = ['facebook', 'instagram'];

export function metaStatus(tenant_id?: string): StatusSuccess | StatusError {
  if (!tenant_id) return { status: 'error', reason: 'missing_required_fields' };

  const records: StatusRecord[] = providers.map((provider) => {
    const c = getProviderConnection(tenant_id, provider);
    if (!c || c.connection.connection_status === 'disconnected') return { provider, connection_state: 'not_connected' };
    if (c.connection.connection_status === 'connected') {
      return {
        provider,
        connection_state: 'connected',
        connected_at: c.history?.find(h => h.note === 'provider_connected')?.at || c.created_at,
        account_label: c.connection.metadata?.account_label as string | undefined
      };
    }
    return { provider, connection_state: 'error' };
  });

  return { status: 'ok', tenant_id, providers: records };
}

export async function handleMetaStatusHttp(req: Request): Promise<Response> {
  const tenant_id = new URL(req.url).searchParams.get('tenant_id') || undefined;
  const out = metaStatus(tenant_id);
  return new Response(JSON.stringify(out), { status: out.status === 'ok' ? 200 : 400, headers: { 'content-type': 'application/json' } });
}
