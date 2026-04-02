import pool from '@/lib/db';
import { decryptOAuthSecret } from './oauth-token-crypto';

export async function getDecryptedAccessTokenForTenantProvider(
  tenantIdStr: string,
  provider: string
): Promise<{ accessToken: string; connectionId: string } | null> {
  const orgId = Number.parseInt(tenantIdStr, 10);
  if (!Number.isFinite(orgId) || orgId < 1) {
    return null;
  }

  const res = await pool.query<{
    access_token_enc: string | null;
    connection_id: string;
  }>(
    `SELECT t.access_token_enc, c.id::text AS connection_id
     FROM oauth_connections c
     INNER JOIN oauth_tokens t ON t.connection_id = c.id
     WHERE c.tenant_id = $1 AND c.provider = $2 AND c.status = 'connected'
       AND t.revoked_at IS NULL AND t.access_token_enc IS NOT NULL
     ORDER BY t.created_at DESC
     LIMIT 1`,
    [orgId, provider]
  );
  const row = res.rows[0];
  if (!row?.access_token_enc) {
    return null;
  }
  const accessToken = decryptOAuthSecret(row.access_token_enc);
  if (!accessToken) {
    return null;
  }
  return { accessToken, connectionId: row.connection_id };
}

/** Person URN for UGC (from OIDC `sub` or legacy person id). */
export async function getLinkedInPersonUrnForTenant(tenantIdStr: string): Promise<string | null> {
  const orgId = Number.parseInt(tenantIdStr, 10);
  if (!Number.isFinite(orgId) || orgId < 1) {
    return null;
  }
  const res = await pool.query<{ external_account_id: string | null }>(
    `SELECT external_account_id FROM oauth_connections
     WHERE tenant_id = $1 AND provider = 'linkedin' AND status = 'connected'
     LIMIT 1`,
    [orgId]
  );
  const sub = res.rows[0]?.external_account_id;
  if (!sub) {
    return null;
  }
  if (sub.startsWith('urn:li:')) {
    return sub;
  }
  return `urn:li:person:${sub}`;
}
