/**
 * Shared test doubles for the Composio adapter tests. No network, no database.
 */

import type { ComposioConfig, ComposioOperation } from '@/backend/integrations/composio/composio-config';
import type { ComposioGateway, GatewayConnection, GatewayInitiateResult, GatewayToolResult } from '@/backend/integrations/composio/composio-client';
import type { Queryable } from '@/backend/integrations/composio/connection-store';
import type { IntegrationPlatform } from '@/backend/integrations/providers/types';

export interface RecordedExecute {
  slug: string;
  options: { userId?: string; connectedAccountId?: string; arguments?: Record<string, unknown> };
}

export function fakeConfig(overrides?: {
  actions?: Partial<Record<ComposioOperation, string>>;
  authConfigId?: string | null;
  defaultAuthConfigId?: string | null;
}): ComposioConfig {
  const actions = overrides?.actions ?? {};
  const hasAuthOverride = overrides ? Object.prototype.hasOwnProperty.call(overrides, 'authConfigId') : false;
  return {
    apiKey: 'test-key',
    authConfigIdFor: () => (hasAuthOverride ? (overrides!.authConfigId ?? null) : 'auth_cfg_test'),
    toolkitSlugFor: (p: IntegrationPlatform) => p,
    actionSlugFor: (_p: IntegrationPlatform, op: ComposioOperation) => actions[op] ?? null,
    defaultAuthConfigId: () => overrides?.defaultAuthConfigId ?? null,
  };
}

export function fakeGateway(opts?: {
  executeResult?: GatewayToolResult;
  connections?: GatewayConnection[];
  onExecute?: (rec: RecordedExecute) => void;
}): ComposioGateway & { calls: RecordedExecute[] } {
  const calls: RecordedExecute[] = [];
  return {
    calls,
    async findOrCreateManagedAuthConfig(toolkitSlug: string): Promise<string> {
      return `ac_${toolkitSlug.toLowerCase()}`;
    },
    async initiateConnection(): Promise<GatewayInitiateResult> {
      return { connectionRequestId: 'cr_1', redirectUrl: 'https://composio.dev/connect/abc' };
    },
    async listConnections() {
      return opts?.connections ?? [];
    },
    async getConnection() {
      return opts?.connections?.[0] ?? null;
    },
    async deleteConnection() {
      /* no-op */
    },
    async executeTool(slug, options) {
      const rec = { slug, options };
      calls.push(rec);
      opts?.onExecute?.(rec);
      return opts?.executeResult ?? { data: {}, successful: true, error: null };
    },
    async uploadFile(input) {
      return { name: 'staged.jpg', mimetype: 'image/jpeg', s3key: `s3/${input.toolSlug}/staged.jpg` };
    },
  };
}

export interface RecordedQuery {
  text: string;
  params: unknown[];
}

/**
 * A fake Queryable. SELECTs return the provided connection row(s); writes are
 * captured for assertions. Pass `connectedRow: false` to simulate "no row".
 */
export function fakeDb(opts?: {
  connectionRow?: Record<string, unknown> | null;
}): Queryable & { queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  const row =
    opts?.connectionRow === undefined
      ? {
          id: 1,
          tenant_id: 42,
          external_user_id: 'aries-tenant-42',
          platform: 'facebook',
          provider: 'composio',
          connected_account_id: 'ca_123',
          auth_config_id: 'auth_cfg_test',
          external_account_id: 'ext_1',
          external_account_name: 'Test Page',
          status: 'connected',
          capabilities_json: null,
          last_capability_check_at: null,
          created_at: new Date(0),
          updated_at: new Date(0),
        }
      : opts.connectionRow;

  return {
    queries,
    async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
      queries.push({ text, params });
      const isSelect = /^\s*select/i.test(text);
      const isReturning = /returning/i.test(text);
      if (isSelect) {
        return { rows: (row ? [row] : []) as T[], rowCount: row ? 1 : 0 };
      }
      if (isReturning) {
        return { rows: (row ? [row] : []) as T[], rowCount: row ? 1 : 0 };
      }
      return { rows: [] as T[], rowCount: 0 };
    },
  };
}
