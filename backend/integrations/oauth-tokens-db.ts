import pool from '@/lib/db';
import { decryptToken, encryptToken } from './oauth-crypto';

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

export async function dbInsertOAuthToken(args: {
  connectionId: string;
  accessToken?: string | null;
  refreshToken?: string | null;
  tokenType?: string | null;
  scope?: string | null;
  expiresAt?: string | null;
  refreshExpiresAt?: string | null;
  issuedAt?: string | null;
  rotatedFromTokenId?: string | null;
}): Promise<{ id: string }> {
  const connectionIdInt = toConnectionIdInt(args.connectionId);
  const rotatedFromIdInt = args.rotatedFromTokenId ? Number.parseInt(String(args.rotatedFromTokenId).trim(), 10) : null;
  const res = await pool.query(
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

export async function dbRevokeTokensForConnection(connectionId: string): Promise<void> {
  const connectionIdInt = toConnectionIdInt(connectionId);
  await pool.query(
    `
      UPDATE oauth_tokens
      SET revoked_at = COALESCE(revoked_at, now())
      WHERE connection_id = $1 AND revoked_at IS NULL
    `,
    [connectionIdInt],
  );
}

export async function dbGetLatestOAuthToken(connectionId: string): Promise<StoredOAuthToken | null> {
  const connectionIdInt = toConnectionIdInt(connectionId);
  const res = await pool.query(
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

