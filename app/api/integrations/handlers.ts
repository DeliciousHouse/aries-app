import { oauthConnect } from '../../../backend/integrations/connect';
import { oauthDisconnect } from '../../../backend/integrations/disconnect';
import { oauthReconnect } from '../../../backend/integrations/reconnect';
import { oauthStatusAsync } from '../../../backend/integrations/status';
import { buildIntegrationSyncEvent } from '../../../backend/integrations/workflow-orchestrator';
import { resolveTokenHealth } from '../../../backend/integrations/connection-schema';
import { mapAriesExecutionError, runAriesWorkflow } from '../../../backend/execution';
import { PROVIDER_REGISTRY } from '../../../backend/integrations/provider-registry';
import { buildOauthConnectInput } from '@/lib/oauth-connect-input';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';
import { syncAllAccountsForTenant } from '@/backend/insights/sync/dispatcher';
import { isSupportedPlatform } from '@/backend/insights/platforms/registry';
import { hasAdapter } from '@/backend/insights/sync/adapter-factory';
import { resolveInsightsStaleMs } from '@/backend/insights/freshness/config';
import pool from '@/lib/db';

// openai is a model provider, not a publishing channel; slack is a notification
// target connected on its own settings card (with a channel picker), not a
// publishing platform. Both are excluded from the publishing integrations cards.
const platforms = (Object.keys(PROVIDER_REGISTRY) as Array<keyof typeof PROVIDER_REGISTRY>).filter(
  (platform) => platform !== 'openai' && platform !== 'slack',
);

const META_REQUIRED_SCOPES = ['pages_show_list'];

type IntegrationPageCard = {
  platform: string;
  display_name: string;
  description: string;
  connection_state: string;
  health: string;
  available_actions: string[];
  last_synced_at: string | null;
  sync_state?: 'current' | 'stale' | 'never_synced';
  expires_at: string | null;
  permissions: string[];
  connection_id?: string;
  scopes_outdated?: boolean;
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

type IntegrationSyncTerminalStatus = 'ok' | 'partial' | 'failed' | null;

type IntegrationSyncTelemetry = {
  lastSyncedAt: string | null;
  syncState: 'current' | 'stale' | 'never_synced';
};

function syncTelemetryKey(platform: string, externalAccountId: string): string {
  return `${platform}\u0000${externalAccountId}`;
}

export function deriveIntegrationSyncTelemetry(
  lastSyncAt: Date | string | null,
  latestStatus: IntegrationSyncTerminalStatus,
  nowMs = Date.now(),
  staleAfterMs = resolveInsightsStaleMs(),
): IntegrationSyncTelemetry {
  if (lastSyncAt === null) {
    return { lastSyncedAt: null, syncState: 'never_synced' };
  }

  const timestamp = lastSyncAt instanceof Date ? lastSyncAt : new Date(lastSyncAt);
  const timestampMs = timestamp.getTime();
  if (!Number.isFinite(timestampMs)) {
    return { lastSyncedAt: null, syncState: 'never_synced' };
  }

  return {
    lastSyncedAt: timestamp.toISOString(),
    syncState:
      latestStatus === 'failed' || nowMs - timestampMs > staleAfterMs
        ? 'stale'
        : 'current',
  };
}

async function loadSyncTelemetryByAccount(
  tenantId: number,
): Promise<Map<string, IntegrationSyncTelemetry>> {
  const result = await pool.query<{
    platform: string;
    external_account_id: string;
    last_synced_at: Date | string | null;
    latest_status: IntegrationSyncTerminalStatus;
  }>(
    `WITH latest_run AS (
       SELECT DISTINCT ON (account_id) account_id, status
       FROM insights_sync_runs
       WHERE tenant_id = $1 AND status IN ('ok', 'partial', 'failed')
       ORDER BY account_id, COALESCE(finished_at, started_at) DESC
     )
     SELECT a.platform,
            a.external_account_id,
            a.last_sync_at AS last_synced_at,
            lr.status AS latest_status
     FROM insights_accounts a
     LEFT JOIN latest_run lr ON lr.account_id = a.id
     WHERE a.tenant_id = $1`,
    [tenantId],
  );
  const nowMs = Date.now();
  const staleAfterMs = resolveInsightsStaleMs();

  return new Map(result.rows.map((row) => [
    syncTelemetryKey(row.platform, row.external_account_id),
    deriveIntegrationSyncTelemetry(row.last_synced_at, row.latest_status, nowMs, staleAfterMs),
  ]));
}

export function buildIntegrationsPageData(tenantId: string) {
  return buildIntegrationsPageDataAsync(tenantId);
}

export async function buildIntegrationsPageDataAsync(tenantId: string) {
  const syncExternalAccountIdByPlatform = new Map<string, string>();
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

      const syncExternalAccountId = status.external_account_id?.trim();
      if (syncExternalAccountId) {
        syncExternalAccountIdByPlatform.set(platform, syncExternalAccountId);
      }

      const connectedAccount =
        status.connection_status === 'connected' &&
        status.external_account_id &&
        status.external_account_name
          ? {
              account_id: status.external_account_id,
              account_label: status.external_account_name,
            }
          : undefined;

      const scopesOutdated =
        platform === 'facebook' &&
        status.connection_status === 'connected' &&
        !META_REQUIRED_SCOPES.every((s) => status.granted_scopes?.includes(s));

      return {
        platform,
        display_name: customerSafePlatformLabel(platform),
        description: customerSafeStatusMessage(platform, mapState(status.connection_status)),
        connection_id: status.integration_id,
        connection_state: mapState(status.connection_status),
        health: mapHealth(status.connection_status, status.token_expires_at),
        scopes_outdated: scopesOutdated || undefined,
        available_actions:
          status.connection_status === 'connected'
            ? status.status_reason === 'env_managed'
              ? ['view_permissions']
              : ['sync_now', 'disconnect', 'view_permissions']
            : status.connection_status === 'token_expired' ||
                status.connection_status === 'revoked' ||
                status.connection_status === 'permission_denied'
              ? ['reconnect', 'view_permissions']
              : ['connect', 'view_permissions'],
        last_synced_at: null,
        expires_at: status.token_expires_at || null,
        permissions: [],
        connected_account: connectedAccount,
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

  const hasSyncTelemetryCard = cards.some((card) =>
    card.connection_state === 'connected' || card.connection_state === 'reauth_required'
  );
  if (!hasSyncTelemetryCard) {
    return buildIntegrationsPagePayload(cards);
  }

  const numericTenantId = Number(tenantId);
  const telemetryByAccount =
    Number.isSafeInteger(numericTenantId) && numericTenantId > 0 && syncExternalAccountIdByPlatform.size > 0
      ? await loadSyncTelemetryByAccount(numericTenantId)
      : new Map<string, IntegrationSyncTelemetry>();

  return buildIntegrationsPagePayload(cards.map((card) => {
    if (card.connection_state !== 'connected' && card.connection_state !== 'reauth_required') {
      return card;
    }

    const externalAccountId = syncExternalAccountIdByPlatform.get(card.platform);
    const telemetry = externalAccountId
      ? telemetryByAccount.get(syncTelemetryKey(card.platform, externalAccountId))
      : undefined;
    return {
      ...card,
      last_synced_at: telemetry?.lastSyncedAt ?? null,
      sync_state: telemetry?.syncState ?? 'never_synced',
    };
  }));
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
  const authType = body.auth_type === 'reauthenticate' ? 'reauthenticate' as const : undefined;
  const result = await oauthReconnect(provider, {
    connection_id: status.integration_id,
    redirect_uri: `${resolveBaseUrl(req)}/api/auth/oauth/${provider}/callback`,
    scopes: Array.isArray(scopes) ? scopes.filter((scope): scope is string => typeof scope === 'string') : undefined,
    auth_type: authType,
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

    // Insights platforms (youtube, instagram, facebook) are synced directly
    // by our dispatcher — no Hermes workflow needed for a simple DB write loop.
    // All other providers fall through to the existing Hermes path below.
    if (isSupportedPlatform(provider) && hasAdapter(provider)) {
      const results = await syncAllAccountsForTenant(Number(tenantId), 'handler');
      const allOk = results.every((r) => r.status === 'ok' || r.status === 'partial');
      return new Response(
        JSON.stringify({
          status: allOk ? 'ok' : 'partial',
          platform: provider,
          accounts: results.length,
          results: results.map((r) => ({
            accountId:    r.accountId,
            status:       r.status,
            postsSeen:    r.postsSeen,
            commentsSeen: r.commentsSeen,
            ...(r.errorMessage ? { error: r.errorMessage } : {}),
          })),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    const event = buildIntegrationSyncEvent({
      tenant_id: tenantId,
      provider,
    });
    const executed = await runAriesWorkflow('integrations_sync', {
      tenant_id: tenantId,
      provider,
    });
    if (executed.kind === 'gateway_error') {
      const mapped = mapAriesExecutionError(executed.error);
      if (!mapped) {
        return new Response(JSON.stringify({ status: 'error', reason: 'Execution failed.' }), {
          status: 500,
          headers: { 'content-type': 'application/json' }
        });
      }
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
    return new Response(JSON.stringify({ status: 'error', reason: 'An unexpected error occurred' }), {
      status: 400,
      headers: { 'content-type': 'application/json' }
    });
  }
}
