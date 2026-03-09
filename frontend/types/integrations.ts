export const integration_platform_values = [
  'facebook',
  'instagram',
  'linkedin',
  'x',
  'youtube',
  'reddit',
  'tiktok'
] as const;
export type integration_platform = (typeof integration_platform_values)[number];

export const integrations_page_state_values = ['idle', 'loading', 'ready', 'refreshing', 'error'] as const;
export type integrations_page_state = (typeof integrations_page_state_values)[number];

export const platform_filter_values = ['all', 'connected', 'not_connected', 'attention_required'] as const;
export type platform_filter = (typeof platform_filter_values)[number];

export const integrations_sort_values = [
  'display_name_asc',
  'display_name_desc',
  'connection_state',
  'health'
] as const;
export type integrations_sort = (typeof integrations_sort_values)[number];

export const integration_connection_state_values = [
  'not_connected',
  'connection_pending',
  'connected',
  'connection_error',
  'reauth_required',
  'disabled'
] as const;
export type integration_connection_state = (typeof integration_connection_state_values)[number];

export const integration_health_values = ['unknown', 'healthy', 'degraded', 'error'] as const;
export type integration_health = (typeof integration_health_values)[number];

export const integration_card_action_values = [
  'connect',
  'reconnect',
  'disconnect',
  'sync_now',
  'view_permissions'
] as const;
export type integration_card_action = (typeof integration_card_action_values)[number];

export const integration_error_code_values = [
  'invalid_platform',
  'provider_unavailable',
  'auth_denied',
  'token_expired',
  'rate_limited',
  'validation_failed',
  'unknown'
] as const;
export type integration_error_code = (typeof integration_error_code_values)[number];

export const oauth_broker_status_values = ['ok', 'error'] as const;
export type oauth_broker_status = (typeof oauth_broker_status_values)[number];

export const oauth_connection_status_values = [
  'connected',
  'disconnected',
  'pending',
  'reauthorization_required'
] as const;
export type oauth_connection_status = (typeof oauth_connection_status_values)[number];

export const oauth_error_reason_values = [
  'missing_required_fields',
  'invalid_provider',
  'invalid_state',
  'authorization_denied',
  'provider_callback_error',
  'connection_not_found',
  'already_connected',
  'disconnect_failed',
  'reconnect_failed',
  'validation_error',
  'internal_error'
] as const;
export type oauth_error_reason = (typeof oauth_error_reason_values)[number];
