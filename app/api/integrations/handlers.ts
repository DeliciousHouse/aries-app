import { oauthConnect } from '../../../backend/integrations/connect';
import { oauthDisconnect } from '../../../backend/integrations/disconnect';
import { oauthReconnect } from '../../../backend/integrations/reconnect';
import { oauthStatusAsync } from '../../../backend/integrations/status';
import { buildIntegrationSyncEvent } from '../../../backend/integrations/workflow-orchestrator';
import { resolveTokenHealth } from '../../../backend/integrations/connection-schema';
import { mapOpenClawGatewayError, runAriesOpenClawWorkflow } from '../../../backend/openclaw/aries-execution';
import { PROVIDER_REGISTRY } from '../../../backend/integrations/provider-registry';
import { buildOauthConnectInput } from '@/lib/oauth-connect-input';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

const platforms = Object.keys(PROVIDER_REGISTRY) as Array<keyof typeof PROVIDER_REGISTRY>;

type IntegrationPageCard = {
  platform: string;
  display_name: string;
  description: string;
  connection_state: string;
  health: string;
  available_actions: string[];
  last_synced_at: string | null;
  expires_at: string | null;
  permissions: string[];
  connection_id?: string;
  error?: {
    code: string;
    message: string;
  };
};

function customerSafePlatformLabel(platform: keyof typeof PROVIDER_REGISTRY): string {
  if (platform === 'facebook') {
    return 'Meta';
  }
  if (platform === 'instagram') {
    return 'Instagram publishing';
  }
  return PROVIDER_REGISTRY[platform].display_name;
}

function customerSafeStatusMessage(
  platform: keyof typeof PROVIDER_REGISTRY,
  connectionState: IntegrationPageCard['connection_state'],
): string {
  if (platform === 'facebook') {
    if (connectionState === 'connected') {
      return 'Meta is connected and ready.';
    }
    if (connectionState === 'reauth_required' || connectionState === 'connection_error') {
      return 'Meta is not connected yet.';
    }
    if (connectionState === 'disabled') {
      return 'Contact support to finish channel setup.';
    }
    return 'Meta is not connected yet.';
  }

  if (platform === 'instagram') {
    if (connectionState === 'connected') {
      return 'Instagram publishing is connected and ready.';
    }
    if (connectionState === 'disabled') {
      return 'Instagram publishing needs to be connected.';
    }
    if (connectionState === 'reauth_required' || connectionState === 'connection_error') {
      return 'Instagram publishing needs attention before posts can go live.';
    }
    return 'Instagram publishing needs to be connected.';
  }

  if (connectionState === 'connected') {
    return `${customerSafePlatformLabel(platform)} is connected and ready.`;
  }
  if (connectionState === 'disabled') {
    return 'Publishing is not ready yet.';
  }
  if (connectionState === 'reauth_required' || connectionState === 'connection_error') {
    return 'Contact support to finish channel setup.';
  }
  return `${customerSafePlatformLabel(platform)} is not connected yet.`;
}

function mapState(connectionStatus: string) {
  if (connectionStatus === 'connected') return 'connected';
  if (connectionStatus === 'pending_oauth') return 'connection_pending';
  if (connectionStatus === 'misconfigured') return 'disabled';
  if (connectionStatus === 'token_expired' || connectionStatus === 'revoked' || connectionStatus === 'permission_denied') {
    return 'reauth_required';
  }
  return 'not_connected';
}

function mapHealth(connectionStatus: string, tokenExpiresAt?: string) {
  if (connectionStatus === 'misconfigured') return 'error';
  if (connectionStatus !== 'connected' && connectionStatus !== 'token_expired') return 'unknown';

  switch (resolveTokenHealth(tokenExpiresAt)) {
    case 'healthy':
      return 'healthy';
    case 'expiring_soon':
      return 'degraded';
    case 'expired':
      return 'error';
    default:
      return 'unknown';
  }
}

function buildDisconnectedIntegrationCard(platform: keyof typeof PROVIDER_REGISTRY): IntegrationPageCard {
  return {
    platform,
    display_name: customerSafePlatformLabel(platform),
    description: customerSafeStatusMessage(platform, 'not_connected'),
    connection_state: 'not_connected',
    health: 'unknown',
    available_actions: ['connect', 'view_permissions'],
    last_synced_at: null,
    expires_at: null,
    permissions: [],
  };
}

function buildIntegrationsPagePayload(cards: IntegrationPageCard[]) {
  const summary = {
    total: platforms.length,
    connected: cards.filter((c) => c.connection_state === 'connected').length,
    not_connected: cards.filter((c) => c.connection_state === 'not_connected' || c.connection_state === 'disabled').length,
    attention_required: cards.filter((c) =>
      c.connection_state === 'connection_error' || c.connection_state === 'reauth_required'
    ).length
  };

  return { status: 'ok', page_state: 'ready', supported_platforms: platforms, cards, summary };
}

export function buildIntegrationsPageData(tenantId: string) {
  return buildIntegrationsPageDataAsync(tenantId);
}

export async function buildIntegrationsPageDataAsync(tenantId: string) {
  const cards = await Promise.all(
    platforms.map(async (platform) => {
      const status = await oauthStatusAsync(platform, tenantId);
      if ('broker_status' in status) {
        return {
          ...buildDisconnectedIntegrationCard(platform),
          connection_state: 'connection_error',
          health: 'error',
          available_actions: ['connect'],
          error: {
            code: 'provider_unavailable',
            message: customerSafeStatusMessage(platform, 'connection_error'),
          },
        };
      }

      if (status.connection_status === 'misconfigured') {
        return {
          ...buildDisconnectedIntegrationCard(platform),
          connection_state: 'disabled',
          health: 'error',
          available_actions: [],
          error: {
            code: 'provider_unavailable',
            message: customerSafeStatusMessage(platform, 'disabled'),
          },
        };
      }

      return {
        platform,
        display_name: customerSafePlatformLabel(platform),
        description: customerSafeStatusMessage(platform, mapState(status.connection_status)),
        connection_id: status.integration_id,
        connection_state: mapState(status.connection_status),
        health: mapHealth(status.connection_status, status.token_expires_at),
        available_actions:
          status.connection_status === 'connected'
            ? ['sync_now', 'disconnect', 'view_permissions']
            : status.connection_status === 'token_expired' ||
                status.connection_status === 'revoked' ||
                status.connection_status === 'permission_denied'
              ? ['reconnect', 'view_permissions']
              : ['connect', 'view_permissions'],
        last_synced_at: null,
        expires_at: status.token_expires_at || null,
        permissions: [],
        error:
          status.last_error?.message && status.connection_status !== 'connected'
            ? {
                code: status.last_error.code || 'provider_unavailable',
                message: customerSafeStatusMessage(platform, mapState(status.connection_status)),
              }
            : undefined,
      };
    }),
  );

  return buildIntegrationsPagePayload(cards);
}

export async function handleIntegrationsGet(tenantContextLoader?: TenantContextLoader) {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) {
    return tenantResult.response;
  }

  return new Response(JSON.stringify(await buildIntegrationsPageDataAsync(tenantResult.tenantContext.tenantId)), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

export async function handleIntegrationsConnect(
  req: Request,
  providerFromPath?: string,
  tenantContextLoader?: TenantContextLoader
) {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) {
    return tenantResult.response;
  }

  const input = await buildOauthConnectInput(req, tenantResult.tenantContext, providerFromPath);
  const result = await oauthConnect(input.provider, input.payload);

  const status =
    result.broker_status === 'ok'
      ? 200
      : result.reason === 'provider_unavailable'
        ? 503
      : result.reason === 'already_connected'
        ? 409
        : 400;

  return new Response(JSON.stringify(result), { status, headers: { 'content-type': 'application/json' } });
}

export async function handleIntegrationsDisconnect(req: Request, tenantContextLoader?: TenantContextLoader) {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) {
    return tenantResult.response;
  }

  const body = await req.json();
  const provider = String(body.platform || '').toLowerCase();
  const tenantId = tenantResult.tenantContext.tenantId;
  const status = await oauthStatusAsync(provider, tenantId);
  if ('broker_status' in status || !status.integration_id) {
    return new Response(JSON.stringify({ broker_status: 'error', reason: 'connection_not_found', provider }), { status: 404, headers: { 'content-type': 'application/json' } });
  }

  const result = await oauthDisconnect(provider, { connection_id: status.integration_id });
  return new Response(JSON.stringify(result), { status: result.broker_status === 'ok' ? 200 : 400, headers: { 'content-type': 'application/json' } });
}

function resolveBaseUrl(req: Request): string {
  const configuredBaseUrl = process.env.APP_BASE_URL?.trim();
  if (configuredBaseUrl) {
    try {
      return new URL(configuredBaseUrl).origin;
    } catch {
      // Fall back to the incoming request origin when APP_BASE_URL is invalid.
    }
  }

  return new URL(req.url).origin;
}

export async function handleOauthReconnect(
  req: Request,
  providerFromPath?: string,
  tenantContextLoader?: TenantContextLoader
) {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) {
    return tenantResult.response;
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const provider = String(providerFromPath || body.platform || '').toLowerCase();
  const tenantId = tenantResult.tenantContext.tenantId;
  const status = await oauthStatusAsync(provider, tenantId);
  if ('broker_status' in status || !status.integration_id) {
    return new Response(JSON.stringify({ broker_status: 'error', reason: 'connection_not_found', provider }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  const scopes = Array.isArray(body.scopes) ? body.scopes : undefined;
  const result = await oauthReconnect(provider, {
    connection_id: status.integration_id,
    redirect_uri: `${resolveBaseUrl(req)}/api/auth/oauth/${provider}/callback`,
    scopes: Array.isArray(scopes) ? scopes.filter((scope): scope is string => typeof scope === 'string') : undefined,
  });

  const responseStatus =
    result.broker_status === 'ok'
      ? 200
      : result.reason === 'provider_unavailable'
        ? 503
      : result.reason === 'missing_required_fields' || result.reason === 'invalid_provider' || result.reason === 'validation_error'
        ? 400
        : result.reason === 'connection_not_found'
          ? 404
          : 500;

  return new Response(JSON.stringify(result), {
    status: responseStatus,
    headers: { 'content-type': 'application/json' },
  });
}

export async function handleIntegrationsSync(req: Request, tenantContextLoader?: TenantContextLoader) {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) {
    return tenantResult.response;
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  try {
    const tenantId = tenantResult.tenantContext.tenantId;
    const provider = String(body.platform || '').toLowerCase();
    const event = buildIntegrationSyncEvent({
      tenant_id: tenantId,
      provider,
    });
    const executed = await runAriesOpenClawWorkflow('integrations_sync', {
      tenant_id: tenantId,
      provider,
    });
    if (executed.kind === 'gateway_error') {
      const mapped = mapOpenClawGatewayError(executed.error);
      return new Response(JSON.stringify(mapped.body), {
        status: mapped.status,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (executed.kind === 'not_implemented') {
      return new Response(JSON.stringify({
        status: 'error',
        reason: executed.payload.code,
        route: executed.payload.route,
        message: executed.payload.message,
      }), {
        status: 501,
        headers: { 'content-type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({
      status: 'accepted',
      workflow_id: 'integrations_sync',
      workflow_status: executed.envelope.status,
      event,
      result: executed.primaryOutput,
    }), {
      status: 202,
      headers: { 'content-type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ status: 'error', reason: String((error as Error).message || error) }), {
      status: 400,
      headers: { 'content-type': 'application/json' }
    });
  }
}
