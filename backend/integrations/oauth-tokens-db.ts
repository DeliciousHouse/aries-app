import type { PoolClient } from 'pg';
import pool from '@/lib/db';
import { decryptToken, encryptToken } from './oauth-crypto';

type Queryable = Pick<PoolClient, 'query'> | typeof pool;

export type StoredOAuthToken = {
  id: string;
  connection_id: string;
  token_type: string | null;
  scope: string | null;
  expires_at: string | null;
  refresh_expires_at: string | null;
  issued_at: string | null;
  revoked_at: string | null;
  created_at: string;
  access_token: string | null;
  refresh_token: string | null;
};

function toConnectionIdInt(connectionId: string): number {
  const parsed = Number.parseInt(String(connectionId).trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('validation_error:connection_id');
  }
  return parsed;
}

export async function dbInsertOAuthToken(
  args: {
    connectionId: string;
    accessToken?: string | null;
    refreshToken?: string | null;
    tokenType?: string | null;
    scope?: string | null;
    expiresAt?: string | null;
    refreshExpiresAt?: string | null;
    issuedAt?: string | null;
    rotatedFromTokenId?: string | null;
  },
  client: Queryable = pool,
): Promise<{ id: string }> {
  const connectionIdInt = toConnectionIdInt(args.connectionId);
  const rotatedFromIdInt = args.rotatedFromTokenId
    ? Number.parseInt(String(args.rotatedFromTokenId).trim(), 10)
    : null;
  const res = await client.query(
    `
      INSERT INTO oauth_tokens (
        connection_id,
        access_token_enc,
        refresh_token_enc,
        token_type,
        scope,
        expires_at,
        refresh_expires_at,
        issued_at,
        rotated_from_token_id,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
      RETURNING id::text
    `,
    [
      connectionIdInt,
      args.accessToken ? encryptToken(args.accessToken) : null,
      args.refreshToken ? encryptToken(args.refreshToken) : null,
      args.tokenType ?? null,
      args.scope ?? null,
      args.expiresAt ?? null,
      args.refreshExpiresAt ?? null,
      args.issuedAt ?? null,
      Number.isFinite(rotatedFromIdInt as number) ? (rotatedFromIdInt as number) : null,
    ],
  );
  return res.rows[0] as { id: string };
}

export async function dbRevokeTokensForConnection(connectionId: string, client: Queryable = pool): Promise<void> {
  const connectionIdInt = toConnectionIdInt(connectionId);
  await client.query(
    `
      UPDATE oauth_tokens
      SET revoked_at = COALESCE(revoked_at, now())
      WHERE connection_id = $1 AND revoked_at IS NULL
    `,
    [connectionIdInt],
  );
}

export async function dbRevokeOAuthTokenById(tokenId: string, client: Queryable = pool): Promise<void> {
  const tokenIdInt = Number.parseInt(String(tokenId).trim(), 10);
  if (!Number.isFinite(tokenIdInt) || tokenIdInt <= 0) {
    throw new Error('validation_error:token_id');
  }
  await client.query(
    `
      UPDATE oauth_tokens
      SET revoked_at = COALESCE(revoked_at, now())
      WHERE id = $1
    `,
    [tokenIdInt],
  );
}

export async function dbGetLatestOAuthToken(
  connectionId: string,
  client: Queryable = pool,
): Promise<StoredOAuthToken | null> {
  const connectionIdInt = toConnectionIdInt(connectionId);
  const res = await client.query(
    `
      SELECT
        id::text,
        connection_id::text,
        access_token_enc,
        refresh_token_enc,
        token_type,
        scope,
        expires_at,
        refresh_expires_at,
        issued_at,
        revoked_at,
        created_at
      FROM oauth_tokens
      WHERE connection_id = $1
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [connectionIdInt],
  );
  if ((res.rowCount ?? 0) === 0) return null;
  const row = res.rows[0] as {
    id: string;
    connection_id: string;
    access_token_enc: string | null;
    refresh_token_enc: string | null;
    token_type: string | null;
    scope: string | null;
    expires_at: string | null;
    refresh_expires_at: string | null;
    issued_at: string | null;
    revoked_at: string | null;
    created_at: string;
  };
  return {
    id: row.id,
    connection_id: row.connection_id,
    token_type: row.token_type,
    scope: row.scope,
    expires_at: row.expires_at,
    refresh_expires_at: row.refresh_expires_at,
    issued_at: row.issued_at,
    revoked_at: row.revoked_at,
    created_at: row.created_at,
    access_token: row.access_token_enc ? decryptToken(row.access_token_enc) : null,
    refresh_token: row.refresh_token_enc ? decryptToken(row.refresh_token_enc) : null,
  };
}

export type LockedConnectionRow = {
  id: string;
  tenant_id: string;
  provider: string;
  status: string;
  granted_scopes: string[];
  token_expires_at: string | null;
  refresh_expires_at: string | null;
  external_account_id: string | null;
  external_account_name: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
};

export async function withConnectionLock<T>(
  connectionId: string,
  fn: (client: PoolClient, locked: LockedConnectionRow | null) => Promise<T>,
): Promise<T> {
  const connectionIdInt = toConnectionIdInt(connectionId);
  const client = (await pool.connect()) as PoolClient;
  try {
    await client.query('BEGIN');
    const lockResult = await client.query(
      `
        SELECT
          id::text,
          tenant_id::text,
          provider,
          status,
          granted_scopes,
          token_expires_at,
          refresh_expires_at,
          external_account_id,
          external_account_name,
          last_error_code,
          last_error_message
        FROM oauth_connections
        WHERE id = $1
        FOR UPDATE
      `,
      [connectionIdInt],
    );
    const locked =
      (lockResult.rows[0] as LockedConnectionRow | undefined) ?? null;
    const result = await fn(client, locked);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('[oauth-tokens-db] rollback failed', rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
}
