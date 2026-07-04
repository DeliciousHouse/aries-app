import type { TenantRole } from '@/lib/tenant-context';
import { upsertOrganizationMembership } from '@/lib/auth-tenant-membership';

/**
 * Membership status as surfaced to the admin UI. Derived from the user's
 * password_hash sentinel: a freshly-invited teammate who has not yet set a
 * password carries `password_hash = 'invited_pending'` and reads as 'invited';
 * everyone else (credentials users, oauth_managed Google users) reads as
 * 'active'. There is no separate status column — this is a projection.
 */
export type TenantMemberStatus = 'active' | 'invited';

export const INVITED_PENDING_PASSWORD = 'invited_pending';

export type TenantUserProfile = {
  userId: string;
  tenantId: string;
  email: string;
  fullName: string | null;
  role: TenantRole;
  status: TenantMemberStatus;
  createdAt: string;
};

type DbRow = {
  id: string | number;
  organization_id: string | number;
  email: string;
  full_name: string | null;
  role: TenantRole;
  password_hash?: string | null;
  created_at: string | Date;
};

type Queryable = {
  query: (sql: string, params: unknown[]) => Promise<{ rows: DbRow[] }>;
};

const TENANT_ROLES = new Set<TenantRole>(['tenant_admin', 'tenant_analyst', 'tenant_viewer']);

function toTenantUserProfile(row: DbRow): TenantUserProfile {
  return {
    userId: String(row.id),
    tenantId: String(row.organization_id),
    email: row.email,
    fullName: row.full_name ?? null,
    role: row.role,
    status: row.password_hash === INVITED_PENDING_PASSWORD ? 'invited' : 'active',
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

function assertTenantRole(role: unknown): asserts role is TenantRole {
  if (typeof role !== 'string' || !TENANT_ROLES.has(role as TenantRole)) {
    throw new Error('invalid_role');
  }
}

async function loadUserById(queryable: Queryable, userId: string) {
  const result = await queryable.query(
    `
      SELECT
        u.id,
        u.organization_id,
        u.email,
        u.full_name,
        u.role,
        u.password_hash,
        u.created_at
      FROM users u
      WHERE u.id = $1
      LIMIT 1
    `,
    [Number(userId)]
  );

  return result.rows[0] ?? null;
}

export async function listTenantUserProfiles(queryable: Queryable, tenantId: string): Promise<TenantUserProfile[]> {
  const result = await queryable.query(
    `
      SELECT
        u.id,
        u.organization_id,
        u.email,
        u.full_name,
        u.role,
        u.password_hash,
        u.created_at
      FROM users u
      WHERE u.organization_id = $1
      ORDER BY u.id ASC
    `,
    [Number(tenantId)]
  );

  return result.rows.map(toTenantUserProfile);
}

export async function createTenantUserProfile(
  queryable: Queryable,
  input: {
    tenantId: string;
    email: string;
    fullName?: string | null;
    role?: TenantRole;
  }
): Promise<TenantUserProfile> {
  const email = input.email.trim().toLowerCase();
  if (!email) {
    throw new Error('missing_required_fields:email');
  }

  const role = input.role ?? 'tenant_viewer';
  assertTenantRole(role);

  const result = await queryable.query(
    `
      INSERT INTO users (email, password_hash, full_name, organization_id, role)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING
        id,
        organization_id,
        email,
        full_name,
        role,
        password_hash,
        created_at
    `,
    [email, INVITED_PENDING_PASSWORD, input.fullName ?? null, Number(input.tenantId), role]
  );

  const profile = toTenantUserProfile(result.rows[0]);

  // Dual-write the membership row as 'invited' (multi-workspace Phase 0, Eng
  // findings 1a + 2). An invite-created user carries the pending-password
  // sentinel, so the membership is 'invited' until acceptWorkspaceInvitation
  // flips it to 'active'. Additive — nothing reads it yet.
  await upsertOrganizationMembership(queryable as never, {
    userId: profile.userId,
    organizationId: profile.tenantId,
    role: profile.role,
    status: 'invited',
  });

  return profile;
}

export async function getTenantUserProfileById(
  queryable: Queryable,
  input: { tenantId: string; userId: string }
): Promise<{ status: 'ok'; profile: TenantUserProfile } | { status: 'not_found' | 'tenant_mismatch' }> {
  const row = await loadUserById(queryable, input.userId);
  if (!row) {
    return { status: 'not_found' };
  }

  if (String(row.organization_id) !== String(input.tenantId)) {
    return { status: 'tenant_mismatch' };
  }

  return { status: 'ok', profile: toTenantUserProfile(row) };
}

export async function updateTenantUserProfile(
  queryable: Queryable,
  input: {
    tenantId: string;
    userId: string;
    fullName?: string | null;
    role?: TenantRole;
  }
): Promise<{ status: 'ok'; profile: TenantUserProfile } | { status: 'not_found' | 'tenant_mismatch' }> {
  const current = await loadUserById(queryable, input.userId);
  if (!current) {
    return { status: 'not_found' };
  }

  if (String(current.organization_id) !== String(input.tenantId)) {
    return { status: 'tenant_mismatch' };
  }

  const nextFullName = input.fullName === undefined ? current.full_name : input.fullName;
  const nextRole = input.role === undefined ? current.role : input.role;
  assertTenantRole(nextRole);

  const updated = await queryable.query(
    `
      UPDATE users
      SET full_name = $1, role = $2
      WHERE id = $3 AND organization_id = $4
      RETURNING
        id,
        organization_id,
        email,
        full_name,
        role,
        password_hash,
        created_at
    `,
    [nextFullName ?? null, nextRole, Number(input.userId), Number(input.tenantId)]
  );

  return { status: 'ok', profile: toTenantUserProfile(updated.rows[0]) };
}

export async function deleteTenantUserProfile(
  queryable: Queryable,
  input: { tenantId: string; userId: string }
): Promise<{ status: 'deleted' | 'not_found' | 'tenant_mismatch' }> {
  const current = await loadUserById(queryable, input.userId);
  if (!current) {
    return { status: 'not_found' };
  }

  if (String(current.organization_id) !== String(input.tenantId)) {
    return { status: 'tenant_mismatch' };
  }

  await queryable.query(
    `
      DELETE FROM users
      WHERE id = $1 AND organization_id = $2
    `,
    [Number(input.userId), Number(input.tenantId)]
  );

  return { status: 'deleted' };
}
