import { disconnectProviderConnection } from '../provider-state';

type MetaProvider = 'facebook' | 'instagram';

type DisconnectRequest = {
  tenant_id?: string;
  provider?: MetaProvider;
};

type DisconnectSuccess = {
  status: 'ok';
  tenant_id: string;
  provider: MetaProvider;
  disconnected: true;
};

type DisconnectError = {
  status: 'error';
  reason: 'missing_required_fields' | 'invalid_provider' | 'connection_not_found';
};

function isProvider(v: unknown): v is MetaProvider {
  return v === 'facebook' || v === 'instagram';
}

export function disconnectMeta(payload: DisconnectRequest): DisconnectSuccess | DisconnectError {
  if (!payload.tenant_id || !payload.provider) return { status: 'error', reason: 'missing_required_fields' };
  if (!isProvider(payload.provider)) return { status: 'error', reason: 'invalid_provider' };

  const changed = disconnectProviderConnection(payload.tenant_id, payload.provider);
  if (!changed) return { status: 'error', reason: 'connection_not_found' };

  return { status: 'ok', tenant_id: payload.tenant_id, provider: payload.provider, disconnected: true };
}

export async function handleMetaDisconnectHttp(req: Request): Promise<Response> {
  let payload: DisconnectRequest = {};
  try { payload = (await req.json()) as DisconnectRequest; } catch {}
  const out = disconnectMeta(payload);
  const status = out.status === 'ok' ? 200 : out.reason === 'connection_not_found' ? 404 : 400;
  return new Response(JSON.stringify(out), { status, headers: { 'content-type': 'application/json' } });
}
