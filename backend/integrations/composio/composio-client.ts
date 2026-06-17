/**
 * Composio gateway — the single seam between the adapter and the @composio/core
 * SDK. Everything the adapter needs from Composio goes through this interface,
 * so providers depend on a small, mockable surface (tests inject a fake gateway)
 * and the real SDK is loaded LAZILY, only when Composio is actually used.
 *
 * Verified SDK surface (https://docs.composio.dev — TypeScript SDK):
 *   new Composio({ apiKey })
 *   composio.connectedAccounts.link(userId, authConfigId, { callbackUrl })
 *     -> { id, redirectUrl } (the modern hosted-auth method; initiate() is retired)
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
  /**
   * Find an existing Composio-managed auth config for a toolkit, or create one.
   * Lets the connect flow work without anyone hand-creating an auth config in
   * the dashboard. Returns the `ac_...` id.
   */
  findOrCreateManagedAuthConfig(toolkitSlug: string): Promise<string>;
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

export interface ToolExecuteInput {
  userId?: string;
  connectedAccountId?: string;
  arguments?: Record<string, unknown>;
}

/**
 * Build the params object handed to `composio.tools.execute`. The @composio/core
 * SDK requires a toolkit version for manual (by-slug) execution: an unset or
 * "latest" version throws ComposioToolVersionRequiredError unless the version
 * check is skipped. We therefore always pass an explicit `version` and, when it
 * is "latest" (the default), `dangerouslySkipVersionCheck: true`. A concrete
 * pinned version (e.g. "20250909_00") is passed as-is with NO skip flag.
 *
 * Exported so the gateway test asserts the exact arg the real client receives.
 */
export function buildToolExecuteOptions(
  options: ToolExecuteInput,
  toolkitVersion?: string,
): ToolExecuteInput & { version: string; dangerouslySkipVersionCheck?: boolean } {
  const version = (toolkitVersion?.trim() || 'latest');
  const params: ToolExecuteInput & { version: string; dangerouslySkipVersionCheck?: boolean } = {
    ...options,
    version,
  };
  if (version.toLowerCase() === 'latest') {
    params.dangerouslySkipVersionCheck = true;
  }
  return params;
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
export class LiveComposioGateway implements ComposioGateway {
  private clientPromise: Promise<import('@composio/core').Composio> | null = null;

  /**
   * @param clientFactory test-only seam to inject a fake @composio/core client.
   *   Production leaves it undefined and the real SDK is lazy-imported.
   */
  constructor(
    private readonly config: ComposioConfig,
    private readonly clientFactory?: () => Promise<import('@composio/core').Composio>,
  ) {}

  private async client(): Promise<import('@composio/core').Composio> {
    if (!this.clientPromise) {
      this.clientPromise = this.clientFactory
        ? this.clientFactory()
        : (async () => {
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

  async findOrCreateManagedAuthConfig(toolkitSlug: string): Promise<string> {
    const composio = await this.client();
    const toolkit = toolkitSlug.toUpperCase();
    // Reuse an existing auth config for this toolkit when one is already present.
    try {
      const existing = (await composio.authConfigs.list({ toolkit, isComposioManaged: true })) as unknown as {
        items?: Array<{ id?: string }>;
      };
      const found = existing?.items?.find((c) => typeof c?.id === 'string' && c.id);
      if (found?.id) return found.id;
    } catch {
      // listing is best-effort; fall through to create
    }
    const created = (await composio.authConfigs.create(toolkit, {
      name: `Aries ${toolkit} (managed)`,
      type: 'use_composio_managed_auth',
    })) as unknown as { id?: string };
    if (!created?.id) {
      throw new ComposioConfigError(`Composio did not return an auth config id when provisioning managed auth for ${toolkit}.`);
    }
    return created.id;
  }

  async initiateConnection(userId: string, authConfigId: string, callbackUrl?: string): Promise<GatewayInitiateResult> {
    const composio = await this.client();
    // Use `link()`, not the retired `initiate()`: initiate() returns 400 for
    // Composio-managed OAuth as of 2026-05-08. `link()` is the modern hosted-auth
    // method (managed + custom auth configs), same shape:
    // link(userId, authConfigId, { callbackUrl }) -> { id, redirectUrl }.
    const req = await composio.connectedAccounts.link(
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
    // Always pass the toolkit version — the SDK rejects manual execution without
    // one ("Toolkit version not specified ..."). buildToolExecuteOptions defaults
    // to 'latest' + dangerouslySkipVersionCheck.
    const result = await composio.tools.execute(slug, buildToolExecuteOptions(options, this.config.toolkitVersion));
    return {
      data: result.data ?? null,
      successful: result.successful !== false,
      error: result.error ?? null,
    };
  }
}

export function createComposioGateway(
  config: ComposioConfig | null,
  clientFactory?: () => Promise<import('@composio/core').Composio>,
): ComposioGateway {
  if (!config) {
    throw new ComposioConfigError('Composio is enabled but COMPOSIO_API_KEY is not set.');
  }
  return new LiveComposioGateway(config, clientFactory);
}

export { toGatewayConnection };
