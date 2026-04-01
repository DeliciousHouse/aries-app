import pool from '@/lib/db';

export type DbProvider = 'facebook' | 'instagram' | 'linkedin' | 'x' | 'youtube' | 'reddit' | 'tiktok';
export type DbConnectionStatus = 'pending' | 'connected' | 'reauthorization_required' | 'disconnected' | 'error';

export type DbConnectionRow = {
  id: string;
  tenant_id: string;
  provider: DbProvider;
  status: DbConnectionStatus;
  granted_scopes: string[];
  token_expires_at: string | null;
  refresh_expires_at: string | null;
  connected_at: string | null;
  disconnected_at: string | null;
  external_account_id: string | null;
  external_account_name: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: string;
  updated_at: string;
};

export type DbPendingStateRow = {
  state: string;
  tenant_id: string;
  provider: DbProvider;
  redirect_uri: string;
  scopes: string[];
  connection_id: string | null;
  expires_at: string;
  created_at: string;
};

function toTenantIdInt(tenantId: string): number {
  const parsed = Number.parseInt(String(tenantId).trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('validation_error:tenant_id');
  }
  return parsed;
}

function normalizeScopes(scopes: string[]): string[] {
  const clean = scopes.map((s) => s.trim()).filter((s) => s.length > 0);
  return Array.from(new Set(clean));
}

export async function dbUpsertConnection(args: {
  tenantId: string;
  provider: DbProvider;
  status: DbConnectionStatus;
  grantedScopes: string[];
  tokenExpiresAt?: string | null;
  refreshExpiresAt?: string | null;
  connectedAt?: string | null;
  disconnectedAt?: string | null;
  externalAccountId?: string | null;
  externalAccountName?: string | null;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
}): Promise<DbConnectionRow> {
  const tenantIdInt = toTenantIdInt(args.tenantId);
  const grantedScopes = normalizeScopes(args.grantedScopes);
  const result = await pool.query(
    `
      INSERT INTO oauth_connections (
        tenant_id,
        provider,
        status,
        granted_scopes,
        token_expires_at,
        refresh_expires_at,
        connected_at,
        disconnected_at,
        external_account_id,
        external_account_name,
        last_error_code,
        last_error_message,
        created_at,
        updated_at
      )
      VALUES (
        $1, $2, $3, $4,
        $5, $6, $7, $8,
        $9, $10, $11, $12,
        now(), now()
      )
      ON CONFLICT (tenant_id, provider)
      DO UPDATE SET
        status = EXCLUDED.status,
        granted_scopes = EXCLUDED.granted_scopes,
        token_expires_at = COALESCE(EXCLUDED.token_expires_at, oauth_connections.token_expires_at),
        refresh_expires_at = COALESCE(EXCLUDED.refresh_expires_at, oauth_connections.refresh_expires_at),
        connected_at = COALESCE(EXCLUDED.connected_at, oauth_connections.connected_at),
        disconnected_at = EXCLUDED.disconnected_at,
        external_account_id = COALESCE(EXCLUDED.external_account_id, oauth_connections.external_account_id),
        external_account_name = COALESCE(EXCLUDED.external_account_name, oauth_connections.external_account_name),
        last_error_code = EXCLUDED.last_error_code,
        last_error_message = EXCLUDED.last_error_message,
        updated_at = now()
      RETURNING
        id::text,
        tenant_id::text,
        provider,
        status,
        granted_scopes,
        token_expires_at,
        refresh_expires_at,
        connected_at,
        disconnected_at,
        external_account_id,
        external_account_name,
        last_error_code,
        last_error_message,
        created_at,
        updated_at
    `,
    [
      tenantIdInt,
      args.provider,
      args.status,
      grantedScopes,
      args.tokenExpiresAt ?? null,
      args.refreshExpiresAt ?? null,
      args.connectedAt ?? null,
      args.disconnectedAt ?? null,
      args.externalAccountId ?? null,
      args.externalAccountName ?? null,
      args.lastErrorCode ?? null,
      args.lastErrorMessage ?? null,
    ],
  );
  return result.rows[0] as DbConnectionRow;
}

export async function dbGetConnection(args: { tenantId: string; provider: DbProvider }): Promise<DbConnectionRow | null> {
  const tenantIdInt = toTenantIdInt(args.tenantId);
  const result = await pool.query(
    `
      SELECT
        id::text,
        tenant_id::text,
        provider,
        status,
        granted_scopes,
        token_expires_at,
        refresh_expires_at,
        connected_at,
        disconnected_at,
        external_account_id,
        external_account_name,
        last_error_code,
        last_error_message,
        created_at,
        updated_at
      FROM oauth_connections
      WHERE tenant_id = $1 AND provider = $2
      LIMIT 1
    `,
    [tenantIdInt, args.provider],
  );
  return (result.rows[0] as DbConnectionRow | undefined) ?? null;
}

export async function dbGetConnectionById(connectionId: string): Promise<DbConnectionRow | null> {
  const idInt = Number.parseInt(String(connectionId).trim(), 10);
  if (!Number.isFinite(idInt) || idInt <= 0) {
    return null;
  }
  const result = await pool.query(
    `
      SELECT
        id::text,
        tenant_id::text,
        provider,
        status,
        granted_scopes,
        token_expires_at,
        refresh_expires_at,
        connected_at,
        disconnected_at,
        external_account_id,
        external_account_name,
        last_error_code,
        last_error_message,
        created_at,
        updated_at
      FROM oauth_connections
      WHERE id = $1
      LIMIT 1
    `,
    [idInt],
  );
  return (result.rows[0] as DbConnectionRow | undefined) ?? null;
}

export async function dbInsertPendingState(args: {
  state: string;
  tenantId: string;
  provider: DbProvider;
  redirectUri: string;
  scopes: string[];
  connectionId?: string | null;
  expiresAt: string;
}): Promise<DbPendingStateRow> {
  const tenantIdInt = toTenantIdInt(args.tenantId);
  const scopes = normalizeScopes(args.scopes);
  const result = await pool.query(
    `
      INSERT INTO oauth_pending_states (
        state,
        tenant_id,
        provider,
        redirect_uri,
        scopes,
        connection_id,
        expires_at,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, now())
      RETURNING
        state,
        tenant_id::text,
        provider,
        redirect_uri,
        scopes,
        connection_id::text,
        expires_at,
        created_at
    `,
    [args.state, tenantIdInt, args.provider, args.redirectUri, scopes, args.connectionId ?? null, args.expiresAt],
  );
  return result.rows[0] as DbPendingStateRow;
}

export async function dbGetPendingState(state: string): Promise<DbPendingStateRow | null> {
  const result = await pool.query(
    `
      SELECT
        state,
        tenant_id::text,
        provider,
        redirect_uri,
        scopes,
        connection_id::text,
        expires_at,
        created_at
      FROM oauth_pending_states
      WHERE state = $1
      LIMIT 1
    `,
    [state],
  );
  return (result.rows[0] as DbPendingStateRow | undefined) ?? null;
}

export async function dbDeletePendingState(state: string): Promise<void> {
  await pool.query(`DELETE FROM oauth_pending_states WHERE state = $1`, [state]);
}

export async function dbAuditEvent(args: {
  tenantId?: string | null;
  connectionId?: string | null;
  provider?: string | null;
  eventType: string;
  eventStatus: 'ok' | 'error';
  detail?: unknown;
}): Promise<void> {
  const tenantIdInt = args.tenantId ? toTenantIdInt(args.tenantId) : null;
  const connectionIdInt = args.connectionId ? Number.parseInt(String(args.connectionId).trim(), 10) : null;
  await pool.query(
    `
      INSERT INTO oauth_audit_events (
        tenant_id,
        connection_id,
        provider,
        event_type,
        event_status,
        detail,
        occurred_at
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, now())
    `,
    [
      tenantIdInt,
      Number.isFinite(connectionIdInt as number) ? (connectionIdInt as number) : null,
      args.provider ?? null,
      args.eventType,
      args.eventStatus,
      JSON.stringify(args.detail ?? {}),
    ],
  );
}

