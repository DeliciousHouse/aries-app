export type Platform = 'facebook' | 'instagram' | 'linkedin' | 'x' | 'youtube' | 'reddit' | 'tiktok';

export type ConnectionStatus =
  | 'disconnected'
  | 'pending_oauth'
  | 'oauth_authorized'
  | 'credential_validating'
  | 'connected'
  | 'degraded'
  | 'token_expired'
  | 'revoked'
  | 'permission_denied'
  | 'misconfigured'
  | 'rate_limited'
  | 'error';

export type HealthStatus = 'unknown' | 'healthy' | 'degraded' | 'unhealthy';

export type IntegrationState =
  | 'received'
  | 'credentials_pending'
  | 'credentials_validating'
  | 'connected'
  | 'syncing'
  | 'ready'
  | 'paused'
  | 'repairing'
  | 'failed'
  | 'disconnected';

export type IntegrationStatus = 'pending' | 'running' | 'pass' | 'fail' | 'error' | 'skipped';
export type SyncState = 'never_synced' | 'scheduled' | 'running' | 'healthy' | 'stale' | 'paused' | 'failed';

export type PlatformConnectionStatusRecord = {
  schema_name: 'platform_connection_status_schema';
  schema_version: '1.0.0';
  tenant_id: string;
  integration_id?: string;
  platform: Platform;
  connection_status: ConnectionStatus;
  status_reason?: string;
  health?: HealthStatus;
  last_success_at?: string;
  last_error?: {
    code?: string;
    message: string;
    retryable?: boolean;
    at?: string;
  };
  capabilities?: string[];
  metadata?: Record<string, string | number | boolean | null>;
  updated_at: string;
};

export type IntegrationStateRecord = {
  schema_name: 'integration_state_schema';
  schema_version: '1.0.0';
  tenant_id: string;
  tenant_type?: 'single_user' | 'team';
  integration_id: string;
  platform: Platform;
  state: IntegrationState;
  status: IntegrationStatus;
  attempt?: number;
  max_attempts?: number;
  connection: PlatformConnectionStatusRecord;
  sync?: {
    sync_state?: SyncState;
    cursor?: string;
    last_synced_at?: string;
    next_sync_at?: string;
  };
  last_error?: {
    code?: string;
    message: string;
    stage?: string;
    retryable?: boolean;
  };
  history?: Array<{
    at: string;
    state: IntegrationState;
    status: IntegrationStatus;
    note?: string;
  }>;
  metadata?: Record<string, string | number | boolean | null>;
  created_at: string;
  updated_at: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function assert(condition: boolean, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}

function integrationStateStore(): Map<string, IntegrationStateRecord> {
  const key = '__aries_integration_state_store_v1__';
  const g = globalThis as Record<string, unknown>;
  if (!g[key]) {
    g[key] = new Map<string, IntegrationStateRecord>();
  }
  return g[key] as Map<string, IntegrationStateRecord>;
}

function keyOf(tenantId: string, integrationId: string): string {
  return `${tenantId}::${integrationId}`;
}

function sanitizeMetadata(metadata: Record<string, string | number | boolean | null> | undefined) {
  if (!metadata) return undefined;
  const forbidden = ['token', 'secret', 'password', 'authorization', 'set-cookie', 'cookie'];
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(metadata)) {
    if (forbidden.some((w) => k.toLowerCase().includes(w))) continue;
    out[k] = v;
  }
  return out;
}

function sanitizeConnectionForPersistence(connection: PlatformConnectionStatusRecord): PlatformConnectionStatusRecord {
  return {
    ...connection,
    schema_name: 'platform_connection_status_schema',
    schema_version: '1.0.0',
    capabilities: [...(connection.capabilities || [])],
    metadata: sanitizeMetadata(connection.metadata)
  };
}

export function createIntegrationState(input: {
  tenant_id: string;
  integration_id: string;
  platform: Platform;
  tenant_type?: 'single_user' | 'team';
  state?: IntegrationState;
  status?: IntegrationStatus;
  connection_status?: ConnectionStatus;
}): IntegrationStateRecord {
  const createdAt = nowIso();

  const connection: PlatformConnectionStatusRecord = {
    schema_name: 'platform_connection_status_schema',
    schema_version: '1.0.0',
    tenant_id: input.tenant_id,
    integration_id: input.integration_id,
    platform: input.platform,
    connection_status: input.connection_status || 'pending_oauth',
    health: 'unknown',
    updated_at: createdAt
  };

  const record: IntegrationStateRecord = {
    schema_name: 'integration_state_schema',
    schema_version: '1.0.0',
    tenant_id: input.tenant_id,
    ...(input.tenant_type ? { tenant_type: input.tenant_type } : {}),
    integration_id: input.integration_id,
    platform: input.platform,
    state: input.state || 'received',
    status: input.status || 'pending',
    connection,
    history: [
      {
        at: createdAt,
        state: input.state || 'received',
        status: input.status || 'pending',
        note: 'integration_created'
      }
    ],
    created_at: createdAt,
    updated_at: createdAt
  };

  integrationStateStore().set(keyOf(record.tenant_id, record.integration_id), record);
  return record;
}

export function updateIntegrationState(
  tenantId: string,
  integrationId: string,
  patch: Partial<Pick<IntegrationStateRecord, 'state' | 'status' | 'attempt' | 'max_attempts' | 'sync' | 'last_error' | 'metadata'>> & {
    connection?: Partial<Pick<PlatformConnectionStatusRecord, 'connection_status' | 'status_reason' | 'health' | 'last_success_at' | 'last_error' | 'capabilities' | 'metadata'>>;
    history_note?: string;
  }
): IntegrationStateRecord {
  const store = integrationStateStore();
  const key = keyOf(tenantId, integrationId);
  const existing = store.get(key);
  assert(!!existing, 'integration_state_not_found');

  const current = existing as IntegrationStateRecord;
  const updatedAt = nowIso();

  const nextConnection: PlatformConnectionStatusRecord = sanitizeConnectionForPersistence({
    ...current.connection,
    ...(patch.connection || {}),
    updated_at: updatedAt
  });

  const next: IntegrationStateRecord = {
    ...current,
    ...(patch.state ? { state: patch.state } : {}),
    ...(patch.status ? { status: patch.status } : {}),
    ...(typeof patch.attempt === 'number' ? { attempt: patch.attempt } : {}),
    ...(typeof patch.max_attempts === 'number' ? { max_attempts: patch.max_attempts } : {}),
    ...(patch.sync ? { sync: { ...(current.sync || {}), ...patch.sync } } : {}),
    ...(patch.last_error ? { last_error: patch.last_error } : {}),
    ...(patch.metadata ? { metadata: sanitizeMetadata({ ...(current.metadata || {}), ...patch.metadata }) } : {}),
    connection: nextConnection,
    updated_at: updatedAt
  };

  const historyEntry = {
    at: updatedAt,
    state: next.state,
    status: next.status,
    ...(patch.history_note ? { note: patch.history_note } : {})
  };

  next.history = [...(current.history || []), historyEntry];

  store.set(key, next);
  return next;
}

export function getIntegrationState(tenantId: string, integrationId: string): IntegrationStateRecord | null {
  return integrationStateStore().get(keyOf(tenantId, integrationId)) || null;
}

export function listIntegrationStatesForTenant(tenantId: string): IntegrationStateRecord[] {
  return Array.from(integrationStateStore().values()).filter((s) => s.tenant_id === tenantId);
}

export function toFrontendSafeIntegrationState(state: IntegrationStateRecord): IntegrationStateRecord {
  const sanitizedConnection = sanitizeConnectionForPersistence(state.connection);
  return {
    ...state,
    metadata: sanitizeMetadata(state.metadata),
    connection: sanitizedConnection
  };
}

export function registerProviderConnection(input: {
  tenant_id: string;
  provider: Platform;
  connection_id: string;
  account_label?: string;
}): IntegrationStateRecord {
  const existing = getIntegrationState(input.tenant_id, input.connection_id);
  if (existing) {
    return updateIntegrationState(input.tenant_id, input.connection_id, {
      state: 'connected',
      status: 'pass',
      connection: {
        connection_status: 'connected',
        health: 'healthy',
        status_reason: undefined,
        metadata: sanitizeMetadata({
          ...(existing.connection.metadata || {}),
          ...(input.account_label ? { account_label: input.account_label } : {})
        })
      },
      history_note: 'provider_connected'
    });
  }

  const created = createIntegrationState({
    tenant_id: input.tenant_id,
    integration_id: input.connection_id,
    platform: input.provider,
    state: 'connected',
    status: 'pass',
    connection_status: 'connected'
  });

  return updateIntegrationState(input.tenant_id, input.connection_id, {
    connection: {
      metadata: sanitizeMetadata({
        ...(input.account_label ? { account_label: input.account_label } : {})
      })
    },
    history_note: 'provider_connected'
  }) || created;
}

export function getProviderConnection(tenantId: string, provider: Platform): IntegrationStateRecord | null {
  return (
    listIntegrationStatesForTenant(tenantId)
      .find((item) => item.platform === provider) || null
  );
}

export function disconnectProviderConnection(tenantId: string, provider: Platform): boolean {
  const current = getProviderConnection(tenantId, provider);
  if (!current) return false;

  updateIntegrationState(tenantId, current.integration_id, {
    state: 'disconnected',
    status: 'pass',
    connection: {
      connection_status: 'disconnected',
      status_reason: 'connection_not_found'
    },
    history_note: 'provider_disconnected'
  });

  return true;
}
