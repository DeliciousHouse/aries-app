import { brokerError, isAllowedProvider, type OAuthBrokerError } from './connect';
import { dbAuditEvent, dbGetConnectionById, dbUpsertConnection } from './oauth-db';
import { dbRevokeTokensForConnection } from './oauth-tokens-db';
import { getTenantContext } from '@/lib/tenant-context';

type OAuthDisconnectRequest = {
  connection_id?: string;
  revoke_provider_token?: boolean;
  reason?: string;
};

type OAuthDisconnectSuccess = {
  broker_status: 'ok';
  provider: string;
  connection_id: string;
  connection_status: 'disconnected';
  disconnected: true;
  disconnected_at?: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function providerTenantKey(tenantId: string, provider: string): string {
  return `${tenantId}::${provider}`;
}

export async function oauthDisconnect(provider: string, payload: OAuthDisconnectRequest): Promise<OAuthDisconnectSuccess | OAuthBrokerError> {
  if (!isAllowedProvider(provider)) return brokerError('invalid_provider', { provider });
  if (!payload.connection_id || payload.connection_id.trim().length === 0) {
    return brokerError('missing_required_fields', { provider, message: 'missing_required_fields:connection_id' });
  }

  const connectionId = payload.connection_id.trim();
  const connection = await dbGetConnectionById(connectionId);

  if (!connection || connection.provider !== provider) {
    return brokerError('connection_not_found', { provider, connection_id: connectionId });
  }

  try {
    const at = nowIso();
    await dbUpsertConnection({
      tenantId: connection.tenant_id,
      provider,
      status: 'disconnected',
      grantedScopes: connection.granted_scopes,
      disconnectedAt: at,
      lastErrorCode: null,
      lastErrorMessage: null,
    });
    await dbRevokeTokensForConnection(connectionId);
    await dbAuditEvent({
      tenantId: connection.tenant_id,
      connectionId,
      provider,
      eventType: 'oauth.disconnect',
      eventStatus: 'ok',
      detail: { revoke_provider_token: !!payload.revoke_provider_token, reason: payload.reason || null },
    });

    return {
      broker_status: 'ok',
      provider,
      connection_id: connectionId,
      connection_status: 'disconnected',
      disconnected: true,
      disconnected_at: at
    };
  } catch {
    return brokerError('disconnect_failed', { provider, connection_id: connectionId });
  }
}

export async function handleOauthDisconnectHttp(req: Request, providerFromPath?: string): Promise<Response> {
  // PRD §20 invariant 1: Aries owns tenant boundaries.  Previously this route
  // accepted a connection_id from any caller and disconnected it without
  // verifying the caller had access to the owning tenant.  Now: resolve the
  // session-derived tenant, look up the connection, and refuse if the
  // connection does not belong to the authenticated tenant.
  let tenantContext;
  try {
    tenantContext = await getTenantContext();
  } catch {
    return new Response(
      JSON.stringify({ broker_status: 'error', reason: 'authentication_required' }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    );
  }

  let payload: OAuthDisconnectRequest = {};
  try {
    payload = (await req.json()) as OAuthDisconnectRequest;
  } catch {
    payload = {};
  }

  const url = new URL(req.url);
  const provider = (providerFromPath || url.searchParams.get('provider') || '').toLowerCase();

  // Verify the requested connection belongs to the authenticated tenant
  // before delegating to oauthDisconnect.  Cross-tenant attempts get a 404
  // (connection_not_found) so we do not leak whether the connection exists.
  const connectionId = payload.connection_id?.trim();
  if (connectionId) {
    const connection = await dbGetConnectionById(connectionId);
    if (!connection || connection.tenant_id !== tenantContext.tenantId) {
      return new Response(
        JSON.stringify({
          broker_status: 'error',
          reason: 'connection_not_found',
          provider,
          connection_id: connectionId,
        }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      );
    }
  }

  const result = await oauthDisconnect(provider, payload);

  const status =
    result.broker_status === 'ok'
      ? 200
      : result.reason === 'invalid_provider' || result.reason === 'missing_required_fields'
        ? 400
        : result.reason === 'connection_not_found'
          ? 404
          : 500;

  return new Response(JSON.stringify(result), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
