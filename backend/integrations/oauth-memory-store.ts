/**
 * In-memory OAuth broker state (global singleton) for unit tests and local tooling.
 * Production persistence uses PostgreSQL via `oauth-db.ts`; handlers do not read this store.
 */

export type MemoryConnectionRecord = {
  connection_id: string;
  provider: string;
  tenant_id: string;
  connection_status: 'connected' | 'disconnected' | 'pending' | 'reauthorization_required';
  granted_scopes: string[];
  created_at: string;
  updated_at: string;
  token_expires_at?: string;
  refresh_token_expires_at?: string;
  disconnected_at?: string;
  external_account_id?: string;
  external_account_name?: string;
};

export type MemoryPendingAuthRecord = {
  state: string;
  provider: string;
  tenant_id: string;
  redirect_uri: string;
  scopes: string[];
  expires_at: string;
  connection_id?: string;
  code_verifier?: string;
};

export type OauthBrokerMemoryStore = {
  pendingByState: Map<string, MemoryPendingAuthRecord>;
  connectionsById: Map<string, MemoryConnectionRecord>;
  connectedByTenantProvider: Map<string, string>;
};

const STORE_KEY = '__aries_oauth_broker_store_v2_2__';

export function oauthStore(): OauthBrokerMemoryStore {
  const g = globalThis as Record<string, unknown>;
  if (!g[STORE_KEY]) {
    g[STORE_KEY] = {
      pendingByState: new Map<string, MemoryPendingAuthRecord>(),
      connectionsById: new Map<string, MemoryConnectionRecord>(),
      connectedByTenantProvider: new Map<string, string>(),
    } satisfies OauthBrokerMemoryStore;
  }
  return g[STORE_KEY] as OauthBrokerMemoryStore;
}
