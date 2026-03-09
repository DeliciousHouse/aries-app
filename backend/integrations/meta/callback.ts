import { registerProviderConnection } from '../provider-state';
import { consumeMetaPendingState } from './connect';
import { registerCredentialReference } from '../credential-reference';
import { storeToken } from '../token-store';

type MetaProvider = 'facebook' | 'instagram';

type CallbackSuccess = {
  status: 'ok';
  tenant_id: string;
  provider: MetaProvider;
  connection_state: 'connected';
  connection_id: string;
};

type CallbackError = {
  status: 'error';
  reason:
    | 'missing_required_fields'
    | 'invalid_provider'
    | 'invalid_state'
    | 'authorization_denied'
    | 'internal_error';
  message?: string;
};

function isProvider(value: unknown): value is MetaProvider {
  return value === 'facebook' || value === 'instagram';
}

export function handleMetaCallback(query: URLSearchParams): CallbackSuccess | CallbackError {
  const tenant_id = query.get('tenant_id') || '';
  const provider = query.get('provider') || '';
  const state = query.get('state') || '';
  const code = query.get('code') || '';
  const error = query.get('error') || '';

  if (!tenant_id || !provider || !state) return { status: 'error', reason: 'missing_required_fields' };
  if (!isProvider(provider)) return { status: 'error', reason: 'invalid_provider' };

  const pending = consumeMetaPendingState(state);
  if (!pending || pending.tenant_id !== tenant_id || pending.provider !== provider) {
    return { status: 'error', reason: 'invalid_state' };
  }

  if (error) return { status: 'error', reason: 'authorization_denied', message: query.get('error_description') || error };
  if (!code) return { status: 'error', reason: 'missing_required_fields', message: 'code is required' };

  try {
    const credentialRef = registerCredentialReference({
      reference_id: `cr_${Math.random().toString(36).slice(2, 18)}`,
      reference_type: 'api_client_secret',
      provider: 'secret_manager',
      tenant_scope: 'tenant',
      lifecycle_state: 'active',
      version: 1
    }, tenant_id);

    // Server-side token handling only. Raw values never returned.
    storeToken({ token_class: 'refresh_token', subject_id: `meta:${provider}`, tenant_id, ttl_seconds: 60 * 60 * 24 * 30, credential_reference: credentialRef });

    const connection_id = `${provider}_${tenant_id}_${Date.now()}`;
    registerProviderConnection({ tenant_id, provider, connection_id, account_label: provider === 'facebook' ? 'Facebook Page' : 'Instagram Business' });

    return { status: 'ok', tenant_id, provider, connection_state: 'connected', connection_id };
  } catch (err) {
    return { status: 'error', reason: 'internal_error', message: (err as Error).message };
  }
}

export async function handleMetaCallbackHttp(req: Request): Promise<Response> {
  const query = new URL(req.url).searchParams;
  const out = handleMetaCallback(query);
  const status = out.status === 'ok' ? 200 : out.reason === 'missing_required_fields' || out.reason === 'invalid_provider' || out.reason === 'invalid_state' ? 400 : out.reason === 'authorization_denied' ? 401 : 500;
  return new Response(JSON.stringify(out), { status, headers: { 'content-type': 'application/json' } });
}
