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

function trimOrganizationName(name: string | null | undefined, email: string): string {
  return name?.trim() || email;
}

async function organizationSlugExists(client: QueryClient, slug: string): Promise<boolean> {
  const result = await client.query(
    `
      SELECT 1
      FROM organizations
      WHERE slug = $1
      LIMIT 1
    `,
    [slug],
  );

  return (result.rowCount ?? 0) > 0;
}

export async function createOrganizationWithUniqueSlug(
  client: QueryClient,
  input: {
    name: string;
    slugBase: string;
  },
): Promise<{ id: number; slug: string }> {
  const normalizedName = input.name.trim() || 'Organization';
  const baseSlug = input.slugBase.trim().replace(/^-+|-+$/g, '').slice(0, 54) || 'org';

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = attempt === 0 ? '' : `-${attempt + 1}`;
    const slug = `${baseSlug}${suffix}`;
    if (await organizationSlugExists(client, slug)) {
      continue;
    }

    const inserted = await client.query(
      `
        INSERT INTO organizations (name, slug)
        VALUES ($1, $2)
        RETURNING id, slug
      `,
      [normalizedName, slug],
    );

    const row = inserted.rows[0] as { id: number | string; slug: string };
    return {
      id: Number(row.id),
      slug: row.slug,
    };
  }

  throw new Error('organization_slug_generation_failed');
}

/**
 * Dual-write an organization_memberships row (multi-workspace Phase 0, Eng
 * finding 1a). ADDITIVE + unflagged: from Phase 0 on, every legacy provisioning
 * path that sets users.organization_id also upserts the matching membership so
 * the dark tables never drift from the pointer between backfill and flag-flip.
 * Nothing READS these rows yet, so this is pure forward-compat bookkeeping.
 *
 * - role is set explicitly (no table default — Eng finding 11).
 * - status 'active' | 'invited' (an invited-but-not-accepted account carries the
 *   pending-password sentinel; caller passes status:'invited' for that case).
 * - accepted_at / last_active_at stamp now() for an active membership so the
 *   most-recently-used default-workspace ordering works immediately; an invited
 *   row leaves accepted_at NULL.
 * - ON CONFLICT keeps re-provisions/races from 500ing and refreshes role +
 *   (for an accept flip) status/accepted_at.
 */
export async function upsertOrganizationMembership(
  client: QueryClient,
  input: {
    userId: number | string;
    organizationId: number | string;
    role: TenantRole;
    status?: "active" | "invited";
    invitedByUserId?: number | string | null;
  },
): Promise<void> {
  const status = input.status ?? "active";
  const invitedBy =
    input.invitedByUserId === null || input.invitedByUserId === undefined
      ? null
      : Number(input.invitedByUserId);

  await client.query(
    `
      INSERT INTO organization_memberships
        (user_id, organization_id, role, status, invited_by_user_id,
         invited_at, accepted_at, last_active_at, created_at, updated_at)
      VALUES (
        $1, $2, $3, $4, $5,
        CASE WHEN $4 = 'invited' THEN now() ELSE NULL END,
        CASE WHEN $4 = 'active'  THEN now() ELSE NULL END,
        CASE WHEN $4 = 'active'  THEN now() ELSE NULL END,
        now(), now()
      )
      ON CONFLICT (user_id, organization_id) DO UPDATE SET
        role = EXCLUDED.role,
        status = EXCLUDED.status,
        accepted_at = CASE
          WHEN EXCLUDED.status = 'active'
          THEN COALESCE(organization_memberships.accepted_at, now())
          ELSE organization_memberships.accepted_at
        END,
        last_active_at = CASE
          WHEN EXCLUDED.status = 'active'
          THEN COALESCE(organization_memberships.last_active_at, now())
          ELSE organization_memberships.last_active_at
        END,
        updated_at = now()
    `,
    [
      Number(input.userId),
      Number(input.organizationId),
      input.role,
      status,
      invitedBy,
    ],
  );
}

export async function assignUserToOrganization(
  client: QueryClient,
  input: {
    userId: number | string;
    organizationId: number | string;
    role?: TenantRole | null;
  },
): Promise<void> {
  await client.query("UPDATE users SET organization_id = $1 WHERE id = $2", [
    Number(input.organizationId),
    Number(input.userId),
  ]);

  if (input.role) {
    await client.query("UPDATE users SET role = $1 WHERE id = $2", [
      input.role,
      Number(input.userId),
    ]);
  }

  // Dual-write the membership row (multi-workspace Phase 0). This is the
  // chokepoint the Google auto-provision (ensureOrganizationForUser →
  // ensureTenantAccessForUser) and onboarding (resolveTenantForDraft) both flow
  // through, so covering it here covers all pointer-set-with-role paths. When no
  // role is supplied we mirror the resolved active role from users.role so the
  // membership never lands role-less (the table has no default by design).
  const resolvedRole = input.role ?? (await resolveActiveUserRole(client, input.userId));
  if (resolvedRole) {
    await upsertOrganizationMembership(client, {
      userId: input.userId,
      organizationId: input.organizationId,
      role: resolvedRole,
      status: "active",
    });
  }
}

/**
 * Read the user's current global role from users.role and narrow it to a
 * TenantRole. Used only to supply an explicit membership role when
 * assignUserToOrganization is called without one (the pointer-only reassign
 * case) — the membership table has no role default by design.
 */
async function resolveActiveUserRole(
  client: QueryClient,
  userId: number | string,
): Promise<TenantRole | null> {
  const result = await client.query("SELECT role FROM users WHERE id = $1 LIMIT 1", [
    Number(userId),
  ]);
  const role = (result.rows[0] as { role?: string | null } | undefined)?.role;
  return isTenantRole(role) ? role : null;
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
  const created = await createOrganizationWithUniqueSlug(client, {
    name: trimOrganizationName(name, email),
    slugBase: slugFromIdentity(name, email),
  });
  await assignUserToOrganization(client, {
    userId,
    organizationId: created.id,
  });
  const orgId = created.id;
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
