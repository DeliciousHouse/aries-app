import { isAllowedProvider } from './connect';
import { resolveTokenHealth } from './connection-schema';
import { dbGetConnection } from './oauth-db';
import { getProviderOAuthAvailability } from './oauth-provider-runtime';

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

function buildMisconfiguredStatus(
  provider: string,
  tenantId: string,
  updatedAt: string,
  message: string,
  missingEnv: string[]
): PlatformConnectionStatusShape {
  return {
    schema_name: 'platform_connection_status_schema',
    schema_version: '1.0.0',
    tenant_id: tenantId,
    integration_id: undefined,
    platform: provider,
    connection_status: 'misconfigured',
    status_reason: 'provider_unavailable',
    health: 'unhealthy',
    last_error: {
      code: 'provider_unavailable',
      message,
      retryable: false,
      at: updatedAt,
    },
    capabilities: [],
    metadata: {
      missing_env: missingEnv.join(','),
    },
    updated_at: updatedAt,
  };
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
  // Deprecated sync wrapper (kept for older callers).
  // Prefer `oauthStatusAsync` for real data.
  const now = new Date().toISOString();
  if (!isAllowedProvider(provider)) {
    return { broker_status: 'error', reason: 'invalid_provider', provider };
  }
  if (!tenantId || tenantId.trim().length === 0) {
    return { broker_status: 'error', reason: 'missing_required_fields', provider, message: 'missing_required_fields:tenant_id' };
  }
  const availability = getProviderOAuthAvailability(provider);
  if (!availability.available || !availability.connectable) {
    return buildMisconfiguredStatus(provider, tenantId.trim(), now, availability.message, availability.missingEnv);
  }
  return {
    schema_name: 'platform_connection_status_schema',
    schema_version: '1.0.0',
    tenant_id: tenantId.trim(),
    integration_id: undefined,
    platform: provider,
    connection_status: 'disconnected',
    status_reason: 'connection_not_found',
    health: 'unknown',
    updated_at: now,
    capabilities: [],
    metadata: {},
  };
}

export async function oauthStatusAsync(provider: string, tenantId?: string): Promise<PlatformConnectionStatusShape | StatusError> {
  if (!isAllowedProvider(provider)) {
    return { broker_status: 'error', reason: 'invalid_provider', provider };
  }
  if (!tenantId || tenantId.trim().length === 0) {
    return { broker_status: 'error', reason: 'missing_required_fields', provider, message: 'missing_required_fields:tenant_id' };
  }

  const normalizedTenantId = tenantId.trim();
  const availability = getProviderOAuthAvailability(provider);
  if (!availability.available || !availability.connectable) {
    return buildMisconfiguredStatus(provider, normalizedTenantId, new Date().toISOString(), availability.message, availability.missingEnv);
  }

  const row = await dbGetConnection({ tenantId: normalizedTenantId, provider });
  const connection = row
    ? {
        connection_id: row.id,
        connection_status: row.status,
        token_expires_at: row.token_expires_at ?? undefined,
        refresh_token_expires_at: row.refresh_expires_at ?? undefined,
        updated_at: row.updated_at,
      }
    : undefined;

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
    updated_at: connection?.updated_at || now,
  };
}

export async function handleOauthStatusHttp(req: Request, providerFromPath?: string): Promise<Response> {
  const url = new URL(req.url);
  const provider = (providerFromPath || url.searchParams.get('provider') || '').toLowerCase();
  const tenantId = url.searchParams.get('tenant_id') || undefined;

  const result = await oauthStatusAsync(provider, tenantId);
  const status = 'broker_status' in result ? 400 : 200;

  return new Response(JSON.stringify(result), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
