import type { PoolClient } from "pg";

import { isMultiWorkspaceEnabled } from "@/backend/tenant/multi-workspace-env";
import type { TenantRole } from "@/lib/tenant-context";

export type TenantClaimsRow = {
  user_id: string | number;
  organization_id?: string | number | null;
  tenant_id?: string | number | null;
  tenant_slug?: string | null;
  role?: string | null;
  /**
   * Count of the user's ACTIVE organization memberships. Present ONLY when the
   * row was resolved through the multi-workspace membership join (flag ON) —
   * it rides the same single query (plan eng finding 13, no second aggregate).
   */
  workspace_count?: number | null;
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

/**
 * Append a row to the organization_membership_events audit table (multi-
 * workspace plan Decision 1 / CEO E3). Event types are documented values only
 * ('invited' | 'accepted' | 'role_changed' | 'removed' | 'absorbed'); actor is
 * the user who performed the mutation (the invitee for accepts, the admin for
 * invites/role changes/removals). Callers write the event in the SAME
 * transaction as the membership mutation it records.
 */
export async function recordOrganizationMembershipEvent(
  client: QueryClient,
  input: {
    organizationId: number | string;
    userId: number | string;
    actorUserId: number | string | null;
    eventType: 'invited' | 'accepted' | 'role_changed' | 'removed' | 'absorbed';
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `
      INSERT INTO organization_membership_events
        (organization_id, user_id, actor_user_id, event_type, metadata)
      VALUES ($1, $2, $3, $4, $5::jsonb)
    `,
    [
      Number(input.organizationId),
      Number(input.userId),
      input.actorUserId === null || input.actorUserId === undefined ? null : Number(input.actorUserId),
      input.eventType,
      JSON.stringify(input.metadata ?? {}),
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

/**
 * Lookup key for the ONE consolidated membership-claims helper. The same
 * users ⋈ organizations join used to be triplicated across
 * findTenantClaimsByUserId / findTenantClaimsByEmail (this module) and
 * loadTenantContextForUser (lib/tenant-context.ts); Phase 1 of the
 * multi-workspace plan consolidates all three onto resolveTenantClaimsRow so
 * the membership join exists in exactly one place (plan eng findings 5 + 14).
 */
export type TenantClaimsLookup =
  | { by: 'userId'; userId: number | string }
  | { by: 'email'; email: string };

/**
 * The legacy (single-pointer) claims query. The generated SQL is pinned
 * byte-for-byte by tests/auth/tenant-resolution-flag-off-golden.test.ts —
 * do not reformat: with ARIES_MULTI_WORKSPACE_ENABLED off this must stay
 * byte-identical to the pre-Phase-1 queries.
 */
function legacyClaimsSql(whereClause: string): string {
  return `
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
      ${whereClause}
      LIMIT 1
    `;
}

function claimsLookupPredicate(lookup: TenantClaimsLookup): { whereClause: string; params: unknown[] } {
  return lookup.by === 'userId'
    ? { whereClause: 'WHERE u.id = $1', params: [Number(lookup.userId)] }
    : { whereClause: 'WHERE LOWER(u.email) = LOWER($1)', params: [lookup.email] };
}

/**
 * The flag-ON claims query (multi-workspace Phase 1): ONE indexed join
 * users ⋈ organization_memberships ⋈ organizations (CEO hardening 4 — hot path
 * on every authenticated request). The pointer is only honored when an ACTIVE
 * membership backs it, role comes from the MEMBERSHIP row (Decision 3), and
 * workspace_count (active memberships) rides the same statement via an indexed
 * scalar subquery — no second aggregate round-trip (eng finding 13).
 */
function membershipClaimsSql(whereClause: string): string {
  return `
      SELECT
        u.id AS user_id,
        u.organization_id AS pointer_organization_id,
        u.role AS pointer_role,
        o.id AS org_id,
        CASE
          WHEN o.id IS NULL THEN NULL
          ELSE COALESCE(NULLIF(o.slug, ''), 'org-' || o.id::text)
        END AS org_slug,
        m.role AS membership_role,
        m.status AS membership_status,
        (
          SELECT COUNT(*)::int
          FROM organization_memberships am
          WHERE am.user_id = u.id AND am.status = 'active'
        ) AS workspace_count
      FROM users u
      LEFT JOIN organizations o ON o.id = u.organization_id
      LEFT JOIN organization_memberships m
        ON m.user_id = u.id AND m.organization_id = u.organization_id
      ${whereClause}
      LIMIT 1
    `;
}

type MembershipClaimsRawRow = {
  user_id: string | number;
  pointer_organization_id: string | number | null;
  pointer_role: string | null;
  org_id: string | number | null;
  org_slug: string | null;
  membership_role: string | null;
  membership_status: string | null;
  workspace_count: number | string | null;
};

/**
 * Resolver self-heal (plan eng finding 1b): a pointer to an EXISTING org with
 * NO membership row at all gets one 'active' membership derived from the
 * pointer + users.role — trusting the pointer once is exactly today's trust
 * model, and it converges dark-period drift (users provisioned before the
 * dual-write, or with live 30-day JWTs that never re-enter sign-in).
 * ON CONFLICT DO NOTHING so a concurrent insert (or a racing invite that
 * created an 'invited' row) is never overwritten — self-heal must NEVER flip
 * an 'invited' membership to 'active'.
 */
const SELF_HEAL_MEMBERSHIP_INSERT_SQL = `
      INSERT INTO organization_memberships
        (user_id, organization_id, role, status, accepted_at, last_active_at, created_at, updated_at)
      VALUES ($1, $2, $3, 'active', now(), now(), now(), now())
      ON CONFLICT (user_id, organization_id) DO NOTHING
    `;

function zeroMembershipClaims(raw: MembershipClaimsRawRow, workspaceCount: number): TenantClaimsRow {
  return {
    user_id: raw.user_id,
    organization_id: null,
    tenant_id: null,
    tenant_slug: null,
    role: null,
    workspace_count: workspaceCount,
  };
}

async function resolveMembershipClaimsRow(
  client: QueryClient,
  lookup: TenantClaimsLookup,
  allowSelfHeal: boolean,
): Promise<TenantClaimsRow | null> {
  const { whereClause, params } = claimsLookupPredicate(lookup);
  const result = await client.query(membershipClaimsSql(whereClause), params);

  if ((result.rowCount ?? 0) === 0 || result.rows.length === 0) {
    return null;
  }

  const raw = result.rows[0] as MembershipClaimsRawRow;
  const workspaceCount = Number(raw.workspace_count ?? 0);
  const pointerOrgExists = raw.org_id !== null && raw.org_id !== undefined;

  if (pointerOrgExists && raw.membership_status === "active") {
    return {
      user_id: raw.user_id,
      organization_id: raw.pointer_organization_id,
      tenant_id: raw.org_id,
      tenant_slug: raw.org_slug,
      role: raw.membership_role,
      workspace_count: workspaceCount,
    };
  }

  if (
    allowSelfHeal &&
    pointerOrgExists &&
    (raw.membership_status === null || raw.membership_status === undefined) &&
    isTenantRole(raw.pointer_role)
  ) {
    await client.query(SELF_HEAL_MEMBERSHIP_INSERT_SQL, [
      Number(raw.user_id),
      Number(raw.org_id),
      raw.pointer_role,
    ]);
    console.warn("[tenant-claims] self-healed missing membership row from active pointer", {
      userId: String(raw.user_id),
      organizationId: String(raw.org_id),
      role: raw.pointer_role,
    });
    // Re-resolve once (self-heal is the rare path; the hot path stays one
    // query). A lost ON CONFLICT race resolves whatever row won — never loops.
    return resolveMembershipClaimsRow(client, lookup, false);
  }

  // Pointer NULL, pointer → deleted org, or pointer → org without an ACTIVE
  // membership ('invited' included): resolves like NULL (plan Phase 1). The
  // caller distinguishes the typed zero-membership state via workspace_count.
  return zeroMembershipClaims(raw, workspaceCount);
}

/**
 * THE membership-claims helper — every tenant claims/context resolution path
 * (jwt hydrate, sign-in guard, getTenantContext) flows through here.
 *
 * Flag OFF (default): today's single-pointer query, byte-identical (golden-
 * tested). Flag ON: membership-validated single-query resolution + self-heal.
 */
export async function resolveTenantClaimsRow(
  client: QueryClient,
  lookup: TenantClaimsLookup,
  env: NodeJS.ProcessEnv = process.env,
): Promise<TenantClaimsRow | null> {
  if (isMultiWorkspaceEnabled(env)) {
    return resolveMembershipClaimsRow(client, lookup, true);
  }

  const { whereClause, params } = claimsLookupPredicate(lookup);
  const result = await client.query(legacyClaimsSql(whereClause), params);

  if ((result.rowCount ?? 0) === 0 || result.rows.length === 0) {
    return null;
  }

  return result.rows[0] as TenantClaimsRow;
}

export async function findTenantClaimsByUserId(
  client: QueryClient,
  userId: number | string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<TenantClaimsRow | null> {
  return resolveTenantClaimsRow(client, { by: 'userId', userId }, env);
}

export async function findTenantClaimsByEmail(
  client: QueryClient,
  email: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<TenantClaimsRow | null> {
  return resolveTenantClaimsRow(client, { by: 'email', email }, env);
}

/**
 * Deterministic default workspace (plan Decision 7 / E1): the most recently
 * used active membership (last_active_at DESC), falling back to the oldest
 * membership; organization_id is the stable final tiebreak.
 */
const DEFAULT_ACTIVE_MEMBERSHIP_SQL = `
      SELECT organization_id, role
      FROM organization_memberships
      WHERE user_id = $1 AND status = 'active'
      ORDER BY last_active_at DESC NULLS LAST, created_at ASC, organization_id ASC
      LIMIT 1
    `;

/**
 * Flag-ON sign-in guard (Decision 7): validate the pointer against an active
 * membership (self-healing a missing row from the pointer, eng finding 1b);
 * repoint a NULL/invalid pointer to the deterministic default when the user
 * has N≥1 active memberships; and — the load-bearing change — mint NOTHING
 * for a zero-membership account. Resolution then surfaces the typed
 * zero-membership state and the workspace chooser owns the UX.
 */
async function ensureTenantAccessForUserWithMemberships(
  client: QueryClient,
  input: { userId: number | string },
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const userId = Number(input.userId);

  const claims = await resolveTenantClaimsRow(client, { by: "userId", userId }, env);
  if (claims && missingTenantClaims(claims).length === 0) {
    // Pointer backed by an active membership (possibly just self-healed).
    return;
  }

  const workspaceCount = Number(claims?.workspace_count ?? 0);
  if (!claims || workspaceCount < 1) {
    // ZERO active memberships: no personal org is minted (Decision 7 kills the
    // orphan-workspace class at the source). Sign-in proceeds claims-less; the
    // post-login journey / onboarding gate route to the chooser.
    return;
  }

  const result = await client.query(DEFAULT_ACTIVE_MEMBERSHIP_SQL, [userId]);
  const target = result.rows[0] as { organization_id: string | number; role: string } | undefined;
  if (!target) {
    return;
  }

  // Pointer and legacy users.role mirror move together in ONE atomic statement
  // (CEO hardening 3 — no skew window where org-B tenantId carries org-A role).
  await client.query("UPDATE users SET organization_id = $1, role = $2 WHERE id = $3", [
    Number(target.organization_id),
    target.role,
    userId,
  ]);
  // last_active_at is written on sign-in resolution and switch ONLY — never
  // per-request (Decision 1 / E1 write-amplification rule).
  await client.query(
    `UPDATE organization_memberships
        SET last_active_at = now(), updated_at = now()
      WHERE user_id = $1 AND organization_id = $2`,
    [userId, Number(target.organization_id)],
  );
  console.warn("[tenant-access] repointed invalid active-workspace pointer to deterministic default", {
    userId: String(userId),
    organizationId: String(target.organization_id),
    role: target.role,
  });
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
  if (isMultiWorkspaceEnabled(env)) {
    await ensureTenantAccessForUserWithMemberships(client, input, env);
    return;
  }

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
