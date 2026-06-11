import { resolveTokenHealth } from '../../../backend/integrations/connection-schema';
import { resolveOpenAiConnectionReference } from '@/backend/integrations/openai-connection';
import { oauthStore } from '@/backend/integrations/oauth-memory-store';
import { oauthStatusAsync } from '../../../backend/integrations/status';
import { PROVIDER_REGISTRY, type ProviderKey } from '@/backend/integrations/provider-registry';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';
type BrowserSafeConnectionStatus = {
  provider: 'openai';
  label: 'ChatGPT / OpenAI';
  connected: boolean;
  tokenHealth: 'unknown' | 'valid' | 'expired' | 'error';
  lastCheckedAt: string | null;
};
type PlatformConnectionStatus = {
  provider: Exclude<ProviderKey, 'openai' | 'slack'>;
  tenant_id: string;
  connection_id?: string;
  connection_status: string;
  token_health: 'healthy' | 'expiring_soon' | 'expired' | 'unknown';
  expires_at?: string;
  updated_at: string;
};
type PlatformConnectionsPayload = {
  status: 'ok';
  connections: Array<PlatformConnectionStatus | BrowserSafeConnectionStatus>;
};

// slack is a notification target (connected via its own settings card), not a
// publishing platform, so it never appears in the platform-connections status.
const PLATFORM_CONNECTION_PROVIDERS = (Object.keys(PROVIDER_REGISTRY) as ProviderKey[]).filter(
  (provider): provider is Exclude<ProviderKey, 'slack'> => provider !== 'slack',
);

function mapTokenHealth(input: {
  connection_status: string;
  token_expires_at?: string;
}): BrowserSafeConnectionStatus['tokenHealth'] {
  if (input.connection_status === 'connected') {
    const health = resolveTokenHealth(input.token_expires_at);
    if (health === 'expired') {
      return 'expired';
    }
    return health === 'unknown' ? 'unknown' : 'valid';
  }
  if (input.connection_status === 'token_expired') {
    return 'expired';
  }
  if (
    input.connection_status === 'misconfigured' ||
    input.connection_status === 'revoked' ||
    input.connection_status === 'permission_denied' ||
    input.connection_status === 'error'
  ) {
    return 'error';
  }
  return 'unknown';
}

export async function buildPlatformConnectionsPayload(tenantId: string): Promise<{
  status: 'ok';
  connections: Array<PlatformConnectionStatus | BrowserSafeConnectionStatus>;
}> {
  const now = new Date().toISOString();
  const connections: PlatformConnectionsPayload['connections'] = [];

  for (const provider of PLATFORM_CONNECTION_PROVIDERS) {
    if (provider === 'openai') {
      const reference = await resolveOpenAiConnectionReference(tenantId);
      const memoryRecord = reference
        ? oauthStore().connectionsById.get(reference.connectionId)
        : null;
      connections.push({
        provider: 'openai',
        label: 'ChatGPT / OpenAI',
        connected: !!reference,
        tokenHealth: memoryRecord ? mapTokenHealth(memoryRecord) : reference ? 'unknown' : 'unknown',
        lastCheckedAt: memoryRecord?.updated_at || now,
      });
      continue;
    }

    let status: Awaited<ReturnType<typeof oauthStatusAsync>>;
    try {
      status = await oauthStatusAsync(provider, tenantId);
    } catch {
      connections.push({
        provider,
        tenant_id: tenantId,
        connection_status: 'error',
        token_health: 'unknown',
        updated_at: now,
      });
      continue;
    }

    if ('broker_status' in status) {
      connections.push({
        provider,
        tenant_id: tenantId,
        connection_status: 'error',
        token_health: 'unknown',
        updated_at: now,
      });
      continue;
    }

    connections.push({
      provider,
      tenant_id: status.tenant_id,
      connection_id: status.integration_id,
      connection_status: status.connection_status,
      token_health: resolveTokenHealth(status.token_expires_at),
      expires_at: status.token_expires_at,
      updated_at: status.updated_at || now,
    });
  }

  return {
    status: 'ok',
    connections,
  };
}

export async function handlePlatformConnectionsGet(tenantContextLoader?: TenantContextLoader) {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) {
    return tenantResult.response;
  }

  return new Response(JSON.stringify(await buildPlatformConnectionsPayload(tenantResult.tenantContext.tenantId)), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}
