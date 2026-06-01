/**
 * Persistence for end-user connected accounts.
 *
 * SECURITY: this store deliberately has NO column for an access/refresh token.
 * It persists the Composio `connected_account_id` (and auth-config id) — the
 * pointer to the credential Composio holds — never the raw secret itself. See
 * docs/integrations/composio.md "Security notes".
 *
 * Table: connected_accounts (DDL in scripts/init-db.js + a dated migration).
 * The query client is injectable so tests run with no live database.
 */

import pool from '@/lib/db';
import {
  emptyCapabilities,
  type Capabilities,
  type ConnectedAccount,
  type ConnectionStatus,
  type IntegrationPlatform,
  type ProviderKind,
} from '../providers/types';

export interface Queryable {
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

interface ConnectedAccountRow {
  id: string | number;
  tenant_id: string | number;
  external_user_id: string;
  platform: string;
  provider: string;
  connected_account_id: string | null;
  auth_config_id: string | null;
  external_account_id: string | null;
  external_account_name: string | null;
  status: string;
  capabilities_json: unknown;
  last_capability_check_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function parseCapabilities(raw: unknown): Capabilities | null {
  if (!raw) return null;
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (obj && typeof obj === 'object') return obj as Capabilities;
  } catch {
    /* fall through */
  }
  return null;
}

function rowToConnectedAccount(row: ConnectedAccountRow): ConnectedAccount {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    externalUserId: row.external_user_id,
    platform: row.platform as IntegrationPlatform,
    provider: row.provider as ProviderKind,
    connectedAccountId: row.connected_account_id,
    authConfigId: row.auth_config_id,
    externalAccountId: row.external_account_id,
    externalAccountName: row.external_account_name,
    status: row.status as ConnectionStatus,
    capabilities: parseCapabilities(row.capabilities_json),
    lastCapabilityCheckAt: toIso(row.last_capability_check_at),
    createdAt: toIso(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: toIso(row.updated_at) ?? new Date(0).toISOString(),
  };
}

export interface UpsertConnectionInput {
  tenantId: string;
  externalUserId: string;
  platform: IntegrationPlatform;
  provider: ProviderKind;
  connectedAccountId?: string | null;
  authConfigId?: string | null;
  externalAccountId?: string | null;
  externalAccountName?: string | null;
  status: ConnectionStatus;
}

export async function upsertConnection(
  input: UpsertConnectionInput,
  db: Queryable = pool,
): Promise<ConnectedAccount> {
  const result = await db.query<ConnectedAccountRow>(
    `INSERT INTO connected_accounts
       (tenant_id, external_user_id, platform, provider, connected_account_id,
        auth_config_id, external_account_id, external_account_name, status, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
     ON CONFLICT (tenant_id, platform) DO UPDATE SET
       external_user_id = EXCLUDED.external_user_id,
       provider = EXCLUDED.provider,
       connected_account_id = EXCLUDED.connected_account_id,
       auth_config_id = EXCLUDED.auth_config_id,
       external_account_id = COALESCE(EXCLUDED.external_account_id, connected_accounts.external_account_id),
       external_account_name = COALESCE(EXCLUDED.external_account_name, connected_accounts.external_account_name),
       status = EXCLUDED.status,
       updated_at = NOW()
     RETURNING *`,
    [
      input.tenantId,
      input.externalUserId,
      input.platform,
      input.provider,
      input.connectedAccountId ?? null,
      input.authConfigId ?? null,
      input.externalAccountId ?? null,
      input.externalAccountName ?? null,
      input.status,
    ],
  );
  return rowToConnectedAccount(result.rows[0]);
}

export async function getConnectionRow(
  tenantId: string,
  platform: IntegrationPlatform,
  db: Queryable = pool,
): Promise<ConnectedAccount | null> {
  const result = await db.query<ConnectedAccountRow>(
    `SELECT * FROM connected_accounts WHERE tenant_id = $1 AND platform = $2 LIMIT 1`,
    [tenantId, platform],
  );
  const row = result.rows[0];
  return row ? rowToConnectedAccount(row) : null;
}

export async function listConnectionRows(
  tenantId: string,
  db: Queryable = pool,
): Promise<ConnectedAccount[]> {
  const result = await db.query<ConnectedAccountRow>(
    `SELECT * FROM connected_accounts WHERE tenant_id = $1 ORDER BY platform ASC`,
    [tenantId],
  );
  return result.rows.map(rowToConnectedAccount);
}

export async function updateConnectionStatus(
  tenantId: string,
  platform: IntegrationPlatform,
  status: ConnectionStatus,
  db: Queryable = pool,
): Promise<void> {
  await db.query(
    `UPDATE connected_accounts SET status = $3, updated_at = NOW()
     WHERE tenant_id = $1 AND platform = $2`,
    [tenantId, platform, status],
  );
}

export async function saveCapabilities(
  tenantId: string,
  platform: IntegrationPlatform,
  capabilities: Capabilities,
  db: Queryable = pool,
): Promise<void> {
  await db.query(
    `UPDATE connected_accounts
       SET capabilities_json = $3::jsonb, last_capability_check_at = NOW(), updated_at = NOW()
     WHERE tenant_id = $1 AND platform = $2`,
    [tenantId, platform, JSON.stringify(capabilities)],
  );
}

export async function deleteConnectionRow(
  tenantId: string,
  platform: IntegrationPlatform,
  db: Queryable = pool,
): Promise<{ connectedAccountId: string | null; deleted: boolean }> {
  const result = await db.query<{ connected_account_id: string | null }>(
    `DELETE FROM connected_accounts WHERE tenant_id = $1 AND platform = $2
     RETURNING connected_account_id`,
    [tenantId, platform],
  );
  const row = result.rows[0];
  return { connectedAccountId: row?.connected_account_id ?? null, deleted: (result.rowCount ?? 0) > 0 };
}

/** A "not connected" placeholder used by the UI/list when no row exists. */
export function notConnectedAccount(
  tenantId: string,
  externalUserId: string,
  platform: IntegrationPlatform,
  provider: ProviderKind,
): ConnectedAccount {
  const now = new Date(0).toISOString();
  return {
    id: `${platform}:not_connected`,
    tenantId,
    externalUserId,
    platform,
    provider,
    connectedAccountId: null,
    authConfigId: null,
    externalAccountId: null,
    externalAccountName: null,
    status: 'not_connected',
    capabilities: emptyCapabilities(provider),
    lastCapabilityCheckAt: null,
    createdAt: now,
    updatedAt: now,
  };
}
