import { resolveTokenHealth } from '../../../backend/integrations/connection-schema';
import { oauthStatusAsync } from '../../../backend/integrations/status';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';
type BrowserSafeConnectionStatus = {
  provider: 'openai';
  label: 'ChatGPT / OpenAI';
  connected: boolean;
  tokenHealth: 'unknown' | 'valid' | 'expired' | 'error';
  lastCheckedAt: string | null;
};

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
  connections: BrowserSafeConnectionStatus[];
}> {
  const status = await oauthStatusAsync('openai', tenantId);
  const now = new Date().toISOString();
  if ('broker_status' in status) {
    return {
      status: 'ok',
      connections: [
        {
          provider: 'openai',
          label: 'ChatGPT / OpenAI',
          connected: false,
          tokenHealth: 'error',
          lastCheckedAt: now,
        },
      ],
    };
  }

  return {
    status: 'ok',
    connections: [
      {
        provider: 'openai',
        label: 'ChatGPT / OpenAI',
        connected: status.connection_status === 'connected',
        tokenHealth: mapTokenHealth(status),
        lastCheckedAt: status.updated_at || now,
      },
    ],
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
