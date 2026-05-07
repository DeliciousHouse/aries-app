import type { PoolClient } from 'pg';

import { brokerError, isAllowedProvider, type OAuthBrokerError } from './connect';
import { dbAuditEvent, dbGetConnection, type DbProvider } from './oauth-db';
import {
  dbGetLatestOAuthToken,
  dbInsertOAuthToken,
  dbRevokeOAuthTokenById,
  withConnectionLock,
  type LockedConnectionRow,
  type StoredOAuthToken,
} from './oauth-tokens-db';
import {
  ProviderRefreshError,
  refreshMetaLongLived,
  type ProviderRefreshResult,
} from './refresh-meta';
import { refreshLinkedIn } from './refresh-linkedin';
import { refreshX } from './refresh-x';
import { refreshGoogle } from './refresh-google';
import { refreshTikTok } from './refresh-tiktok';
import { refreshReddit } from './refresh-reddit';

type OAuthRefreshInput = {
  token_expires_in_seconds?: number;
  refresh_expires_in_seconds?: number;
};

export type OAuthRefreshSuccess = {
  broker_status: 'ok';
  provider: DbProvider;
  connection_id: string;
  connection_status: 'connected';
  refreshed_at: string;
  refreshed: boolean;
  token_expires_at: string | null;
};

const FRESHNESS_TOLERANCE_MS = 5_000;

function nowIso(): string {
  return new Date().toISOString();
}

function addSeconds(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

function fallbackTtlIso(refreshedAt: string, seconds: number | undefined): string | null {
  if (typeof seconds === 'number' && seconds > 0) {
    return addSeconds(refreshedAt, seconds);
  }
  return null;
}

async function callProviderRefresh(
  provider: DbProvider,
  latestToken: StoredOAuthToken | null,
): Promise<ProviderRefreshResult> {
  const accessToken = latestToken?.access_token ?? null;
  const refreshToken = latestToken?.refresh_token ?? null;

  switch (provider) {
    case 'facebook':
    case 'instagram': {
      if (!accessToken) {
        throw new ProviderRefreshError('unauthorized', 'meta_no_access_token_to_exchange');
      }
      return refreshMetaLongLived({ accessToken });
    }
    case 'linkedin':
      return refreshLinkedIn({ refreshToken });
    case 'x':
      return refreshX({ refreshToken });
    case 'youtube':
      return refreshGoogle({ refreshToken });
    case 'tiktok':
      return refreshTikTok({ refreshToken });
    case 'reddit':
      return refreshReddit({ refreshToken });
    case 'openai':
      throw new ProviderRefreshError('configuration_error', 'openai_refresh_not_implemented');
    default:
      throw new ProviderRefreshError('configuration_error', `provider_refresh_not_implemented:${provider}`);
  }
}

async function updateConnectionAfterSuccess(
  client: PoolClient,
  connectionId: string,
  tokenExpiresAt: string | null,
  refreshExpiresAt: string | null,
): Promise<void> {
  await client.query(
    `
      UPDATE oauth_connections
      SET status = $1,
          token_expires_at = $2,
          refresh_expires_at = $3,
          last_error_code = $4,
          last_error_message = $5,
          updated_at = now()
      WHERE id = $6
    `,
    ['connected', tokenExpiresAt, refreshExpiresAt, null, null, Number.parseInt(connectionId, 10)],
  );
}

async function updateConnectionAfterFailure(
  client: PoolClient,
  connectionId: string,
  status: 'reauthorization_required' | 'connected',
  errorCode: string,
  errorMessage: string,
): Promise<void> {
  await client.query(
    `
      UPDATE oauth_connections
      SET status = $1,
          last_error_code = $2,
          last_error_message = $3,
          updated_at = now()
      WHERE id = $4
    `,
    [status, errorCode, errorMessage, Number.parseInt(connectionId, 10)],
  );
}

function shouldSkipDueToConcurrentRefresh(
  latestToken: StoredOAuthToken | null,
  startedAtMs: number,
): boolean {
  if (!latestToken) return false;
  const issuedAtRaw = latestToken.issued_at ?? latestToken.created_at;
  if (!issuedAtRaw) return false;
  const issuedAtMs = new Date(issuedAtRaw).getTime();
  if (!Number.isFinite(issuedAtMs)) return false;
  return issuedAtMs >= startedAtMs - FRESHNESS_TOLERANCE_MS;
}

export async function oauthRefresh(
  provider: string,
  tenantId?: string,
  input: OAuthRefreshInput = {},
): Promise<OAuthRefreshSuccess | OAuthBrokerError> {
  if (!isAllowedProvider(provider)) {
    return brokerError('invalid_provider', { provider });
  }
  if (!tenantId) {
    return brokerError('missing_required_fields', {
      provider,
      message: 'missing_required_fields:tenant_id',
    });
  }

  const tenant = tenantId.trim();
  const startedAtMs = Date.now();
  const existing = await dbGetConnection({ tenantId: tenant, provider });
  if (!existing) {
    return brokerError('connection_not_found', { provider });
  }

  return withConnectionLock(existing.id, async (client, locked) => {
    const lockedRow: LockedConnectionRow | null = locked;
    const latestToken = await dbGetLatestOAuthToken(existing.id, client);

    if (shouldSkipDueToConcurrentRefresh(latestToken, startedAtMs)) {
      const refreshedAt = nowIso();
      return {
        broker_status: 'ok',
        provider,
        connection_id: existing.id,
        connection_status: 'connected',
        refreshed_at: refreshedAt,
        refreshed: false,
        token_expires_at: latestToken?.expires_at ?? lockedRow?.token_expires_at ?? null,
      } satisfies OAuthRefreshSuccess;
    }

    let providerResult: ProviderRefreshResult;
    try {
      providerResult = await callProviderRefresh(provider, latestToken);
    } catch (error) {
      const refreshError =
        error instanceof ProviderRefreshError
          ? error
          : new ProviderRefreshError('provider_error', error instanceof Error ? error.message : String(error));

      const failureStatus =
        refreshError.kind === 'unauthorized' ? 'reauthorization_required' : 'connected';
      const errorCode =
        refreshError.providerCode ?? refreshError.kind;
      const errorMessage = refreshError.message;

      await updateConnectionAfterFailure(client, existing.id, failureStatus, errorCode, errorMessage);

      await dbAuditEvent({
        tenantId: tenant,
        connectionId: existing.id,
        provider,
        eventType: 'oauth.refresh.failed',
        eventStatus: 'error',
        detail: {
          kind: refreshError.kind,
          http_status: refreshError.httpStatus,
          provider_code: refreshError.providerCode,
          message: errorMessage,
        },
      });

      return brokerError(
        refreshError.kind === 'configuration_error' ? 'provider_unavailable' : 'provider_callback_error',
        { provider, message: errorMessage },
      );
    }

    const refreshedAt = nowIso();
    const tokenExpiresAt =
      providerResult.expiresInSeconds != null
        ? addSeconds(refreshedAt, providerResult.expiresInSeconds)
        : fallbackTtlIso(refreshedAt, input.token_expires_in_seconds);
    const refreshExpiresAt =
      providerResult.refreshExpiresInSeconds != null
        ? addSeconds(refreshedAt, providerResult.refreshExpiresInSeconds)
        : fallbackTtlIso(refreshedAt, input.refresh_expires_in_seconds);

    const inserted = await dbInsertOAuthToken(
      {
        connectionId: existing.id,
        accessToken: providerResult.accessToken,
        refreshToken: providerResult.refreshToken ?? latestToken?.refresh_token ?? null,
        tokenType: providerResult.tokenType ?? latestToken?.token_type ?? null,
        scope: providerResult.scope ?? latestToken?.scope ?? null,
        expiresAt: tokenExpiresAt,
        refreshExpiresAt,
        issuedAt: refreshedAt,
        rotatedFromTokenId: latestToken?.id ?? null,
      },
      client,
    );

    if (latestToken?.id) {
      await dbRevokeOAuthTokenById(latestToken.id, client);
    }

    await updateConnectionAfterSuccess(client, existing.id, tokenExpiresAt, refreshExpiresAt);

    await dbAuditEvent({
      tenantId: tenant,
      connectionId: existing.id,
      provider,
      eventType: 'oauth.refresh.completed',
      eventStatus: 'ok',
      detail: {
        new_token_id: inserted.id,
        rotated_from_token_id: latestToken?.id ?? null,
        token_expires_at: tokenExpiresAt,
        refresh_expires_at: refreshExpiresAt,
      },
    });

    return {
      broker_status: 'ok',
      provider,
      connection_id: existing.id,
      connection_status: 'connected',
      refreshed_at: refreshedAt,
      refreshed: true,
      token_expires_at: tokenExpiresAt,
    } satisfies OAuthRefreshSuccess;
  });
}
