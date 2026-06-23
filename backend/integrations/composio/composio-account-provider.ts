/**
 * Composio AccountConnectionProvider — the end-user connect/list/disconnect
 * lifecycle. Persists only the Composio connected-account id (never tokens).
 *
 * Connection flow:
 *   1. createConnectLink -> gateway.initiateConnection -> persist a `pending`
 *      row (connected_account_id null) and return the redirect URL.
 *   2. User approves at the platform; Composio activates the connection.
 *   3. refreshConnectionStatus reconciles: it lists the user's Composio
 *      connections for this auth config, picks the ACTIVE one, and stores its
 *      connected_account_id + external account details.
 */

import type { AccountConnectionProvider } from '../providers/interfaces';
import type {
  ConnectLinkResult,
  ConnectedAccount,
  IntegrationPlatform,
  RequestedCapability,
} from '../providers/types';
import type { ComposioConfig } from './composio-config';
import type { ComposioGateway, GatewayConnection } from './composio-client';
import {
  deleteConnectionRow,
  getConnectionRow,
  listConnectionRows,
  notConnectedAccount,
  upsertConnection,
  type Queryable,
} from './connection-store';
import { ComposioConfigError, ComposioError } from './errors';
import { isActiveStatus, mapComposioStatus } from './status-map';
import { resolveFacebookManagedPage } from './facebook-page-resolver';
import { resolveLinkedInAuthorUrn } from './linkedin-author-resolver';
import { isLinkedInEnabled } from '../providers/integration-config';
import pool from '@/lib/db';

// Genuinely no Composio-managed shared credentials → operator must register a
// custom OAuth app. Today only X/twitter. (Reddit HAS managed auth.)
const CUSTOM_OAUTH_PLATFORMS: ReadonlySet<IntegrationPlatform> = new Set(['x']);

export class ComposioAccountProvider implements AccountConnectionProvider {
  readonly kind = 'composio' as const;

  constructor(
    private readonly gateway: ComposioGateway,
    private readonly config: ComposioConfig,
    private readonly db: Queryable = pool,
  ) {}

  private requireTenant(options?: { tenantId: string }): string {
    if (!options?.tenantId) {
      throw new ComposioConfigError('A tenantId is required for Composio connection operations.');
    }
    return options.tenantId;
  }

  async createConnectLink(
    externalUserId: string,
    platform: IntegrationPlatform,
    _requestedCapability: RequestedCapability,
    options?: { tenantId: string; callbackUrl?: string },
  ): Promise<ConnectLinkResult> {
    const tenantId = this.requireTenant(options);
    // Prefer an explicitly-configured auth config; otherwise auto-provision a
    // Composio-managed one for the toolkit so connecting works with zero
    // dashboard setup (just the API key).
    let authConfigId = this.config.authConfigIdFor(platform);
    if (!authConfigId) {
      try {
        authConfigId = await this.gateway.findOrCreateManagedAuthConfig(this.config.toolkitSlugFor(platform));
      } catch {
        // Throw a frontend-safe, actionable error — never leak the raw SDK error text.
        const envKey = `COMPOSIO_${platform.toUpperCase()}_AUTH_CONFIG_ID`;
        if (CUSTOM_OAUTH_PLATFORMS.has(platform)) {
          // X/twitter has no Composio-managed shared credentials; operator must
          // register a custom OAuth app and supply the auth-config id.
          throw new ComposioConfigError(
            `${platform} requires a custom OAuth app and is not configured for Composio-managed credentials. ` +
              `Set ${envKey} to the Composio auth-config id for this platform.`,
          );
        }
        // Reddit and other platforms with Composio-managed auth: provisioning
        // failed transiently. Signal a retryable error; name the env var only as
        // an explicit override, not as a required step.
        throw new ComposioConfigError(
          `Could not provision Composio-managed auth for ${platform}. ` +
            `Please retry; if this persists, set ${envKey} to an explicit Composio auth-config id.`,
        );
      }
    }

    const initiated = await this.gateway.initiateConnection(externalUserId, authConfigId, options?.callbackUrl);

    await upsertConnection(
      {
        tenantId,
        externalUserId,
        platform,
        provider: 'composio',
        connectedAccountId: null,
        authConfigId,
        status: 'pending',
      },
      this.db,
    );

    return {
      provider: 'composio',
      platform,
      connectUrl: initiated.redirectUrl ?? '',
      connectionRequestId: initiated.connectionRequestId,
    };
  }

  async listConnections(externalUserId: string, options?: { tenantId: string }): Promise<ConnectedAccount[]> {
    const tenantId = this.requireTenant(options);
    return listConnectionRows(tenantId, this.db);
  }

  async getConnection(
    externalUserId: string,
    platform: IntegrationPlatform,
    options?: { tenantId: string },
  ): Promise<ConnectedAccount | null> {
    const tenantId = this.requireTenant(options);
    return getConnectionRow(tenantId, platform, this.db);
  }

  async disconnectConnection(
    externalUserId: string,
    platform: IntegrationPlatform,
    options?: { tenantId: string },
  ): Promise<{ disconnected: boolean }> {
    const tenantId = this.requireTenant(options);
    const existing = await getConnectionRow(tenantId, platform, this.db);
    if (existing?.connectedAccountId) {
      try {
        await this.gateway.deleteConnection(existing.connectedAccountId);
      } catch {
        // Best-effort revoke at Composio; we still drop the local row so the
        // user is not stuck "connected" to something Aries can't use.
      }
    }
    const { deleted } = await deleteConnectionRow(tenantId, platform, this.db);
    return { disconnected: deleted };
  }

  async refreshConnectionStatus(
    externalUserId: string,
    platform: IntegrationPlatform,
    options?: { tenantId: string },
  ): Promise<ConnectedAccount | null> {
    const tenantId = this.requireTenant(options);
    const authConfigId = this.config.authConfigIdFor(platform);

    // Find the user's Composio connections for this platform's auth config and
    // prefer an ACTIVE one. This reconciles a pending connection once the user
    // has completed the OAuth approval out-of-band.
    let connections: GatewayConnection[] = [];
    try {
      connections = await this.gateway.listConnections({
        userIds: [externalUserId],
        authConfigIds: authConfigId ? [authConfigId] : undefined,
      });
    } catch {
      // Could not reach Composio to confirm the live status. Surface a
      // frontend-safe error (NEVER the raw SDK text) instead of silently
      // returning the stored `pending` row — that swallowing is exactly what
      // stranded an ACTIVE connection as pending (#699). The caller turns this
      // into a per-platform advisory and still returns 200.
      throw new ComposioError(
        'composio_reconcile_failed',
        'Could not reach Composio to confirm this connection. Please try again.',
        { status: 502, retryable: true },
      );
    }

    // When several platforms share COMPOSIO_DEFAULT_AUTH_CONFIG_ID the
    // auth-config filter returns connections for ALL of them, so narrow to this
    // platform's toolkit before picking — otherwise we could persist another
    // platform's connected-account id onto this row.
    const expectedSlug = this.config.toolkitSlugFor(platform);
    const slugMatched = connections.filter((c) => c.toolkitSlug === expectedSlug);

    // A Composio auth config is toolkit-bound, so a non-null id that is NOT the
    // shared COMPOSIO_DEFAULT_AUTH_CONFIG_ID already returns only this platform's
    // connections — an exact-slug mismatch (e.g. 'instagram_business' vs the
    // hard-coded 'instagram') must not strand an ACTIVE connection as pending
    // (#699). When platforms share the default we cannot disambiguate by slug, so
    // we keep the conservative empty set. If no connection reports a toolkit slug
    // (older payloads), fall back to the unfiltered set.
    const defaultAuthConfigId = this.config.defaultAuthConfigId();
    const platformScoped = authConfigId !== null && authConfigId !== defaultAuthConfigId;

    const candidates =
      slugMatched.length > 0
        ? slugMatched
        : platformScoped
          ? connections
          : connections.some((c) => c.toolkitSlug)
            ? []
            : connections;

    const active = candidates.find((c) => isActiveStatus(c.status)) ?? candidates[0];
    if (!active) {
      return getConnectionRow(tenantId, platform, this.db) ?? notConnectedAccount(tenantId, externalUserId, platform, 'composio');
    }

    // The Facebook Page id is not part of the connection metadata, so
    // active.externalAccountId is usually null for FB. Resolve + capture it here
    // so future connections store the Page id at connect time (the bridge's
    // back-heal then only covers legacy rows). Best-effort: a failure leaves it
    // null and the bridge resolves it later.
    let externalAccountId = active.externalAccountId;
    let externalAccountName = active.externalAccountName;
    if (!externalAccountId && platform === 'facebook' && active.id && isActiveStatus(active.status)) {
      try {
        const page = await resolveFacebookManagedPage(this.gateway, this.config, active.id);
        if (page) {
          externalAccountId = page.pageId;
          externalAccountName = externalAccountName ?? page.pageName;
        }
      } catch {
        // best-effort — leave null, the sync bridge will back-heal it
      }
    } else if (
      // LinkedIn's member person URN is likewise absent from the connection
      // metadata. Resolve it via LINKEDIN_GET_MY_INFO and store the FULL
      // `urn:li:person:<id>` so the publisher (#646) reads it straight into
      // `author`. Gated by ARIES_LINKEDIN_ENABLED (default OFF → no executeTool
      // call, connect byte-identical). Best-effort: a 429 throttle / empty
      // payload leaves it null and never breaks connect.
      !externalAccountId &&
      platform === 'linkedin' &&
      isLinkedInEnabled() &&
      active.id &&
      isActiveStatus(active.status)
    ) {
      try {
        const author = await resolveLinkedInAuthorUrn(this.gateway, this.config, active.id);
        if (author) {
          externalAccountId = author.urn;
          externalAccountName = externalAccountName ?? author.name;
        }
      } catch {
        // best-effort — leave null, never break connect
      }
    }

    return upsertConnection(
      {
        tenantId,
        externalUserId,
        platform,
        provider: 'composio',
        connectedAccountId: active.id,
        authConfigId: active.authConfigId ?? authConfigId ?? null,
        externalAccountId,
        externalAccountName,
        status: mapComposioStatus(active.status),
      },
      this.db,
    );
  }
}
