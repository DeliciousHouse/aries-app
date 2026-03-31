import { auth } from '@/auth';
import pool from '@/lib/db';
import type { Session } from 'next-auth';
import { isTenantRole, missingTenantClaims } from '@/lib/auth-tenant-membership';

export type TenantRole = 'tenant_admin' | 'tenant_analyst' | 'tenant_viewer';

export type TenantContext = {
  userId: string;
  tenantId: string;
  tenantSlug: string;
  role: TenantRole;
};

export class TenantContextError extends Error {
  readonly reason: 'tenant_membership_missing' | 'tenant_claims_incomplete';
  readonly missingClaims: string[];

  constructor(
    reason: 'tenant_membership_missing' | 'tenant_claims_incomplete',
    message: string,
    missingClaims: string[] = [],
  ) {
    super(message);
    this.name = 'TenantContextError';
    this.reason = reason;
    this.missingClaims = missingClaims;
  }
}

type Queryable = {
  query: (
    sql: string,
    params: unknown[]
  ) => Promise<{
    rowCount: number | null;
    rows: Array<{
      user_id: string | number;
      organization_id?: string | number | null;
      tenant_id?: string | number | null;
      tenant_slug?: string | null;
      role?: string | null;
    }>;
  }>;
};

function normalizeContextRow(row: {
  user_id: string | number;
  tenant_id?: string | number | null;
  tenant_slug?: string | null;
  role?: string | null;
}): TenantContext {
  return {
    userId: String(row.user_id),
    tenantId: String(row.tenant_id),
    tenantSlug: String(row.tenant_slug),
    role: row.role as TenantRole,
  };
}

export async function loadTenantContextForUser(queryable: Queryable, userId: string): Promise<TenantContext> {
  const result = await queryable.query(
    `
      SELECT
        u.id AS user_id,
        u.organization_id,
        o.id AS tenant_id,
        CASE
          WHEN o.id IS NULL THEN NULL
          ELSE COALESCE(NULLIF(o.slug, ''), 'org-' || o.id::text)
        END AS tenant_slug,
        u.role
      FROM users u
      LEFT JOIN organizations o ON o.id = u.organization_id
      WHERE u.id = $1
      LIMIT 1
    `,
    [Number(userId)]
  );

  if ((result.rowCount ?? 0) === 0 || result.rows.length === 0) {
    throw new TenantContextError(
      'tenant_membership_missing',
      'No tenant membership found for authenticated user.',
    );
  }

  const row = result.rows[0];
  const missingClaims = missingTenantClaims(row);
  if (missingClaims.length > 0) {
    throw new TenantContextError(
      'tenant_claims_incomplete',
      `Authenticated user is missing required tenant claims: ${missingClaims.join(', ')}.`,
      missingClaims,
    );
  }

  return normalizeContextRow(row);
}

export function resolveTenantContextFromSession(session: Session | null): TenantContext | null {
  const user = session?.user;
  if (!user?.id || !user.tenantId || !user.tenantSlug || !user.role) {
    return null;
  }

  if (!isTenantRole(user.role)) {
    return null;
  }

  return {
    userId: String(user.id),
    tenantId: String(user.tenantId),
    tenantSlug: String(user.tenantSlug),
    role: user.role,
  };
}

export async function getTenantContext(): Promise<TenantContext> {
  const session = await auth();
  const claimContext = resolveTenantContextFromSession(session);
  if (claimContext) {
    return claimContext;
  }

  const userId = session?.user?.id;

  if (!userId) {
    throw new Error('Authentication required.');
  }

  const client = await pool.connect();
  try {
    return await loadTenantContextForUser(client, userId);
  } finally {
    client.release();
  }
}
