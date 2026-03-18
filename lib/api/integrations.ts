import { requestJson, type ApiClientOptions } from './http';

export type IntegrationPlatform =
  | 'facebook'
  | 'instagram'
  | 'linkedin'
  | 'x'
  | 'youtube'
  | 'reddit'
  | 'tiktok';

export type IntegrationsPageState = 'idle' | 'loading' | 'ready' | 'refreshing' | 'error';
export type PlatformFilter = 'all' | 'connected' | 'not_connected' | 'attention_required';
export type IntegrationsSort = 'display_name_asc' | 'display_name_desc' | 'connection_state' | 'health';
export type IntegrationConnectionState =
  | 'not_connected'
  | 'connection_pending'
  | 'connected'
  | 'connection_error'
  | 'reauth_required'
  | 'disabled';
export type IntegrationHealth = 'unknown' | 'healthy' | 'degraded' | 'error';
export type IntegrationCardAction =
  | 'connect'
  | 'reconnect'
  | 'disconnect'
  | 'sync_now'
  | 'view_permissions';
export type IntegrationErrorCode =
  | 'invalid_platform'
  | 'provider_unavailable'
  | 'auth_denied'
  | 'token_expired'
  | 'rate_limited'
  | 'validation_failed'
  | 'unknown';

export interface IntegrationPermission {
  permission: string;
  granted: boolean;
}

export interface IntegrationConnectedAccount {
  account_id: string;
  account_label: string;
  avatar_url?: string;
}

export interface IntegrationCardError {
  code: IntegrationErrorCode;
  message: string;
  retry_after_seconds?: number;
}

export interface IntegrationCard {
  platform: IntegrationPlatform;
  display_name: string;
  description: string;
  connection_id?: string;
  connection_state: IntegrationConnectionState;
  health: IntegrationHealth;
  available_actions: IntegrationCardAction[];
  last_synced_at: string | null;
  expires_at?: string | null;
  permissions: IntegrationPermission[];
  connected_account?: IntegrationConnectedAccount;
  error?: IntegrationCardError;
}

export interface GetIntegrationsPageQuery {
  filter?: PlatformFilter;
  sort?: IntegrationsSort;
  search?: string;
}

export interface GetIntegrationsPageSuccess {
  status: 'ok';
  page_state: Extract<IntegrationsPageState, 'ready' | 'refreshing'>;
  supported_platforms: IntegrationPlatform[];
  cards: IntegrationCard[];
  summary: {
    total: number;
    connected: number;
    not_connected: number;
    attention_required: number;
  };
}

export interface GetIntegrationsPageError {
  status: 'error';
  page_state: 'error';
  error: {
    code: Extract<IntegrationErrorCode, 'provider_unavailable' | 'rate_limited' | 'validation_failed' | 'auth_denied' | 'unknown'>;
    message: string;
  };
}

export type GetIntegrationsPageResponse = GetIntegrationsPageSuccess | GetIntegrationsPageError;

export interface OauthConnectRequest {
  tenant_id: string;
  redirect_uri: string;
  scopes?: string[];
  state_hint?: string;
}

export interface OauthConnectSuccess {
  broker_status: 'ok';
  provider: string;
  connection_status: 'pending';
  authorization_url: string;
  state: string;
  expires_at?: string;
}

export interface OauthDisconnectRequest {
  connection_id: string;
  revoke_provider_token?: boolean;
  reason?: string;
}

export interface OauthDisconnectSuccess {
  broker_status: 'ok';
  provider: string;
  connection_id: string;
  connection_status: 'disconnected';
  disconnected: true;
  disconnected_at?: string;
}

export interface OauthReconnectRequest {
  connection_id: string;
  redirect_uri: string;
  scopes?: string[];
}

export interface OauthReconnectSuccess {
  broker_status: 'ok';
  provider: string;
  connection_id: string;
  connection_status: 'reauthorization_required';
  authorization_url: string;
  state: string;
  expires_at?: string;
}

export interface OauthBrokerError {
  broker_status: 'error';
  reason: string;
  message?: string;
  provider?: string;
  connection_id?: string;
  retry_after_seconds?: number;
}

export type OauthResult<TData> = TData | OauthBrokerError;

export function createIntegrationsApi(options: ApiClientOptions = {}) {
  return {
    getPage(query?: GetIntegrationsPageQuery) {
      return requestJson<GetIntegrationsPageResponse>(
        '/api/integrations',
        {
          method: 'GET',
          query: query ? { ...query } : undefined,
        },
        options
      );
    },

    oauthConnect(provider: string, body: OauthConnectRequest) {
      return requestJson<OauthResult<OauthConnectSuccess>>(
        `/api/auth/oauth/${encodeURIComponent(provider)}/connect`,
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
        options
      );
    },

    oauthDisconnect(provider: string, body: OauthDisconnectRequest) {
      return requestJson<OauthResult<OauthDisconnectSuccess>>(
        `/api/auth/oauth/${encodeURIComponent(provider)}/disconnect`,
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
        options
      );
    },

    oauthReconnect(provider: string, body: OauthReconnectRequest) {
      return requestJson<OauthResult<OauthReconnectSuccess>>(
        `/api/auth/oauth/${encodeURIComponent(provider)}/reconnect`,
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
        options
      );
    },

    sync(platform: IntegrationPlatform) {
      return requestJson<{ status: string; [key: string]: unknown }>(
        '/api/integrations/sync',
        {
          method: 'POST',
          body: JSON.stringify({ platform }),
        },
        options
      );
    },
  };
}

export function isOauthErrorResult<TData>(
  value: OauthResult<TData>
): value is OauthBrokerError {
  return (value as OauthBrokerError).broker_status === 'error';
}
