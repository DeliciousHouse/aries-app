/**
 * Minimal ambient type shim for the optional `@composio/core` dependency.
 *
 * The Composio adapter loads `@composio/core` LAZILY and only when Composio is
 * enabled, so the package is an optional dependency that need not be installed
 * for the rest of Aries to typecheck/build/run. This declaration covers exactly
 * the surface the adapter uses (verified against the official TS SDK docs):
 *   - new Composio({ apiKey })
 *   - composio.connectedAccounts.{initiate,list,get,delete,waitForConnection}
 *   - composio.tools.execute(slug, { userId, connectedAccountId, arguments })
 *
 * If the real package is installed, its own (richer) types take precedence at
 * the point of import in composio-client.ts, which casts through this shim.
 */
declare module '@composio/core' {
  export type ComposioConnectionStatus =
    | 'ACTIVE'
    | 'INITIATED'
    | 'EXPIRED'
    | 'FAILED'
    | 'INACTIVE';

  export interface ComposioConnectedAccountModel {
    id: string;
    status: ComposioConnectionStatus | string;
    statusReason?: string | null;
    authConfig?: { id?: string } | null;
    toolkit?: { slug?: string } | null;
    data?: Record<string, unknown> | null;
    meta?: Record<string, unknown> | null;
  }

  export interface ComposioConnectionRequest {
    id: string;
    redirectUrl?: string | null;
    waitForConnection(timeoutMs?: number): Promise<ComposioConnectedAccountModel>;
  }

  export interface ComposioListResult {
    items: ComposioConnectedAccountModel[];
  }

  export interface ComposioToolExecuteResult {
    data?: unknown;
    successful?: boolean;
    error?: string | null;
  }

  export class Composio {
    constructor(options: { apiKey: string; toolkitVersions?: Record<string, string> });
    connectedAccounts: {
      initiate(
        userId: string,
        authConfigId: string,
        options?: { callbackUrl?: string; allowMultiple?: boolean; data?: Record<string, unknown> },
      ): Promise<ComposioConnectionRequest>;
      list(filter?: {
        userIds?: string[];
        authConfigIds?: string[];
        statuses?: string[];
      }): Promise<ComposioListResult>;
      get(connectedAccountId: string): Promise<ComposioConnectedAccountModel>;
      delete(connectedAccountId: string): Promise<unknown>;
      waitForConnection(connectionRequestId: string, timeoutMs?: number): Promise<ComposioConnectedAccountModel>;
    };
    tools: {
      execute(
        slug: string,
        options: { userId?: string; connectedAccountId?: string; arguments?: Record<string, unknown> },
      ): Promise<ComposioToolExecuteResult>;
    };
  }
}
