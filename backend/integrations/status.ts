import { isAllowedProvider, oauthStore } from './connect';
import { resolveTokenHealth } from './connection-schema';

type PlatformConnectionStatus =
  | 'disconnected'
  | 'pending_oauth'
  | 'oauth_authorized'
  | 'credential_validating'
  | 'connected'
  | 'degraded'
  | 'token_expired'
  | 'revoked'
  | 'permission_denied'
  | 'misconfigured'
  | 'rate_limited'
  | 'error';

type PlatformHealth = 'unknown' | 'healthy' | 'degraded' | 'unhealthy';

type PlatformConnectionStatusShape = {
  schema_name: 'platform_connection_status_schema';
  schema_version: '1.0.0';
  tenant_id: string;
  integration_id?: string;
  platform: string;
  connection_status: PlatformConnectionStatus;
  status_reason?: string;
  health?: PlatformHealth;
  token_expires_at?: string;
  refresh_token_expires_at?: string;
  last_success_at?: string;
  last_error?: {
    code?: string;
    message: string;
    retryable?: boolean;
    at?: string;
  };
  capabilities?: string[];
  metadata?: Record<string, string | number | boolean | null>;
  updated_at: string;
};

type StatusError = {
  broker_status: 'error';
  reason: 'invalid_provider' | 'missing_required_fields' | 'connection_not_found';
  message?: string;
  provider?: string;
};

function providerTenantKey(tenantId: string, provider: string): string {
  return `${tenantId}::${provider}`;
}

function statusFromInternal(connection: {
  connection_status?: string;
  token_expires_at?: string;
} | undefined): PlatformConnectionStatus {
  const connectionStatus = connection?.connection_status;
  if (connectionStatus === 'pending' || connectionStatus === 'reauthorization_required') return 'pending_oauth';
  if (connectionStatus === 'connected') {
    return resolveTokenHealth(connection?.token_expires_at) === 'expired' ? 'token_expired' : 'connected';
  }
  return 'disconnected';
}

function healthFromInternal(connection: {
  connection_status?: string;
  token_expires_at?: string;
} | undefined): PlatformHealth {
  if (connection?.connection_status !== 'connected') return 'unknown';

  switch (resolveTokenHealth(connection.token_expires_at)) {
    case 'healthy':
      return 'healthy';
    case 'expiring_soon':
      return 'degraded';
    case 'expired':
      return 'unhealthy';
    default:
      return 'unknown';
  }
}

export function oauthStatus(provider: string, tenantId?: string): PlatformConnectionStatusShape | StatusError {
  if (!isAllowedProvider(provider)) {
    return { broker_status: 'error', reason: 'invalid_provider', provider };
  }
  if (!tenantId || tenantId.trim().length === 0) {
    return { broker_status: 'error', reason: 'missing_required_fields', provider, message: 'missing_required_fields:tenant_id' };
  }

  const normalizedTenantId = tenantId.trim();
  const store = oauthStore();
  const connectionId = store.connectedByTenantProvider.get(providerTenantKey(normalizedTenantId, provider));
  const connection = connectionId ? store.connectionsById.get(connectionId) : undefined;

  const now = new Date().toISOString();
  return {
    schema_name: 'platform_connection_status_schema',
    schema_version: '1.0.0',
    tenant_id: normalizedTenantId,
    integration_id: connection?.connection_id,
    platform: provider,
    connection_status: statusFromInternal(connection),
    status_reason: connection ? undefined : 'connection_not_found',
    health: healthFromInternal(connection),
    token_expires_at: connection?.token_expires_at,
    refresh_token_expires_at: connection?.refresh_token_expires_at,
    last_success_at: undefined,
    capabilities: [],
    metadata: {},
    updated_at: connection?.updated_at || now
  };
}

export async function handleOauthStatusHttp(req: Request, providerFromPath?: string): Promise<Response> {
  const url = new URL(req.url);
  const provider = (providerFromPath || url.searchParams.get('provider') || '').toLowerCase();
  const tenantId = url.searchParams.get('tenant_id') || undefined;

  const result = oauthStatus(provider, tenantId);
  const status = 'broker_status' in result ? 400 : 200;

  return new Response(JSON.stringify(result), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
