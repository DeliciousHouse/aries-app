export const meta_provider_values = ['facebook', 'instagram'] as const;
export type meta_provider = (typeof meta_provider_values)[number];

export type meta_connection_state = 'not_connected' | 'pending' | 'connected' | 'reauthorization_required' | 'error';

export interface MetaConnectRequest {
  tenant_id: string;
  provider: meta_provider;
  redirect_uri: string;
}

export interface MetaConnectSuccess {
  status: 'ok';
  tenant_id: string;
  provider: meta_provider;
  connection_state: 'pending';
  authorization_url: string;
  state: string;
}

export interface MetaCallbackSuccess {
  status: 'ok';
  tenant_id: string;
  provider: meta_provider;
  connection_state: 'connected';
  connection_id: string;
}

export interface MetaStatusRecord {
  provider: meta_provider;
  connection_state: meta_connection_state;
  connected_at?: string;
  disconnected_at?: string;
  account_label?: string;
}

export interface MetaStatusSuccess {
  status: 'ok';
  tenant_id: string;
  providers: MetaStatusRecord[];
}

export interface MetaDisconnectSuccess {
  status: 'ok';
  tenant_id: string;
  provider: meta_provider;
  disconnected: true;
}

export interface MetaError {
  status: 'error';
  reason:
    | 'missing_required_fields'
    | 'invalid_provider'
    | 'invalid_state'
    | 'authorization_denied'
    | 'connection_not_found'
    | 'internal_error'
    | 'validation_error';
  message?: string;
}
