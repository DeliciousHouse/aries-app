import { resolveTokenHealth } from './connection-schema';
import { dbGetConnection } from './oauth-db';
import { oauthStore } from './oauth-memory-store';

export type OpenAiConnectionReference = {
  provider: 'openai';
  connectionId: string;
};

export async function resolveOpenAiConnectionReference(
  tenantId: string,
): Promise<OpenAiConnectionReference | null> {
  try {
    const row = await dbGetConnection({ tenantId, provider: 'openai' });
    if (row?.status === 'connected' && resolveTokenHealth(row.token_expires_at ?? undefined) !== 'expired') {
      return { provider: 'openai', connectionId: row.id };
    }
  } catch {
    // Fall back to in-memory test store when DB-backed OAuth is unavailable.
  }

  const store = oauthStore();
  const key = `${tenantId}::openai`;
  const connectionId = store.connectedByTenantProvider.get(key);
  if (!connectionId) {
    return null;
  }
  const record = store.connectionsById.get(connectionId);
  if (!record || record.connection_status !== 'connected') {
    return null;
  }
  if (resolveTokenHealth(record.token_expires_at) === 'expired') {
    return null;
  }
  return { provider: 'openai', connectionId: record.connection_id };
}
