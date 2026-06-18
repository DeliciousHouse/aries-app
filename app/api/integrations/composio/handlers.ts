/**
 * HTTP handlers for the Composio connection lifecycle. Isolated under
 * /api/integrations/composio/* so the whole surface is removable without
 * touching any existing integration route. Every handler is tenant-gated via
 * loadTenantContextOrResponse, matching the repo convention.
 *
 * Endpoints:
 *   POST   /api/integrations/composio/:platform/connect      -> { connectUrl }
 *   GET    /api/integrations/composio                        -> { connections }
 *   GET    /api/integrations/composio/:platform/capabilities -> { capabilities }
 *   DELETE /api/integrations/composio/:platform              -> { disconnected }
 */

import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';
import {
  isIntegrationPlatform,
  isRequestedCapability,
  type IntegrationPlatform,
  type RequestedCapability,
} from '@/backend/integrations/providers/types';
import {
  connectablePlatforms,
  getAccountConnectionProvider,
  getCapabilityProvider,
  resolveIntegrationConfig,
} from '@/backend/integrations/providers';
import { IntegrationError } from '@/backend/integrations/providers/errors';
import { notConnectedAccount } from '@/backend/integrations/composio/connection-store';
import { platformPrerequisites } from '@/backend/integrations/composio/capability-preflight';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function errorResponse(error: unknown): Response {
  if (error instanceof IntegrationError) {
    return json({ status: 'error', reason: error.code, message: error.message }, error.status);
  }
  const message = error instanceof Error ? error.message : 'Unexpected error';
  return json({ status: 'error', reason: 'composio_error', message }, 500);
}

function platformOr400(raw: string): IntegrationPlatform | Response {
  // isIntegrationPlatform narrows the type; connectablePlatforms() is the flag
  // gate. A recognized-but-not-enabled platform (e.g. 'x' while ARIES_X_ENABLED
  // is OFF) yields the IDENTICAL unsupported_platform 400 as an unknown one.
  if (!isIntegrationPlatform(raw) || !connectablePlatforms().includes(raw)) {
    return json({ status: 'error', reason: 'unsupported_platform', message: `Unsupported platform: ${raw}` }, 400);
  }
  return raw;
}

/** Stable per-tenant Composio user identifier. */
function externalUserIdFor(tenantId: string): string {
  return `aries-tenant-${tenantId}`;
}

function composioDisabledResponse(): Response {
  return json(
    {
      status: 'error',
      reason: 'composio_disabled',
      message: 'Composio is not enabled. Set COMPOSIO_ENABLED=true and COMPOSIO_API_KEY to use account connections.',
    },
    409,
  );
}

export async function handleComposioConnect(
  req: Request,
  platformRaw: string,
  loader?: TenantContextLoader,
): Promise<Response> {
  const platform = platformOr400(platformRaw);
  if (platform instanceof Response) return platform;

  const tenantResult = await loadTenantContextOrResponse(loader);
  if ('response' in tenantResult) return tenantResult.response;
  const { tenantId } = tenantResult.tenantContext;

  let requestedCapability: RequestedCapability = 'full';
  try {
    const body = (await req.json()) as { requestedCapability?: string };
    if (body?.requestedCapability) {
      if (!isRequestedCapability(body.requestedCapability)) {
        return json(
          { status: 'error', reason: 'invalid_capability', message: 'requestedCapability must be publish|analytics|ads|full.' },
          400,
        );
      }
      requestedCapability = body.requestedCapability;
    }
  } catch {
    /* empty body is fine — default to 'full' */
  }

  const provider = getAccountConnectionProvider();
  if (!provider) return composioDisabledResponse();

  try {
    const base = process.env.APP_BASE_URL?.replace(/\/+$/, '') ?? '';
    // Return the operator to the in-dashboard connections surface (the
    // "Channel Integrations" nav entry) after the Composio OAuth completes.
    const callbackUrl = base
      ? `${base}/dashboard/settings/channel-integrations?connected=${platform}`
      : undefined;
    const result = await provider.createConnectLink(externalUserIdFor(tenantId), platform, requestedCapability, {
      tenantId,
      callbackUrl,
    });
    return json({
      status: 'ok',
      platform,
      connectUrl: result.connectUrl,
      connectionRequestId: result.connectionRequestId,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleComposioList(loader?: TenantContextLoader): Promise<Response> {
  const tenantResult = await loadTenantContextOrResponse(loader);
  if ('response' in tenantResult) return tenantResult.response;
  const { tenantId } = tenantResult.tenantContext;

  const config = resolveIntegrationConfig();
  const provider = getAccountConnectionProvider();

  const externalUserId = externalUserIdFor(tenantId);
  let stored: Awaited<ReturnType<NonNullable<typeof provider>['listConnections']>> = [];
  if (provider) {
    try {
      stored = await provider.listConnections(externalUserId, { tenantId });
      // Reconcile any pending connections: once the user has approved out-of-band,
      // this flips the stored row from `pending` to `connected` and records the
      // connected-account id. Best-effort — a refresh failure leaves the row as-is.
      const pending = stored.filter((c) => c.status === 'pending');
      if (pending.length > 0) {
        await Promise.all(
          pending.map((c) =>
            provider.refreshConnectionStatus(externalUserId, c.platform, { tenantId }).catch(() => null),
          ),
        );
        stored = await provider.listConnections(externalUserId, { tenantId });
      }
    } catch (error) {
      return errorResponse(error);
    }
  }

  // Merge stored rows with not-connected placeholders so the UI can render
  // every supported platform regardless of whether a row exists yet.
  const byPlatform = new Map(stored.map((c) => [c.platform, c]));
  const connections = connectablePlatforms().map((platform) => {
    const account = byPlatform.get(platform) ?? notConnectedAccount(tenantId, externalUserId, platform, 'composio');
    return { ...account, prerequisites: platformPrerequisites(platform) };
  });

  return json({
    status: 'ok',
    composioEnabled: config.composioEnabled,
    publishProvider: config.publishProvider,
    analyticsProvider: config.analyticsProvider,
    connections,
  });
}

export async function handleComposioCapabilities(platformRaw: string, loader?: TenantContextLoader): Promise<Response> {
  const platform = platformOr400(platformRaw);
  if (platform instanceof Response) return platform;

  const tenantResult = await loadTenantContextOrResponse(loader);
  if ('response' in tenantResult) return tenantResult.response;
  const { tenantId } = tenantResult.tenantContext;

  try {
    const provider = getCapabilityProvider();
    const capabilities = await provider.checkCapabilities(externalUserIdFor(tenantId), platform, { tenantId });
    return json({ status: 'ok', platform, capabilities });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleComposioDisconnect(platformRaw: string, loader?: TenantContextLoader): Promise<Response> {
  const platform = platformOr400(platformRaw);
  if (platform instanceof Response) return platform;

  const tenantResult = await loadTenantContextOrResponse(loader);
  if ('response' in tenantResult) return tenantResult.response;
  const { tenantId } = tenantResult.tenantContext;

  const provider = getAccountConnectionProvider();
  if (!provider) return composioDisabledResponse();

  try {
    const result = await provider.disconnectConnection(externalUserIdFor(tenantId), platform, { tenantId });
    return json({ status: 'ok', platform, disconnected: result.disconnected });
  } catch (error) {
    return errorResponse(error);
  }
}
