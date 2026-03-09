export type CredentialReferenceType =
  | 'key_encryption_key'
  | 'hmac_secret'
  | 'signing_key'
  | 'certificate'
  | 'api_client_secret';

export type CredentialProvider = 'internal_hsm' | 'cloud_kms' | 'secret_manager' | 'vault';
export type TenantScope = 'global' | 'tenant' | 'service';
export type CredentialLifecycleState = 'active' | 'rotating' | 'retired' | 'revoked';
export type AttestationIntegrity = 'unverified' | 'verified' | 'hardware_backed';

export type CredentialReference = {
  reference_id: string;
  reference_type: CredentialReferenceType;
  provider: CredentialProvider;
  tenant_scope: TenantScope;
  lifecycle_state: CredentialLifecycleState;
  created_at: string;
  updated_at: string;
  key_purpose?: string;
  algorithm_family?: string;
  not_before?: string;
  expires_at?: string;
  rotation_group?: string;
  version?: number;
  resolution_hint?: string;
  attestation?: {
    integrity_level: AttestationIntegrity;
    last_verified_at: string;
  };
};

export type CredentialResolveRequest = {
  reference_type: CredentialReferenceType;
  tenant_id: string;
  allow_global_fallback?: boolean;
};

const FORBIDDEN_VALUE_MARKERS = ['plaintext_secret', 'private_key', 'password', 'raw_key_bytes'];
const REF_PATTERN = /^cr_[a-z0-9]{12,64}$/;

function nowIso(): string {
  return new Date().toISOString();
}

function assert(condition: boolean, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}

function isIso(input: string | undefined): boolean {
  return !!input && !Number.isNaN(new Date(input).getTime());
}

function validateReferenceObject(input: CredentialReference): void {
  assert(REF_PATTERN.test(input.reference_id), 'validation_error:reference_id');
  assert(isIso(input.created_at), 'validation_error:created_at');
  assert(isIso(input.updated_at), 'validation_error:updated_at');

  if (input.not_before) assert(isIso(input.not_before), 'validation_error:not_before');
  if (input.expires_at) assert(isIso(input.expires_at), 'validation_error:expires_at');

  if (typeof input.version !== 'undefined') {
    assert(Number.isInteger(input.version) && input.version >= 1, 'validation_error:version');
  }

  if (input.resolution_hint) {
    assert(input.resolution_hint.length <= 256, 'validation_error:resolution_hint');
    const lowered = input.resolution_hint.toLowerCase();
    assert(
      !FORBIDDEN_VALUE_MARKERS.some((marker) => lowered.includes(marker)),
      'validation_error:resolution_hint_forbidden_content'
    );
  }
}

function redactHint(hint: string | undefined): string | undefined {
  if (!hint) return undefined;
  if (hint.length <= 8) return '***';
  return `${hint.slice(0, 2)}***${hint.slice(-2)}`;
}

export type RedactedCredentialReference = Omit<CredentialReference, 'resolution_hint'> & {
  resolution_hint?: string;
};

export function toRedactedCredentialReference(input: CredentialReference): RedactedCredentialReference {
  return {
    ...input,
    ...(input.resolution_hint ? { resolution_hint: redactHint(input.resolution_hint) } : {})
  };
}

type CredentialRefStore = {
  byId: Map<string, CredentialReference>;
  byTenant: Map<string, Set<string>>;
  byGlobal: Set<string>;
};

function refStore(): CredentialRefStore {
  const key = '__aries_credential_reference_store_v1__';
  const g = globalThis as Record<string, unknown>;
  if (!g[key]) {
    g[key] = {
      byId: new Map<string, CredentialReference>(),
      byTenant: new Map<string, Set<string>>(),
      byGlobal: new Set<string>()
    } satisfies CredentialRefStore;
  }
  return g[key] as CredentialRefStore;
}

function activeStateForResolution(ref: CredentialReference): boolean {
  return ref.lifecycle_state === 'active' || ref.lifecycle_state === 'rotating';
}

function timeAllowsResolution(ref: CredentialReference, at: number): boolean {
  const notBefore = ref.not_before ? new Date(ref.not_before).getTime() : Number.NEGATIVE_INFINITY;
  const expiresAt = ref.expires_at ? new Date(ref.expires_at).getTime() : Number.POSITIVE_INFINITY;
  return at >= notBefore && at < expiresAt;
}

export function registerCredentialReference(input: Omit<CredentialReference, 'created_at' | 'updated_at'> & Partial<Pick<CredentialReference, 'created_at' | 'updated_at'>>,
  tenantId?: string
): CredentialReference {
  const now = nowIso();
  const record: CredentialReference = {
    ...input,
    created_at: input.created_at || now,
    updated_at: input.updated_at || now
  };

  validateReferenceObject(record);

  const store = refStore();
  const existing = store.byId.get(record.reference_id);
  if (existing?.version && record.version) {
    assert(record.version >= existing.version, 'validation_error:version_non_monotonic');
  }

  store.byId.set(record.reference_id, record);

  if (record.tenant_scope === 'global') {
    store.byGlobal.add(record.reference_id);
  } else {
    assert(!!tenantId, 'missing_required_fields:tenant_id');
    const set = store.byTenant.get(tenantId) || new Set<string>();
    set.add(record.reference_id);
    store.byTenant.set(tenantId, set);
  }

  return record;
}

export function resolveCredentialReference(req: CredentialResolveRequest): CredentialReference {
  const store = refStore();
  const nowMs = Date.now();

  const tenantCandidates = Array.from(store.byTenant.get(req.tenant_id) || new Set<string>())
    .map((id) => store.byId.get(id))
    .filter((v): v is CredentialReference => !!v)
    .filter((ref) => ref.reference_type === req.reference_type)
    .filter((ref) => activeStateForResolution(ref) && timeAllowsResolution(ref, nowMs));

  const globalCandidates = req.allow_global_fallback
    ? Array.from(store.byGlobal)
      .map((id) => store.byId.get(id))
      .filter((v): v is CredentialReference => !!v)
      .filter((ref) => ref.reference_type === req.reference_type)
      .filter((ref) => activeStateForResolution(ref) && timeAllowsResolution(ref, nowMs))
    : [];

  const candidates = [...tenantCandidates, ...globalCandidates].sort((a, b) => (b.version || 0) - (a.version || 0));

  assert(candidates.length > 0, 'credential_reference_not_found');

  const highestVersion = candidates[0].version || 0;
  const sameVersionActive = candidates.filter((c) => (c.version || 0) === highestVersion && c.lifecycle_state === 'active');

  // Single active version invariant from contract.
  assert(sameVersionActive.length <= 1, 'credential_reference_resolution_ambiguous');

  const selected = sameVersionActive[0] || candidates[0];

  // Tenant consistency invariant: tenant-scoped entries are preferred unless explicit global fallback is requested.
  if (selected.tenant_scope === 'global') {
    assert(!!req.allow_global_fallback, 'credential_reference_tenant_mismatch');
  }

  return selected;
}

export function rotateCredentialReference(referenceId: string, nextVersion: number): CredentialReference {
  const store = refStore();
  const existing = store.byId.get(referenceId);
  assert(!!existing, 'credential_reference_not_found');

  const prev = existing as CredentialReference;
  const currentVersion = prev.version || 1;
  assert(nextVersion > currentVersion, 'validation_error:version_non_monotonic');

  const rotated: CredentialReference = {
    ...prev,
    lifecycle_state: 'rotating',
    version: nextVersion,
    updated_at: nowIso()
  };
  store.byId.set(referenceId, rotated);
  return rotated;
}

export function revokeCredentialReference(referenceId: string): CredentialReference {
  const store = refStore();
  const existing = store.byId.get(referenceId);
  assert(!!existing, 'credential_reference_not_found');

  const revoked: CredentialReference = {
    ...(existing as CredentialReference),
    lifecycle_state: 'revoked',
    updated_at: nowIso()
  };
  store.byId.set(referenceId, revoked);
  return revoked;
}
