/**
 * Composio gateway — the single seam between the adapter and the @composio/core
 * SDK. Everything the adapter needs from Composio goes through this interface,
 * so providers depend on a small, mockable surface (tests inject a fake gateway)
 * and the real SDK is loaded LAZILY, only when Composio is actually used.
 *
 * Verified SDK surface (https://docs.composio.dev — TypeScript SDK):
 *   new Composio({ apiKey })
 *   composio.connectedAccounts.initiate(userId, authConfigId, { callbackUrl })
 *     -> { id, redirectUrl, waitForConnection() }
 *   composio.connectedAccounts.list({ userIds, authConfigIds }) -> { items }
 *   composio.connectedAccounts.get(id) / .delete(id) / .waitForConnection(id, ms)
 *   composio.tools.execute(slug, { userId, connectedAccountId, arguments })
 */

import type { ComposioConfig } from './composio-config';
import { ComposioConfigError, ComposioSdkMissingError } from './errors';

export interface GatewayConnection {
  id: string;
  status: string;
  statusReason: string | null;
  authConfigId: string | null;
  toolkitSlug: string | null;
  externalAccountId: string | null;
  externalAccountName: string | null;
  raw: unknown;
}

export interface GatewayInitiateResult {
  connectionRequestId: string;
  redirectUrl: string | null;
}

export interface GatewayToolResult {
  data: unknown;
  successful: boolean;
  error: string | null;
}

export interface ComposioGateway {
  initiateConnection(
    userId: string,
    authConfigId: string,
    callbackUrl?: string,
  ): Promise<GatewayInitiateResult>;
  listConnections(filter: {
    userIds?: string[];
    authConfigIds?: string[];
  }): Promise<GatewayConnection[]>;
  getConnection(connectedAccountId: string): Promise<GatewayConnection | null>;
  deleteConnection(connectedAccountId: string): Promise<void>;
  executeTool(
    slug: string,
    options: { userId?: string; connectedAccountId?: string; arguments?: Record<string, unknown> },
  ): Promise<GatewayToolResult>;
}

// --- helpers to normalize the loosely-typed SDK model -----------------------

function pickExternalAccountId(data: Record<string, unknown> | null | undefined): string | null {
  if (!data) return null;
  for (const key of ['external_account_id', 'externalAccountId', 'account_id', 'id']) {
    const v = data[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function pickExternalAccountName(data: Record<string, unknown> | null | undefined): string | null {
  if (!data) return null;
  for (const key of ['name', 'account_name', 'username', 'page_name']) {
    const v = data[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function toGatewayConnection(model: {
  id: string;
  status: string;
  statusReason?: string | null;
  authConfig?: { id?: string } | null;
  toolkit?: { slug?: string } | null;
  data?: Record<string, unknown> | null;
  meta?: Record<string, unknown> | null;
}): GatewayConnection {
  const data = model.data ?? model.meta ?? null;
  return {
    id: model.id,
    status: String(model.status ?? '').toUpperCase(),
    statusReason: model.statusReason ?? null,
    authConfigId: model.authConfig?.id ?? null,
    toolkitSlug: model.toolkit?.slug ?? null,
    externalAccountId: pickExternalAccountId(data),
    externalAccountName: pickExternalAccountName(data),
    raw: model,
  };
}

/**
 * The real gateway backed by @composio/core, loaded lazily so the package is
 * only required when Composio is enabled AND selected.
 */
class LiveComposioGateway implements ComposioGateway {
  private clientPromise: Promise<import('@composio/core').Composio> | null = null;

  constructor(private readonly config: ComposioConfig) {}

  private async client(): Promise<import('@composio/core').Composio> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        let mod: typeof import('@composio/core');
        try {
          mod = await import('@composio/core');
        } catch {
          throw new ComposioSdkMissingError();
        }
        return new mod.Composio({ apiKey: this.config.apiKey });
      })();
    }
    return this.clientPromise;
  }

  async initiateConnection(userId: string, authConfigId: string, callbackUrl?: string): Promise<GatewayInitiateResult> {
    const composio = await this.client();
    const req = await composio.connectedAccounts.initiate(
      userId,
      authConfigId,
      callbackUrl ? { callbackUrl } : undefined,
    );
    return { connectionRequestId: req.id, redirectUrl: req.redirectUrl ?? null };
  }

  async listConnections(filter: {
    userIds?: string[];
    authConfigIds?: string[];
  }): Promise<GatewayConnection[]> {
    const composio = await this.client();
    const result = await composio.connectedAccounts.list({
      userIds: filter.userIds,
      authConfigIds: filter.authConfigIds,
    });
    return (result.items ?? []).map(toGatewayConnection);
  }

  async getConnection(connectedAccountId: string): Promise<GatewayConnection | null> {
    const composio = await this.client();
    try {
      const model = await composio.connectedAccounts.get(connectedAccountId);
      return model ? toGatewayConnection(model) : null;
    } catch {
      return null;
    }
  }

  async deleteConnection(connectedAccountId: string): Promise<void> {
    const composio = await this.client();
    await composio.connectedAccounts.delete(connectedAccountId);
  }

  async executeTool(
    slug: string,
    options: { userId?: string; connectedAccountId?: string; arguments?: Record<string, unknown> },
  ): Promise<GatewayToolResult> {
    const composio = await this.client();
    const result = await composio.tools.execute(slug, options);
    return {
      data: result.data ?? null,
      successful: result.successful !== false,
      error: result.error ?? null,
    };
  }
}

export function createComposioGateway(config: ComposioConfig | null): ComposioGateway {
  if (!config) {
    throw new ComposioConfigError('Composio is enabled but COMPOSIO_API_KEY is not set.');
  }
  return new LiveComposioGateway(config);
}

export { toGatewayConnection };
