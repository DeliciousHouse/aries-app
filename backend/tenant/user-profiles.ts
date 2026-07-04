import type { TenantRole } from '@/lib/tenant-context';
import {
  recordOrganizationMembershipEvent,
  upsertOrganizationMembership,
} from '@/lib/auth-tenant-membership';
import { isMultiWorkspaceEnabled } from '@/backend/tenant/multi-workspace-env';
import { withDeadlockRetry } from '@/backend/tenant/txn-retry';

/**
 * Membership status as surfaced to the admin UI.
 *
 * Flag OFF (legacy): derived from the user's password_hash sentinel: a
 * freshly-invited teammate who has not yet set a password carries
 * `password_hash = 'invited_pending'` and reads as 'invited'; everyone else
 * (credentials users, oauth_managed Google users) reads as 'active'. There is
 * no separate status column — this is a projection.
 *
 * Flag ON (multi-workspace Phase 2): status comes from the
 * organization_memberships row for THIS workspace. Sentinel dichotomy (plan
 * eng finding 2): `INVITED_PENDING_PASSWORD` keeps meaning "this ACCOUNT has
 * no credentials yet"; `membership.status` owns "is this person in this
 * WORKSPACE" — an existing active account invited to a second workspace is
 * 'invited' HERE while remaining fully active elsewhere.
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

// Loosely typed to match both pg's PoolClient and injected test fakes; each
// call site narrows the rows it reads explicitly.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Queryable = {
  query: (sql: string, params: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
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

function toIso(value: string | Date | null | undefined): string {
  if (value instanceof Date) return value.toISOString();
  return value ? String(value) : '';
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

  return (result.rows[0] as DbRow | undefined) ?? null;
}

type MembershipRow = {
  role: TenantRole;
  status: TenantMemberStatus;
  created_at: string | Date;
};

/** Load (and, in a transaction, lock) the (user, org) membership row. */
async function loadMembershipRow(
  queryable: Queryable,
  input: { userId: string | number; organizationId: string | number; forUpdate?: boolean },
): Promise<MembershipRow | null> {
  const result = await queryable.query(
    `
      SELECT role, status, created_at
      FROM organization_memberships
      WHERE user_id = $1 AND organization_id = $2
      LIMIT 1${input.forUpdate ? '\n      FOR UPDATE' : ''}
    `,
    [Number(input.userId), Number(input.organizationId)],
  );
  return (result.rows[0] as MembershipRow | undefined) ?? null;
}

/**
 * Last-admin guard (multi-workspace plan CEO E4 + eng finding 4). Locks the
 * org's ACTIVE tenant_admin membership rows FOR UPDATE — the per-org
 * serialization that makes symmetric concurrent demotes safe under READ
 * COMMITTED (both demotes serialize on these row locks; the second re-reads
 * the committed state and sees zero OTHER admins) — then reports whether any
 * active admin other than the target remains. MUST run inside the caller's
 * transaction, before the conditional write.
 */
async function otherActiveAdminExists(
  queryable: Queryable,
  input: { organizationId: string | number; excludingUserId: string | number },
): Promise<boolean> {
  const result = await queryable.query(
    `
      SELECT user_id
      FROM organization_memberships
      WHERE organization_id = $1 AND role = 'tenant_admin' AND status = 'active'
      FOR UPDATE
    `,
    [Number(input.organizationId)],
  );
  return result.rows.some(
    (row: { user_id: string | number }) => String(row.user_id) !== String(input.excludingUserId),
  );
}

export async function listTenantUserProfiles(
  queryable: Queryable,
  tenantId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<TenantUserProfile[]> {
  if (isMultiWorkspaceEnabled(env)) {
    // Members of the org = membership rows (multi-workspace Phase 2). Status
    // and role come from the membership, never the global sentinel/role —
    // an existing account invited to this workspace shows 'invited' here even
    // though their ACCOUNT has credentials and is active elsewhere.
    const result = await queryable.query(
      `
        SELECT
          u.id,
          m.organization_id,
          u.email,
          u.full_name,
          m.role,
          m.status AS membership_status,
          m.created_at
        FROM organization_memberships m
        JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = $1
        ORDER BY u.id ASC
      `,
      [Number(tenantId)],
    );
    return result.rows.map(
      (row: DbRow & { membership_status: TenantMemberStatus }): TenantUserProfile => ({
        userId: String(row.id),
        tenantId: String(row.organization_id),
        email: row.email,
        fullName: row.full_name ?? null,
        role: row.role,
        status: row.membership_status === 'invited' ? 'invited' : 'active',
        createdAt: toIso(row.created_at),
      }),
    );
  }

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

/**
 * Membership-invite upsert (multi-workspace Phase 2). Unlike the generic
 * upsertOrganizationMembership, this can NEVER downgrade an 'active' row back
 * to 'invited': on conflict it keeps the existing status, and only refreshes
 * the invite role while the row is still 'invited' (an active member's role is
 * owned by the role-edit path, not a stale re-invite). This is what makes a
 * concurrent duplicate invite idempotent instead of a 500 or a status
 * regression (CEO hardening 2).
 */
export async function upsertInvitedMembership(
  queryable: Queryable,
  input: {
    userId: string | number;
    organizationId: string | number;
    role: TenantRole;
    invitedByUserId: string | number | null;
  },
): Promise<void> {
  await queryable.query(
    `
      INSERT INTO organization_memberships
        (user_id, organization_id, role, status, invited_by_user_id, invited_at, created_at, updated_at)
      VALUES ($1, $2, $3, 'invited', $4, now(), now(), now())
      ON CONFLICT (user_id, organization_id) DO UPDATE SET
        role = CASE
          WHEN organization_memberships.status = 'active' THEN organization_memberships.role
          ELSE EXCLUDED.role
        END,
        invited_by_user_id = COALESCE(organization_memberships.invited_by_user_id, EXCLUDED.invited_by_user_id),
        invited_at = COALESCE(organization_memberships.invited_at, now()),
        updated_at = now()
    `,
    [
      Number(input.userId),
      Number(input.organizationId),
      input.role,
      input.invitedByUserId === null || input.invitedByUserId === undefined
        ? null
        : Number(input.invitedByUserId),
    ],
  );
}

export type FindOrCreateInvitedProfileResult = {
  profile: TenantUserProfile;
  /** true when this call inserted the users row; false when it attached to an existing account. */
  created: boolean;
  /** true when the (possibly pre-existing) account still carries the pending-password sentinel. */
  pendingCredentials: boolean;
};

/**
 * Find-or-create the invited user + membership (multi-workspace Phase 2,
 * eng finding 6 — cross-org concurrent FIRST invite). User creation is
 * create-or-select via `ON CONFLICT (LOWER(email)) DO NOTHING`: two admins in
 * different orgs inviting the same brand-new email race the users' email
 * uniqueness, and the loser attaches a membership to the winner's user row
 * instead of 500ing. The arbiter targets the `idx_users_email_lower_unique`
 * functional index (Phase 4 hardening, PR #764 follow-up) rather than the
 * column-level UNIQUE, so a same-instant CASE-VARIANT collision (`Foo@x.com`
 * vs `foo@x.com`) also reaches the clean loser-attaches path instead of a raw
 * 23505 — the functional index is the one that actually protects
 * one-email-one-account. The membership upsert is itself conflict-safe
 * (concurrent duplicate invite in the SAME org → idempotent).
 *
 * Flag-ON only; runs inside the caller's invite transaction. Never touches an
 * existing account's credentials, pointer, name, or global role.
 */
export async function findOrCreateInvitedTenantUserProfile(
  queryable: Queryable,
  input: {
    tenantId: string;
    email: string;
    fullName?: string | null;
    role: TenantRole;
    invitedByUserId?: string | null;
  },
): Promise<FindOrCreateInvitedProfileResult> {
  const email = input.email.trim().toLowerCase();
  if (!email) {
    throw new Error('missing_required_fields:email');
  }
  assertTenantRole(input.role);

  const inserted = await queryable.query(
    `
      INSERT INTO users (email, password_hash, full_name, organization_id, role)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (LOWER(email)) DO NOTHING
      RETURNING
        id,
        organization_id,
        email,
        full_name,
        role,
        password_hash,
        created_at
    `,
    [email, INVITED_PENDING_PASSWORD, input.fullName ?? null, Number(input.tenantId), input.role],
  );

  let userRow = (inserted.rows[0] as DbRow | undefined) ?? null;
  const created = userRow !== null;
  if (!userRow) {
    // Lost the race — attach to the winner's row.
    const existing = await queryable.query(
      `
        SELECT id, organization_id, email, full_name, role, password_hash, created_at
        FROM users
        WHERE LOWER(email) = LOWER($1)
        LIMIT 1
      `,
      [email],
    );
    userRow = (existing.rows[0] as DbRow | undefined) ?? null;
    if (!userRow) {
      throw new Error('invited_user_create_or_select_failed');
    }
  }

  await upsertInvitedMembership(queryable, {
    userId: userRow.id,
    organizationId: input.tenantId,
    role: input.role,
    invitedByUserId: input.invitedByUserId ?? null,
  });

  return {
    profile: {
      userId: String(userRow.id),
      tenantId: String(input.tenantId),
      email: userRow.email,
      fullName: userRow.full_name ?? null,
      role: input.role,
      status: 'invited',
      createdAt: toIso(userRow.created_at),
    },
    created,
    pendingCredentials: userRow.password_hash === INVITED_PENDING_PASSWORD,
  };
}

export async function getTenantUserProfileById(
  queryable: Queryable,
  input: { tenantId: string; userId: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ status: 'ok'; profile: TenantUserProfile } | { status: 'not_found' | 'tenant_mismatch' }> {
  const row = await loadUserById(queryable, input.userId);
  if (!row) {
    return { status: 'not_found' };
  }

  if (isMultiWorkspaceEnabled(env)) {
    const membership = await loadMembershipRow(queryable, {
      userId: input.userId,
      organizationId: input.tenantId,
    });
    if (membership) {
      return {
        status: 'ok',
        profile: {
          userId: String(row.id),
          tenantId: String(input.tenantId),
          email: row.email,
          fullName: row.full_name ?? null,
          role: membership.role,
          status: membership.status === 'invited' ? 'invited' : 'active',
          createdAt: toIso(membership.created_at),
        },
      };
    }
    // Drift tolerance: a legacy pointer-member without a membership row still
    // reads through the sentinel projection (the resolver self-heal converges
    // the row on their next sign-in).
    if (String(row.organization_id) === String(input.tenantId)) {
      return { status: 'ok', profile: toTenantUserProfile(row) };
    }
    return { status: 'tenant_mismatch' };
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
    /** Admin performing the edit — recorded on the role_changed audit event (flag ON). */
    actorUserId?: string | null;
  },
  env: NodeJS.ProcessEnv = process.env,
): Promise<
  { status: 'ok'; profile: TenantUserProfile } | { status: 'not_found' | 'tenant_mismatch' | 'last_admin' }
> {
  if (isMultiWorkspaceEnabled(env)) {
    // Bounded 40P01 retry (Phase 4 hardening): symmetric concurrent demotes take
    // cross-table locks (memberships + the FK share locks of the role_changed
    // audit insert) in opposing order → Postgres deadlocks one arm before the E4
    // guard's FOR UPDATE can return the graceful `last_admin`. Retrying the whole
    // txn lets the loser re-read committed state under fresh locks and reach that
    // graceful path instead of surfacing a retriable 500.
    return withDeadlockRetry(
      () => updateTenantUserProfileWithMemberships(queryable, input),
      { label: 'update-member-role' },
    );
  }

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

/**
 * Flag-ON member edit (multi-workspace Phase 2): the ROLE lives on the
 * membership row; users.role is only mirrored when the edited membership is
 * the user's ACTIVE workspace (pointer match — plan eng finding 10, every
 * mirror write deliberate). Role DOWNGRADES of the org's only active
 * tenant_admin are refused under per-org FOR UPDATE serialization (E4 +
 * eng finding 4). Runs its own transaction.
 */
async function updateTenantUserProfileWithMemberships(
  queryable: Queryable,
  input: {
    tenantId: string;
    userId: string;
    fullName?: string | null;
    role?: TenantRole;
    actorUserId?: string | null;
  },
): Promise<
  { status: 'ok'; profile: TenantUserProfile } | { status: 'not_found' | 'tenant_mismatch' | 'last_admin' }
> {
  if (input.role !== undefined) {
    assertTenantRole(input.role);
  }

  await queryable.query('BEGIN', []);
  try {
    const userResult = await queryable.query(
      `
        SELECT id, organization_id, email, full_name, role, password_hash, created_at
        FROM users
        WHERE id = $1
        LIMIT 1
        FOR UPDATE
      `,
      [Number(input.userId)],
    );
    const current = (userResult.rows[0] as DbRow | undefined) ?? null;
    if (!current) {
      await queryable.query('ROLLBACK', []);
      return { status: 'not_found' };
    }

    const membership = await loadMembershipRow(queryable, {
      userId: input.userId,
      organizationId: input.tenantId,
      forUpdate: true,
    });
    if (!membership) {
      if (String(current.organization_id) !== String(input.tenantId)) {
        await queryable.query('ROLLBACK', []);
        return { status: 'tenant_mismatch' };
      }
      // Drift tolerance (legacy pointer-member without a row): fall back to
      // the legacy single-row update; the resolver self-heal converges the
      // membership on their next sign-in.
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
        [nextFullName ?? null, nextRole, Number(input.userId), Number(input.tenantId)],
      );
      await queryable.query('COMMIT', []);
      return { status: 'ok', profile: toTenantUserProfile(updated.rows[0]) };
    }

    const nextFullName = input.fullName === undefined ? current.full_name : input.fullName;
    const nextRole = input.role === undefined ? membership.role : input.role;
    assertTenantRole(nextRole);

    // Last-admin guard on role DOWNGRADE (E4): refuse to strip the org's only
    // active tenant_admin. Serialized per-org via FOR UPDATE row locks so
    // symmetric concurrent demotes cannot produce zero admins.
    if (
      membership.status === 'active' &&
      membership.role === 'tenant_admin' &&
      nextRole !== 'tenant_admin'
    ) {
      const hasOtherAdmin = await otherActiveAdminExists(queryable, {
        organizationId: input.tenantId,
        excludingUserId: input.userId,
      });
      if (!hasOtherAdmin) {
        await queryable.query('ROLLBACK', []);
        return { status: 'last_admin' };
      }
    }

    if (nextRole !== membership.role) {
      await queryable.query(
        `UPDATE organization_memberships SET role = $1, updated_at = now()
          WHERE user_id = $2 AND organization_id = $3`,
        [nextRole, Number(input.userId), Number(input.tenantId)],
      );
      await recordOrganizationMembershipEvent(queryable as never, {
        organizationId: input.tenantId,
        userId: input.userId,
        actorUserId: input.actorUserId ?? null,
        eventType: 'role_changed',
        metadata: { from: membership.role, to: nextRole },
      });
    }

    if ((nextFullName ?? null) !== (current.full_name ?? null)) {
      await queryable.query(`UPDATE users SET full_name = $1 WHERE id = $2`, [
        nextFullName ?? null,
        Number(input.userId),
      ]);
    }

    // users.role legacy-mirror sync — ONLY when editing the membership of the
    // user's ACTIVE workspace (pointer match). Editing their role in another
    // workspace must never leak into the global mirror (eng finding 10).
    if (nextRole !== membership.role && String(current.organization_id) === String(input.tenantId)) {
      await queryable.query(`UPDATE users SET role = $1 WHERE id = $2`, [
        nextRole,
        Number(input.userId),
      ]);
    }

    await queryable.query('COMMIT', []);
    return {
      status: 'ok',
      profile: {
        userId: String(current.id),
        tenantId: String(input.tenantId),
        email: current.email,
        fullName: nextFullName ?? null,
        role: nextRole,
        status: membership.status === 'invited' ? 'invited' : 'active',
        createdAt: toIso(membership.created_at),
      },
    };
  } catch (error) {
    await queryable.query('ROLLBACK', []);
    throw error;
  }
}

export async function deleteTenantUserProfile(
  queryable: Queryable,
  input: {
    tenantId: string;
    userId: string;
    /** Admin performing the removal — recorded on the 'removed' audit event (flag ON). */
    actorUserId?: string | null;
  },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ status: 'deleted' | 'not_found' | 'tenant_mismatch' | 'last_admin' }> {
  if (isMultiWorkspaceEnabled(env)) {
    // Bounded 40P01 retry (Phase 4 hardening): the accept-vs-revoke race locks
    // users / memberships / invitations (+ the removed-event FK share locks) in
    // opposing order to acceptJoinInvitation, so a concurrent accept + revoke can
    // deadlock this arm. Retrying the whole txn reaches the graceful outcome
    // (clean removal, or a no-op if the row is already gone) instead of a 500.
    return withDeadlockRetry(
      () => deleteTenantUserProfileWithMemberships(queryable, input),
      { label: 'remove-member' },
    );
  }

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

/**
 * Flag-ON remove-member (multi-workspace Phase 2, Decision 5): deletes the
 * MEMBERSHIP row only — NEVER the users row (the account and its other
 * memberships survive). In the SAME transaction it:
 *  - refuses to remove the org's only active tenant_admin (E4 guard, per-org
 *    FOR UPDATE serialization);
 *  - expires the (user, org) invitations so a revoked invite's token dies with
 *    the membership (accept-vs-revoke race → 'expired', never a silent join);
 *  - repoints users.organization_id when the removed workspace was the user's
 *    active pointer — next active membership by MRU, else NULL — closing the
 *    deleted-membership + intact-pointer self-heal resurrection window;
 *  - writes the 'removed' audit event with the acting admin.
 */
async function deleteTenantUserProfileWithMemberships(
  queryable: Queryable,
  input: { tenantId: string; userId: string; actorUserId?: string | null },
): Promise<{ status: 'deleted' | 'not_found' | 'tenant_mismatch' | 'last_admin' }> {
  await queryable.query('BEGIN', []);
  try {
    const userResult = await queryable.query(
      `
        SELECT id, organization_id, email, full_name, role, password_hash, created_at
        FROM users
        WHERE id = $1
        LIMIT 1
        FOR UPDATE
      `,
      [Number(input.userId)],
    );
    const current = (userResult.rows[0] as DbRow | undefined) ?? null;
    if (!current) {
      await queryable.query('ROLLBACK', []);
      return { status: 'not_found' };
    }

    const membership = await loadMembershipRow(queryable, {
      userId: input.userId,
      organizationId: input.tenantId,
      forUpdate: true,
    });
    const pointerHere = String(current.organization_id) === String(input.tenantId);
    if (!membership && !pointerHere) {
      await queryable.query('ROLLBACK', []);
      return { status: 'tenant_mismatch' };
    }

    if (membership && membership.status === 'active' && membership.role === 'tenant_admin') {
      const hasOtherAdmin = await otherActiveAdminExists(queryable, {
        organizationId: input.tenantId,
        excludingUserId: input.userId,
      });
      if (!hasOtherAdmin) {
        await queryable.query('ROLLBACK', []);
        return { status: 'last_admin' };
      }
    }

    await queryable.query(
      `DELETE FROM organization_memberships WHERE user_id = $1 AND organization_id = $2`,
      [Number(input.userId), Number(input.tenantId)],
    );

    // Kill outstanding invitation tokens for THIS org so a removed/revoked
    // invitee's emailed link dies now instead of activating later.
    await queryable.query(
      `UPDATE workspace_invitations SET expires_at = now()
        WHERE user_id = $1 AND organization_id = $2 AND accepted_at IS NULL AND expires_at > now()`,
      [Number(input.userId), Number(input.tenantId)],
    );

    let repointedTo: string | null = null;
    if (pointerHere) {
      const next = await queryable.query(
        `
      SELECT organization_id, role
      FROM organization_memberships
      WHERE user_id = $1 AND status = 'active'
      ORDER BY last_active_at DESC NULLS LAST, created_at ASC, organization_id ASC
      LIMIT 1
    `,
        [Number(input.userId)],
      );
      const target = next.rows[0] as { organization_id: string | number; role: TenantRole } | undefined;
      if (target) {
        // Pointer and legacy role mirror move together (no skew window).
        await queryable.query(`UPDATE users SET organization_id = $1, role = $2 WHERE id = $3`, [
          Number(target.organization_id),
          target.role,
          Number(input.userId),
        ]);
        repointedTo = String(target.organization_id);
      } else {
        await queryable.query(`UPDATE users SET organization_id = NULL WHERE id = $1`, [
          Number(input.userId),
        ]);
      }
    }

    await recordOrganizationMembershipEvent(queryable as never, {
      organizationId: input.tenantId,
      userId: input.userId,
      actorUserId: input.actorUserId ?? null,
      eventType: 'removed',
      metadata: {
        role: membership?.role ?? current.role,
        membership_status: membership?.status ?? null,
        repointed_to_organization_id: repointedTo === null ? null : Number(repointedTo),
      },
    });

    await queryable.query('COMMIT', []);
    return { status: 'deleted' };
  } catch (error) {
    await queryable.query('ROLLBACK', []);
    throw error;
  }
}
