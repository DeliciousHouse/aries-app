import { auth } from '@/auth';
import pool from '@/lib/db';

export type TenantRole = 'tenant_admin' | 'tenant_analyst' | 'tenant_viewer';

export type TenantContext = {
  userId: string;
  tenantId: string;
  tenantSlug: string;
  role: TenantRole;
};

type Queryable = {
  query: (
    sql: string,
    params: unknown[]
  ) => Promise<{
    rowCount: number | null;
    rows: Array<{
      user_id: string | number;
      tenant_id: string | number;
      tenant_slug: string;
      role: TenantRole;
    }>;
  }>;
};

function normalizeContextRow(row: {
  user_id: string | number;
  tenant_id: string | number;
  tenant_slug: string;
  role: TenantRole;
}): TenantContext {
  return {
    userId: String(row.user_id),
    tenantId: String(row.tenant_id),
    tenantSlug: row.tenant_slug,
    role: row.role,
  };
}

export async function loadTenantContextForUser(queryable: Queryable, userId: string): Promise<TenantContext> {
  const result = await queryable.query(
    `
      SELECT
        u.id AS user_id,
        o.id AS tenant_id,
        COALESCE(NULLIF(o.slug, ''), 'org-' || o.id::text) AS tenant_slug,
        u.role
      FROM users u
      INNER JOIN organizations o ON o.id = u.organization_id
      WHERE u.id = $1
      LIMIT 1
    `,
    [Number(userId)]
  );

  if ((result.rowCount ?? 0) === 0 || result.rows.length === 0) {
    throw new Error('No tenant membership found for authenticated user.');
  }

  return normalizeContextRow(result.rows[0]);
}

export async function getTenantContext(): Promise<TenantContext> {
  const session = await auth();
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
