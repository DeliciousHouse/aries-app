import type { PoolClient } from "pg";

import type { TenantRole } from "@/lib/tenant-context";

export type TenantClaimsRow = {
  user_id: string | number;
  organization_id?: string | number | null;
  tenant_id?: string | number | null;
  tenant_slug?: string | null;
  role?: string | null;
};

export const LOCAL_DEV_DEFAULT_TENANT_ROLE: TenantRole = "tenant_admin";

const TENANT_ROLES = new Set<TenantRole>(["tenant_admin", "tenant_analyst", "tenant_viewer"]);

type QueryClient = Pick<PoolClient, "query">;

export function isTenantRole(value: unknown): value is TenantRole {
  return typeof value === "string" && TENANT_ROLES.has(value as TenantRole);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function slugFromIdentity(name: string | null | undefined, email: string): string {
  const slug = (name || email.split("@")[0])
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);

  return slug || "user";
}

export function missingTenantClaims(row: TenantClaimsRow | null | undefined): string[] {
  if (!row) {
    return ["user"];
  }

  const missing: string[] = [];

  if (!row.organization_id) {
    missing.push("organization_id");
  }

  if (!row.tenant_id) {
    missing.push("tenant_id");
  }

  if (!row.tenant_slug) {
    missing.push("tenant_slug");
  }

  if (!isTenantRole(row.role)) {
    missing.push("role");
  }

  return missing;
}

export function tenantClaimsErrorRedirect(missingClaims: readonly string[]): string {
  const params = new URLSearchParams({ error: "TenantClaimsIncomplete" });
  if (missingClaims.length > 0) {
    params.set("missing", missingClaims.join(","));
  }
  return `/login?${params.toString()}`;
}

export function isLocalDevTenantRoleProvisioningEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.NODE_ENV !== "production";
}

export async function ensureOrganizationForUser(
  client: QueryClient,
  userId: number,
  name: string | null | undefined,
  email: string,
): Promise<number> {
  const slug = slugFromIdentity(name, email);
  const orgResult = await client.query(
    `
      INSERT INTO organizations (name, slug)
      VALUES ($1, $2)
      ON CONFLICT (slug) DO UPDATE
      SET name = CASE
        WHEN organizations.name IS NULL OR organizations.name = '' THEN EXCLUDED.name
        ELSE organizations.name
      END
      RETURNING id
    `,
    [name?.trim() || email, slug],
  );
  const orgId = Number(orgResult.rows[0].id);
  await client.query("UPDATE users SET organization_id = $1 WHERE id = $2", [orgId, userId]);
  return orgId;
}

export async function findTenantClaimsByUserId(
  client: QueryClient,
  userId: number | string,
): Promise<TenantClaimsRow | null> {
  const result = await client.query(
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
    [Number(userId)],
  );

  if ((result.rowCount ?? 0) === 0 || result.rows.length === 0) {
    return null;
  }

  return result.rows[0] as TenantClaimsRow;
}

export async function findTenantClaimsByEmail(
  client: QueryClient,
  email: string,
): Promise<TenantClaimsRow | null> {
  const result = await client.query(
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
      WHERE LOWER(u.email) = LOWER($1)
      LIMIT 1
    `,
    [email],
  );

  if ((result.rowCount ?? 0) === 0 || result.rows.length === 0) {
    return null;
  }

  return result.rows[0] as TenantClaimsRow;
}

export async function ensureTenantAccessForUser(
  client: QueryClient,
  input: {
    userId: number | string;
    organizationId?: number | string | null;
    role?: string | null;
    name?: string | null;
    email: string;
  },
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const userId = Number(input.userId);

  if (!input.organizationId) {
    await ensureOrganizationForUser(client, userId, input.name, input.email);
  }

  if (!isTenantRole(input.role) && isLocalDevTenantRoleProvisioningEnabled(env)) {
    await client.query("UPDATE users SET role = $1 WHERE id = $2", [
      LOCAL_DEV_DEFAULT_TENANT_ROLE,
      userId,
    ]);
  }
}
