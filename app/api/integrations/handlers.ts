import { oauthConnect } from '../../../backend/integrations/connect';
import { oauthDisconnect } from '../../../backend/integrations/disconnect';
import { oauthReconnect } from '../../../backend/integrations/reconnect';
import { oauthStatus } from '../../../backend/integrations/status';
import { buildIntegrationSyncEvent } from '../../../backend/integrations/workflow-orchestrator';
import { resolveTokenHealth } from '../../../backend/integrations/connection-schema';
import { mapOpenClawGatewayError, runAriesOpenClawWorkflow } from '../../../backend/openclaw/aries-execution';
import { PROVIDER_REGISTRY } from '../../../backend/integrations/provider-registry';
import { buildOauthConnectInput } from '@/lib/oauth-connect-input';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

const platforms = Object.keys(PROVIDER_REGISTRY) as Array<keyof typeof PROVIDER_REGISTRY>;

function mapState(connectionStatus: string) {
  if (connectionStatus === 'connected') return 'connected';
  if (connectionStatus === 'pending_oauth') return 'connection_pending';
  if (connectionStatus === 'token_expired' || connectionStatus === 'revoked' || connectionStatus === 'permission_denied') {
    return 'reauth_required';
  }
  return 'not_connected';
}

function mapHealth(connectionStatus: string, tokenExpiresAt?: string) {
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

export function buildIntegrationsPageData(tenantId: string) {
  const cards = platforms.map((platform) => {
    const status = oauthStatus(platform, tenantId);
    if ('broker_status' in status) {
      return {
        platform,
        display_name: PROVIDER_REGISTRY[platform].display_name,
        description: `Connect ${PROVIDER_REGISTRY[platform].display_name}`,
        connection_state: 'connection_error',
        health: 'error',
        available_actions: ['connect'],
        permissions: []
      };
    }

    return {
      platform,
      display_name: PROVIDER_REGISTRY[platform].display_name,
      description: `Connect ${PROVIDER_REGISTRY[platform].display_name}`,
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
      permissions: []
    };
  });

  const summary = {
    total: platforms.length,
    connected: cards.filter((c) => c.connection_state === 'connected').length,
    not_connected: cards.filter((c) => c.connection_state === 'not_connected').length,
    attention_required: cards.filter((c) =>
      c.connection_state === 'connection_error' || c.connection_state === 'reauth_required'
    ).length
  };

  return { status: 'ok', page_state: 'ready', supported_platforms: platforms, cards, summary };
}

export async function handleIntegrationsGet(tenantContextLoader?: TenantContextLoader) {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) {
    return tenantResult.response;
  }

  return new Response(JSON.stringify(buildIntegrationsPageData(tenantResult.tenantContext.tenantId)), {
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
  const status = oauthStatus(provider, tenantId);
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
  const status = oauthStatus(provider, tenantId);
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
