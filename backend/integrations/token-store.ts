import { randomUUID } from 'node:crypto';
import type { CredentialReference, CredentialReferenceType } from './credential-reference';

export type TokenClass = 'access_token' | 'refresh_token' | 'csrf_token' | 'session_id';
export type TokenStatus = 'active' | 'expired' | 'revoked' | 'compromised';
export type StorageProfile =
  | 'process_memory'
  | 'server_secure_store'
  | 'http_only_secure_cookie'
  | 'http_response_cookie'
  | 'request_header';

export type TokenRecord = {
  token_class: TokenClass;
  token_handle: string;
  subject_id: string;
  tenant_id: string;
  issued_at: string;
  expires_at: string;
  status: TokenStatus;
  storage_profile: StorageProfile;
  credential_reference?: CredentialReference;
  family_id?: string;
  replaced_by_token_handle?: string;
};

export type StoreTokenInput = {
  token_class: TokenClass;
  subject_id: string;
  tenant_id: string;
  ttl_seconds: number;
  access_token_value?: string;
  credential_reference?: CredentialReference;
  family_id?: string;
};

export type RotateRefreshTokenInput = {
  old_token_handle: string;
  subject_id: string;
  tenant_id: string;
  ttl_seconds: number;
  credential_reference: CredentialReference;
};

const STORAGE_PROFILE_BY_CLASS: Record<TokenClass, StorageProfile> = {
  access_token: 'process_memory',
  refresh_token: 'server_secure_store',
  csrf_token: 'http_response_cookie',
  session_id: 'server_secure_store'
};

const REQUIRED_REFERENCE: Partial<Record<TokenClass, CredentialReferenceType[]>> = {
  refresh_token: ['key_encryption_key', 'hmac_secret'],
  session_id: ['hmac_secret'],
  access_token: ['signing_key']
};

const TOKEN_HANDLE_PREFIX: Record<TokenClass, string> = {
  access_token: 'th_atk_',
  refresh_token: 'th_rtk_',
  csrf_token: 'th_csrf_',
  session_id: 'th_sid_'
};

function nowIso(): string {
  return new Date().toISOString();
}

function plusSeconds(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

function assert(condition: boolean, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}

function ensureCredentialBinding(tokenClass: TokenClass, ref: CredentialReference | undefined): void {
  const required = REQUIRED_REFERENCE[tokenClass];
  if (!required || required.length === 0) return;
  assert(!!ref, 'missing_required_fields:credential_reference');
  assert(required.includes((ref as CredentialReference).reference_type), 'validation_error:credential_reference_type');
  assert((ref as CredentialReference).lifecycle_state === 'active' || (ref as CredentialReference).lifecycle_state === 'rotating', 'validation_error:credential_reference_state');
}

function ttlAllowed(tokenClass: TokenClass, ttlSeconds: number): boolean {
  if (tokenClass === 'access_token') return ttlSeconds <= 0;
  if (tokenClass === 'refresh_token') return ttlSeconds <= 2592000;
  if (tokenClass === 'csrf_token') return ttlSeconds <= 28800;
  if (tokenClass === 'session_id') return ttlSeconds <= 43200;
  return false;
}

type TokenStoreState = {
  records: Map<string, TokenRecord>;
  accessByHandle: Map<string, string>;
  activeByFamily: Map<string, Set<string>>;
  securityEvents: Array<{
    event_type: 'token.stored' | 'token.accessed' | 'token.rotated' | 'token.revoked' | 'token.reuse_detected';
    occurred_at: string;
    token_handle: string;
    token_class: TokenClass;
    tenant_id: string;
    subject_id: string;
  }>;
};

function tokenStore(): TokenStoreState {
  const key = '__aries_secure_token_store_v1__';
  const g = globalThis as Record<string, unknown>;
  if (!g[key]) {
    g[key] = {
      records: new Map<string, TokenRecord>(),
      accessByHandle: new Map<string, string>(),
      activeByFamily: new Map<string, Set<string>>(),
      securityEvents: []
    } satisfies TokenStoreState;
  }
  return g[key] as TokenStoreState;
}

function emitSecurityEvent(store: TokenStoreState, event: TokenStoreState['securityEvents'][number]): void {
  store.securityEvents.push(event);
}

export function createTokenHandle(tokenClass: TokenClass): string {
  return `${TOKEN_HANDLE_PREFIX[tokenClass]}${randomUUID().split('-').join('')}`;
}

function attachFamilyRecord(familyId: string, handle: string, store: TokenStoreState): void {
  const family = store.activeByFamily.get(familyId) || new Set<string>();
  family.add(handle);
  store.activeByFamily.set(familyId, family);
}

export function storeToken(input: StoreTokenInput): TokenRecord {
  assert(ttlAllowed(input.token_class, input.ttl_seconds), 'validation_error:ttl_not_allowed_for_token_class');
  ensureCredentialBinding(input.token_class, input.credential_reference);

  const issuedAt = nowIso();
  const handle = createTokenHandle(input.token_class);
  const expiresAt = plusSeconds(issuedAt, Math.max(0, input.ttl_seconds));

  const record: TokenRecord = {
    token_class: input.token_class,
    token_handle: handle,
    subject_id: input.subject_id,
    tenant_id: input.tenant_id,
    issued_at: issuedAt,
    expires_at: expiresAt,
    status: 'active',
    storage_profile: STORAGE_PROFILE_BY_CLASS[input.token_class],
    ...(input.credential_reference ? { credential_reference: input.credential_reference } : {}),
    ...(input.family_id ? { family_id: input.family_id } : {})
  };

  const store = tokenStore();
  store.records.set(handle, record);

  // Access token values are process-memory only and never stored in persisted records.
  if (input.token_class === 'access_token' && input.access_token_value) {
    store.accessByHandle.set(handle, input.access_token_value);
  }

  if (record.family_id) attachFamilyRecord(record.family_id, record.token_handle, store);

  emitSecurityEvent(store, {
    event_type: 'token.stored',
    occurred_at: issuedAt,
    token_handle: record.token_handle,
    token_class: record.token_class,
    tenant_id: record.tenant_id,
    subject_id: record.subject_id
  });

  return record;
}

export function readTokenRecord(tokenHandle: string, tenantId: string): TokenRecord | null {
  const store = tokenStore();
  const rec = store.records.get(tokenHandle);
  if (!rec) return null;
  assert(rec.tenant_id === tenantId, 'tenant_scope_mismatch');

  if (new Date(rec.expires_at).getTime() <= Date.now() && rec.status === 'active') {
    const expired: TokenRecord = { ...rec, status: 'expired' };
    store.records.set(tokenHandle, expired);
    emitSecurityEvent(store, {
      event_type: 'token.accessed',
      occurred_at: nowIso(),
      token_handle: expired.token_handle,
      token_class: expired.token_class,
      tenant_id: expired.tenant_id,
      subject_id: expired.subject_id
    });
    return expired;
  }

  emitSecurityEvent(store, {
    event_type: 'token.accessed',
    occurred_at: nowIso(),
    token_handle: rec.token_handle,
    token_class: rec.token_class,
    tenant_id: rec.tenant_id,
    subject_id: rec.subject_id
  });

  return rec;
}

export function rotateRefreshToken(input: RotateRefreshTokenInput): { previous: TokenRecord; next: TokenRecord } {
  const oldRecord = readTokenRecord(input.old_token_handle, input.tenant_id);
  assert(!!oldRecord, 'refresh_token_not_found');
  assert((oldRecord as TokenRecord).token_class === 'refresh_token', 'validation_error:not_refresh_token');
  assert((oldRecord as TokenRecord).status === 'active', 'refresh_token_not_active');

  const prev = oldRecord as TokenRecord;
  assert(prev.subject_id === input.subject_id, 'refresh_token_subject_mismatch');
  assert(prev.tenant_id === input.tenant_id, 'refresh_token_tenant_mismatch');

  const familyId = prev.family_id || `rtf_${randomUUID().split('-').join('')}`;

  // Single-use rotation: old token is immediately revoked when a new token is issued.
  const revokedPrev: TokenRecord = {
    ...prev,
    status: 'revoked',
    replaced_by_token_handle: ''
  };

  const next = storeToken({
    token_class: 'refresh_token',
    subject_id: input.subject_id,
    tenant_id: input.tenant_id,
    ttl_seconds: input.ttl_seconds,
    credential_reference: input.credential_reference,
    family_id: familyId
  });

  revokedPrev.replaced_by_token_handle = next.token_handle;

  const store = tokenStore();
  store.records.set(revokedPrev.token_handle, revokedPrev);
  emitSecurityEvent(store, {
    event_type: 'token.rotated',
    occurred_at: nowIso(),
    token_handle: next.token_handle,
    token_class: next.token_class,
    tenant_id: next.tenant_id,
    subject_id: next.subject_id
  });

  return { previous: revokedPrev, next };
}

export function detectRefreshTokenReuse(tokenHandle: string, tenantId: string): boolean {
  const rec = readTokenRecord(tokenHandle, tenantId);
  if (!rec || rec.token_class !== 'refresh_token') return false;
  const reused = rec.status === 'revoked' && !!rec.replaced_by_token_handle;
  if (reused) {
    emitSecurityEvent(tokenStore(), {
      event_type: 'token.reuse_detected',
      occurred_at: nowIso(),
      token_handle: rec.token_handle,
      token_class: rec.token_class,
      tenant_id: rec.tenant_id,
      subject_id: rec.subject_id
    });
  }
  return reused;
}

export function revokeByTokenHandle(tokenHandle: string, tenantId: string): TokenRecord | null {
  const rec = readTokenRecord(tokenHandle, tenantId);
  if (!rec) return null;

  const revoked: TokenRecord = { ...rec, status: 'revoked' };
  const store = tokenStore();
  store.records.set(tokenHandle, revoked);
  if (revoked.token_class === 'access_token') store.accessByHandle.delete(tokenHandle);
  emitSecurityEvent(store, {
    event_type: 'token.revoked',
    occurred_at: nowIso(),
    token_handle: revoked.token_handle,
    token_class: revoked.token_class,
    tenant_id: revoked.tenant_id,
    subject_id: revoked.subject_id
  });
  return revoked;
}

export function revokeByFamily(familyId: string, tenantId: string): TokenRecord[] {
  const store = tokenStore();
  const handles = Array.from(store.activeByFamily.get(familyId) || new Set<string>());
  const revoked: TokenRecord[] = [];
  for (const handle of handles) {
    const r = revokeByTokenHandle(handle, tenantId);
    if (r) revoked.push(r);
  }
  return revoked;
}

export function listTokenSecurityEvents(tenantId?: string): TokenStoreState['securityEvents'] {
  const all = tokenStore().securityEvents;
  return tenantId ? all.filter((e) => e.tenant_id === tenantId) : all;
}

export function lookupAccessTokenValue(tokenHandle: string): string | null {
  // Only process-memory lookup; no API-safe export of raw secret.
  return tokenStore().accessByHandle.get(tokenHandle) || null;
}

export function sanitizeTokenRecordForApi(record: TokenRecord): Omit<TokenRecord, 'credential_reference'> & {
  credential_reference?: {
    reference_id: string;
    reference_type: CredentialReferenceType;
    provider: CredentialReference['provider'];
    tenant_scope: CredentialReference['tenant_scope'];
    lifecycle_state: CredentialReference['lifecycle_state'];
    created_at: string;
    updated_at: string;
    version?: number;
  };
} {
  const { credential_reference, ...rest } = record;
  return {
    ...rest,
    ...(credential_reference
      ? {
          credential_reference: {
            reference_id: credential_reference.reference_id,
            reference_type: credential_reference.reference_type,
            provider: credential_reference.provider,
            tenant_scope: credential_reference.tenant_scope,
            lifecycle_state: credential_reference.lifecycle_state,
            created_at: credential_reference.created_at,
            updated_at: credential_reference.updated_at,
            ...(typeof credential_reference.version === 'number' ? { version: credential_reference.version } : {})
          }
        }
      : {})
  };
}
