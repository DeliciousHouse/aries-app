import { auth } from '@/auth';
import pool from '@/lib/db';
import type { Session } from 'next-auth';
import {
  isTenantRole,
  missingTenantClaims,
  resolveTenantClaimsRow,
} from '@/lib/auth-tenant-membership';

export type TenantRole = 'tenant_admin' | 'tenant_analyst' | 'tenant_viewer';

export type TenantContext = {
  userId: string;
  tenantId: string;
  tenantSlug: string;
  role: TenantRole;
  timezone?: string;
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
  // Claims resolution is consolidated onto the ONE membership-claims helper
  // (multi-workspace plan eng findings 5 + 14); this function owns only the
  // row → TenantContext / TenantContextError mapping.
  const row = await resolveTenantClaimsRow(
    queryable as unknown as Parameters<typeof resolveTenantClaimsRow>[0],
    { by: 'userId', userId },
  );

  if (!row) {
    throw new TenantContextError(
      'tenant_membership_missing',
      'No tenant membership found for authenticated user.',
    );
  }

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

export async function resolveTenantContextForSession(
  queryable: Queryable,
  session: Session | null,
): Promise<TenantContext> {
  const claimContext = resolveTenantContextFromSession(session);
  const userId = session?.user?.id;

  if (!userId) {
    throw new Error('Authentication required.');
  }

  try {
    return await loadTenantContextForUser(queryable, userId);
  } catch (error) {
    if (claimContext && !(error instanceof TenantContextError)) {
      return claimContext;
    }
    throw error;
  }
}

export async function getTenantContext(): Promise<TenantContext> {
  const session = await auth();

  const client = await pool.connect();
  try {
    return await resolveTenantContextForSession(client, session);
  } finally {
    client.release();
  }
}
