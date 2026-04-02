import { isAllowedProvider, brokerError } from './connect';
import { dbGetConnection, dbUpsertConnection } from './oauth-db';

type OAuthRefreshInput = {
  token_expires_in_seconds?: number;
  refresh_expires_in_seconds?: number;
};

function addSeconds(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

export async function oauthRefresh(provider: string, tenantId?: string, input: OAuthRefreshInput = {}) {
  if (!isAllowedProvider(provider)) return brokerError('invalid_provider', { provider });
  if (!tenantId) return brokerError('missing_required_fields', { provider, message: 'missing_required_fields:tenant_id' });

  const tenant = tenantId.trim();
  const existing = await dbGetConnection({ tenantId: tenant, provider });
  if (!existing) return brokerError('connection_not_found', { provider });

  const refreshedAt = new Date().toISOString();
  const tokenExpiresAt =
    typeof input.token_expires_in_seconds === 'number' && input.token_expires_in_seconds > 0
      ? addSeconds(refreshedAt, input.token_expires_in_seconds)
      : null;
  const refreshExpiresAt =
    typeof input.refresh_expires_in_seconds === 'number' && input.refresh_expires_in_seconds > 0
      ? addSeconds(refreshedAt, input.refresh_expires_in_seconds)
      : null;

  const updated = await dbUpsertConnection({
    tenantId: tenant,
    provider,
    status: 'connected',
    grantedScopes: existing.granted_scopes,
    tokenExpiresAt: tokenExpiresAt ?? undefined,
    refreshExpiresAt: refreshExpiresAt ?? undefined,
    disconnectedAt: null,
  });

  return {
    broker_status: 'ok' as const,
    provider,
    connection_id: updated.id,
    connection_status: 'connected' as const,
    refreshed_at: refreshedAt
  };
}
