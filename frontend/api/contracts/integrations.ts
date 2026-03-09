import type {
  integration_platform,
  integrations_page_state,
  platform_filter,
  integrations_sort,
  integration_connection_state,
  integration_health,
  integration_card_action,
  integration_error_code,
  oauth_connection_status,
  oauth_error_reason
} from '../../types/integrations';

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
  code: integration_error_code;
  message: string;
  retry_after_seconds?: number;
}

export interface IntegrationCard {
  platform: integration_platform;
  display_name: string;
  description: string;
  connection_state: integration_connection_state;
  health: integration_health;
  available_actions: integration_card_action[];
  last_synced_at: string | null;
  permissions: IntegrationPermission[];
  connected_account?: IntegrationConnectedAccount;
  error?: IntegrationCardError;
}

export interface GetIntegrationsPageQuery {
  filter?: platform_filter;
  sort?: integrations_sort;
  search?: string;
}

export interface GetIntegrationsPageSuccess {
  status: 'ok';
  page_state: Extract<integrations_page_state, 'ready' | 'refreshing'>;
  supported_platforms: integration_platform[];
  cards: IntegrationCard[];
  summary: {
    total: 7;
    connected: number;
    not_connected: number;
    attention_required: number;
  };
}

export interface GetIntegrationsPageError {
  status: 'error';
  page_state: 'error';
  error: {
    code: Extract<integration_error_code, 'provider_unavailable' | 'rate_limited' | 'validation_failed' | 'unknown'>;
    message: string;
  };
}

export type GetIntegrationsPageResponse = GetIntegrationsPageSuccess | GetIntegrationsPageError;

export interface OauthProviderPathParams {
  provider: string;
}

export interface OauthConnectRequest {
  tenant_id: string;
  redirect_uri: string;
  scopes?: string[];
  state_hint?: string;
}

export interface OauthConnectSuccess {
  broker_status: 'ok';
  provider: string;
  connection_status: Extract<oauth_connection_status, 'pending'>;
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
  connection_status: Extract<oauth_connection_status, 'disconnected'>;
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
  connection_status: Extract<oauth_connection_status, 'reauthorization_required'>;
  authorization_url: string;
  state: string;
  expires_at?: string;
}

export interface OauthCallbackQueryParams {
  code?: string;
  state: string;
  error?: string;
  error_description?: string;
}

export interface OauthCallbackSuccess {
  broker_status: 'ok';
  provider: string;
  connection_id: string;
  connection_status: Extract<oauth_connection_status, 'connected'>;
  connected_at?: string;
  granted_scopes?: string[];
}

export interface OauthBrokerError {
  broker_status: 'error';
  reason: oauth_error_reason;
  message?: string;
  provider?: string;
  connection_id?: string;
  retry_after_seconds?: number;
}
