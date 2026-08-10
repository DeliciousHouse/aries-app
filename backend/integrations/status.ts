import { isAllowedProvider } from './connect';
import { resolveTokenHealth } from './connection-schema';
import { getConnectionRow } from './composio/connection-store';
import { dbGetConnection } from './oauth-db';
import { getProviderOAuthAvailability } from './oauth-provider-runtime';
import { isComposioEnabled } from './providers/integration-config';
import { isIntegrationPlatform } from './providers/types';

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
  external_account_id?: string;
  external_account_name?: string;
  granted_scopes?: string[];
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

/**
 * connected_accounts-derived status for Composio-brokered platforms.
 *
 * When an account-connection provider is active, connected_accounts is the
 * single source of truth for every IntegrationPlatform — it holds the live
 * connected_account_id used to publish and read insights (#808 + reader
 * consolidation). This flips the API status surfaces (app/api/integrations,
 * app/api/platform-connections) to agree with the publisher/insights/settings
 * code, which already read connected_accounts. The legacy oauth_connections
 * read in oauthStatusAsync remains the fall-through ONLY when no
 * account-connection provider is configured (byte-identical legacy behavior).
 *
 * Returns null when this path does not apply, so the caller continues to the
 * legacy logic:
 *  - provider is not an IntegrationPlatform (slack/openai keep the legacy
 *    broker), or
 *  - Composio is disabled (COMPOSIO_ENABLED falsy).
 *
 * The active-provider check is `isComposioEnabled(process.env)` rather than
 * `getAccountConnectionProvider(process.env) !== null` on purpose: the two are
 * the same boolean (provider-factory returns null iff !isComposioEnabled), but
 * getAccountConnectionProvider constructs the Composio gateway, which THROWS
 * ComposioConfigError when COMPOSIO_ENABLED is truthy while COMPOSIO_API_KEY is
 * unset. Extending that throw across all six integration platforms would 500
 * the whole /api/integrations page (buildIntegrationsPageDataAsync has no
 * per-card catch). connected_accounts is a plain DB table needing no API key,
 * so in that misconfig state consulting it is strictly better than throwing.
 */
async function accountProviderStatus(
  provider: string,
  tenantId: string,
): Promise<PlatformConnectionStatusShape | null> {
  if (!isIntegrationPlatform(provider)) return null;
  if (!isComposioEnabled(process.env)) return null;

  const now = new Date().toISOString();
  const row = await getConnectionRow(tenantId, provider);
  if (row?.status === 'connected') {
    return {
      schema_name: 'platform_connection_status_schema',
      schema_version: '1.0.0',
      tenant_id: tenantId,
      integration_id: undefined,
      platform: provider,
      connection_status: 'connected',
      status_reason: 'env_managed',
      health: 'unknown',
      updated_at: now,
      capabilities: [],
      metadata: {},
      external_account_id: row.externalAccountId ?? undefined,
      external_account_name: row.externalAccountName ?? undefined,
    };
  }
  return {
    schema_name: 'platform_connection_status_schema',
    schema_version: '1.0.0',
    tenant_id: tenantId,
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
  if (!availability.available) {
    return buildMisconfiguredStatus(provider, tenantId.trim(), now, availability.message, availability.missingEnv);
  }
  if (!availability.connectable) {
    return {
      schema_name: 'platform_connection_status_schema',
      schema_version: '1.0.0',
      tenant_id: tenantId.trim(),
      integration_id: undefined,
      platform: provider,
      connection_status: 'connected',
      status_reason: 'env_managed',
      health: 'unknown',
      updated_at: now,
      capabilities: [],
      metadata: {},
    };
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

  // Reader consolidation: connected_accounts is authoritative for every
  // Composio-brokered platform whenever an account-connection provider is
  // active. This must run BEFORE the availability checks below, because
  // platforms whose legacy OAuth env is absent (x, reddit) would otherwise
  // return 'misconfigured' at the `!availability.available` gate and mask
  // their live Composio connections. Returns null (falls through to the legacy
  // path) when Composio is disabled or provider is not an IntegrationPlatform.
  const consolidated = await accountProviderStatus(provider, normalizedTenantId);
  if (consolidated !== null) return consolidated;

  const availability = getProviderOAuthAvailability(provider);
  if (!availability.available) {
    return buildMisconfiguredStatus(provider, normalizedTenantId, new Date().toISOString(), availability.message, availability.missingEnv);
  }
  if (!availability.connectable) {
    // Env-managed providers (Instagram, via META_PAGE_ID/META_ACCESS_TOKEN)
    // have no per-tenant OAuth record in oauth_connections by design. The
    // Composio-active consult that used to live here has moved to
    // `accountProviderStatus`, invoked at the top of this function BEFORE the
    // availability checks (Instagram is an IntegrationPlatform, so when Composio
    // is active that guard already returned this tenant's connected_accounts
    // status). Reaching here therefore means Composio is disabled — there is no
    // per-tenant record to check at all, so the legacy unconditional "connected"
    // behavior is preserved byte-identically (#808).
    //
    // NOTE: the deprecated sync `oauthStatus` twin below intentionally keeps its
    // legacy unconditional env-managed behavior even when Composio is enabled —
    // a known limitation, not fixed here (out of scope; no remaining callers rely
    // on it for env-managed correctness).
    const now = new Date().toISOString();

    return {
      schema_name: 'platform_connection_status_schema',
      schema_version: '1.0.0',
      tenant_id: normalizedTenantId,
      integration_id: undefined,
      platform: provider,
      connection_status: 'connected',
      status_reason: 'env_managed',
      health: 'unknown',
      updated_at: now,
      capabilities: [],
      metadata: {},
    };
  }

  const row = await dbGetConnection({ tenantId: normalizedTenantId, provider });
  const connection = row
    ? {
        connection_id: row.id,
        connection_status: row.status,
        token_expires_at: row.token_expires_at ?? undefined,
        refresh_token_expires_at: row.refresh_expires_at ?? undefined,
        updated_at: row.updated_at,
        external_account_id: row.external_account_id ?? undefined,
        external_account_name: row.external_account_name ?? undefined,
        granted_scopes: row.granted_scopes,
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
    external_account_id: connection?.external_account_id,
    external_account_name: connection?.external_account_name,
    granted_scopes: connection?.granted_scopes,
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
