import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

import type { TenantRole } from '@/lib/tenant-context';
import {
  recordOrganizationMembershipEvent,
  upsertOrganizationMembership,
} from '@/lib/auth-tenant-membership';
import { isMultiWorkspaceEnabled } from '@/backend/tenant/multi-workspace-env';
import { assertMultiWorkspaceEntitlement } from '@/backend/tenant/entitlements';
import {
  INVITED_PENDING_PASSWORD,
  createTenantUserProfile,
  findOrCreateInvitedTenantUserProfile,
  getTenantUserProfileById,
  updateTenantUserProfile,
  upsertInvitedMembership,
  type TenantUserProfile,
} from '@/backend/tenant/user-profiles';

// Invitation links are valid for 7 days. A teammate who lets it lapse gets a
// fresh link via the admin's "Resend invite" action — we never silently extend.
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Same policy enforced by the reset-password route and the auth forms: 8+ chars
// with an uppercase letter, a digit, and a special character. Kept in sync by
// hand — there is no shared module these all import.
const PASSWORD_RE = /^(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&]).{8,}$/;

const BCRYPT_ROUNDS = 12;

// Loosely typed to match both pg's PoolClient and the user-profiles helpers
// (whose Queryable returns DbRow[]). `rows` is `any[]` so this object can be
// forwarded into createTenantUserProfile / updateTenantUserProfile without a
// cast; each call site narrows the rows it reads explicitly.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Queryable = {
  query: (sql: string, params: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
};

export type InviteWorkspaceMemberResult =
  | { status: 'invited' | 'reinvited'; profile: TenantUserProfile; rawToken: string; expiresAt: Date }
  // Absorb-orphan interim relief (multi-workspace plan Phase 0.5): the invited
  // email backs an existing ACTIVE account whose current workspace is an orphan
  // (sole member, no onboarding, zero activity). An invitation row was created
  // for that existing user; accepting it — with a signed-in, email-matched
  // consent click — folds their unused workspace into the inviting one. No
  // profile is returned: the invitee is NOT a member of this org until accept.
  | { status: 'invited_existing_orphan'; email: string; role: TenantRole; rawToken: string; expiresAt: Date }
  // Multi-workspace Phase 2 (flag ON, Decision 4): the invited email backs an
  // existing ACTIVE account elsewhere whose workspace is NOT an orphan. A
  // status='invited' membership row + invitation were created; accepting —
  // signed in as the invited account — ADDS this workspace to their account
  // (no credential writes ever). The admin-facing copy is "Added — pending
  // their acceptance"; the email says to sign in with existing credentials.
  | { status: 'invited_existing_account'; email: string; role: TenantRole; rawToken: string; expiresAt: Date }
  | { status: 'already_member' | 'email_taken' | 'invalid_role' | 'missing_email' };

export type ResendInvitationResult =
  | {
      status: 'ok';
      email: string;
      role: TenantRole;
      rawToken: string;
      expiresAt: Date;
      /**
       * Flag-ON only: which email copy applies — 'set_password' for a
       * pending-sentinel account, 'existing_account' for an active account
       * invited to an additional workspace. Absent flag-OFF (byte-identical).
       */
      emailVariant?: 'set_password' | 'existing_account';
    }
  | { status: 'not_found' | 'tenant_mismatch' | 'already_active' };

export type AcceptInvitationResult =
  | { status: 'ok'; email: string }
  // Flag-ON only (multi-workspace Phase 2, eng finding 5): the account gained
  // real credentials between invite and accept (e.g. it accepted a sibling
  // org's invite first). The password write is refused and the caller shows a
  // VISIBLE existing-account variant ("sign in with the password you just
  // set") instead of a silent discard. Flag-OFF keeps collapsing to 'invalid'.
  | { status: 'not_pending' }
  | { status: 'invalid' | 'expired' | 'already_accepted' | 'weak_password' };

/**
 * Join-as-existing-account consent accept (multi-workspace Phase 2). See
 * acceptJoinInvitation.
 */
export type AcceptJoinResult =
  | { status: 'ok'; email: string; organizationId: string }
  | { status: 'already_member'; email: string }
  // Decision 13: attaching a SECOND active membership to a free account. The
  // transaction is rolled back — the invited membership + invitation PERSIST
  // so the invitee can accept later after upgrading. API maps this to
  // 402 { code: 'multi_workspace_requires_pro' }.
  | { status: 'requires_pro' }
  // The inviting workspace was deleted before accept (CEO hardening 6) —
  // rescued to a user-visible "this workspace no longer exists".
  | { status: 'workspace_gone' }
  | { status: 'invalid' | 'expired' | 'already_accepted' | 'email_mismatch' | 'not_join' };

export type DescribeInvitationResult =
  | { status: 'valid' | 'expired' | 'already_accepted'; email: string }
  | { status: 'invalid' };

// Extended read-only token check for the accept page (Phase 0.5 + Phase 2).
// `mode` distinguishes the legacy set-password flow (pending-sentinel account)
// from the absorb-consent flow (existing active account, orphan workspace)
// and — flag ON — the join-as-existing-account flow (existing active account
// with a status='invited' membership: activation only, no credential writes);
// the workspace/inviter/role context feeds the consent page's disclosure copy.
export type InvitationAcceptContext =
  | { status: 'invalid' }
  | { status: 'expired' | 'already_accepted'; email: string }
  | {
      status: 'valid';
      email: string;
      mode: 'set_password' | 'absorb' | 'join';
      workspaceName: string | null;
      inviterName: string | null;
      role: TenantRole;
    };

export type OrphanWorkspaceCheck =
  | { orphan: true }
  | { orphan: false; reason: 'no_workspace' | 'has_other_members' | 'onboarding_completed' | 'has_activity' };

export type AcceptAbsorbResult =
  | { status: 'ok'; email: string; organizationId: string }
  | { status: 'already_member'; email: string }
  | { status: 'invalid' | 'expired' | 'already_accepted' | 'email_mismatch' | 'not_absorb' | 'workspace_in_use' };

export type DeclineAbsorbResult = { status: 'ok' | 'invalid' | 'email_mismatch' };

const TENANT_ROLES = new Set<TenantRole>(['tenant_admin', 'tenant_analyst', 'tenant_viewer']);

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** sha256 hex of the raw token. Only the hash is ever persisted. */
export function hashInviteToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

/** A URL-safe 256-bit token plus its stored hash. */
export function generateInviteToken(): { rawToken: string; tokenHash: string } {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  return { rawToken, tokenHash: hashInviteToken(rawToken) };
}

async function insertInvitationRow(
  queryable: Queryable,
  input: {
    organizationId: string;
    userId: string;
    email: string;
    role: TenantRole;
    invitedByUserId: string | null;
    /**
     * Multi-workspace Phase 2 (flag ON): scope the supersede to
     * (user_id, organization_id) so an org-B invite can no longer kill a
     * pending org-A invitation. Flag OFF keeps the legacy user-wide supersede
     * (byte-identical — one org per user makes the two equivalent anyway).
     */
    supersedeScope?: 'user' | 'user_org';
  },
): Promise<{ rawToken: string; expiresAt: Date }> {
  const { rawToken, tokenHash } = generateInviteToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

  // Supersede any still-live invitation for this user so only the newest token
  // works. Without this, every re-invite/resend would leave the prior token
  // independently usable until its own 7-day expiry (mirrors the way
  // reset-password invalidates sibling rows on issue).
  if (input.supersedeScope === 'user_org') {
    await queryable.query(
      `UPDATE workspace_invitations
        SET expires_at = now()
      WHERE user_id = $1 AND organization_id = $2 AND accepted_at IS NULL AND expires_at > now()`,
      [Number(input.userId), Number(input.organizationId)],
    );
  } else {
    await queryable.query(
      `UPDATE workspace_invitations
        SET expires_at = now()
      WHERE user_id = $1 AND accepted_at IS NULL AND expires_at > now()`,
      [Number(input.userId)],
    );
  }

  await queryable.query(
    `
      INSERT INTO workspace_invitations
        (organization_id, user_id, email, role, token_hash, invited_by_user_id, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `,
    [
      Number(input.organizationId),
      Number(input.userId),
      input.email,
      input.role,
      tokenHash,
      input.invitedByUserId === null ? null : Number(input.invitedByUserId),
      expiresAt,
    ],
  );

  return { rawToken, expiresAt };
}

/**
 * Orphan-workspace predicate (multi-workspace plan Phase 0.5). A user's current
 * workspace is an orphan when it is (a) sole-member — no other users row points
 * at it and no other membership row exists for it, (b) never onboarded — no
 * business_profiles row for the tenant and the invitee never completed
 * onboarding, and (c) has zero activity — no posts, no connected accounts, no
 * creative assets. One round-trip, sequential by construction (guardrail #1:
 * no Promise.all fan-out). Fails CLOSED: any ambiguity reads as "not orphan",
 * which degrades to today's email_taken behavior.
 *
 * The invite-time evaluation is advisory only; the absorb accept re-runs this
 * INSIDE its transaction (eng review finding 3a — the invite-time check cannot
 * be trusted at accept time).
 */
export async function evaluateOrphanWorkspace(
  queryable: Queryable,
  input: { organizationId: string | number | null | undefined; userId: string | number },
): Promise<OrphanWorkspaceCheck> {
  const orgId =
    input.organizationId === null || input.organizationId === undefined
      ? Number.NaN
      : Number(input.organizationId);
  if (!Number.isFinite(orgId) || orgId <= 0) {
    return { orphan: false, reason: 'no_workspace' };
  }

  const result = await queryable.query(
    `
      SELECT
        (SELECT COUNT(*)::int FROM users WHERE organization_id = $1) AS member_count,
        (SELECT COUNT(*)::int FROM organization_memberships
          WHERE organization_id = $1 AND user_id <> $2) AS other_membership_count,
        (SELECT onboarding_completed_at FROM users WHERE id = $2) AS invitee_onboarding_completed_at,
        EXISTS (SELECT 1 FROM business_profiles WHERE tenant_id = $1) AS has_business_profile,
        EXISTS (SELECT 1 FROM posts WHERE tenant_id = $1) AS has_posts,
        EXISTS (SELECT 1 FROM connected_accounts WHERE tenant_id = $1) AS has_connected_accounts,
        EXISTS (SELECT 1 FROM creative_assets WHERE tenant_id = $1) AS has_creative_assets
    `,
    [orgId, Number(input.userId)],
  );
  const row = result.rows[0] as
    | {
        member_count: number | string;
        other_membership_count: number | string;
        invitee_onboarding_completed_at: string | Date | null;
        has_business_profile: boolean;
        has_posts: boolean;
        has_connected_accounts: boolean;
        has_creative_assets: boolean;
      }
    | undefined;
  if (!row) {
    return { orphan: false, reason: 'has_activity' };
  }
  if (Number(row.member_count) !== 1 || Number(row.other_membership_count) !== 0) {
    return { orphan: false, reason: 'has_other_members' };
  }
  // Any onboarding progress at all (a business_profiles row exists, or the
  // invitee ever completed onboarding) disqualifies — deliberately broader than
  // "completed" so a half-onboarded workspace is never silently absorbed.
  if (row.invitee_onboarding_completed_at || row.has_business_profile) {
    return { orphan: false, reason: 'onboarding_completed' };
  }
  if (row.has_posts || row.has_connected_accounts || row.has_creative_assets) {
    return { orphan: false, reason: 'has_activity' };
  }
  return { orphan: true };
}

/**
 * Add (or re-invite) a teammate to the organization and mint a single-use
 * invitation token. Idempotent for a still-pending invitee in the same org:
 * it refreshes their role/name and issues a fresh token. Refuses to touch a
 * user who already belongs to another org — UNLESS that other workspace is an
 * orphan (Phase 0.5 absorb relief), in which case an invitation row is created
 * for the existing user and the caller sends the absorb-variant email. Also
 * refuses an already-active member of this org. Caller is responsible for
 * sending the email with the returned rawToken.
 *
 * Runs inside its own transaction so a user row is never created without an
 * accompanying invitation row.
 */
export async function inviteWorkspaceMember(
  queryable: Queryable,
  input: {
    organizationId: string;
    email: string;
    fullName?: string | null;
    role?: TenantRole;
    invitedByUserId?: string | null;
  },
  env: NodeJS.ProcessEnv = process.env,
): Promise<InviteWorkspaceMemberResult> {
  const email = normalizeEmail(input.email ?? '');
  if (!email) {
    return { status: 'missing_email' };
  }

  const role = input.role ?? 'tenant_analyst';
  if (!TENANT_ROLES.has(role)) {
    return { status: 'invalid_role' };
  }

  if (isMultiWorkspaceEnabled(env)) {
    return inviteWorkspaceMemberWithMemberships(queryable, {
      organizationId: input.organizationId,
      email,
      fullName: input.fullName,
      role,
      invitedByUserId: input.invitedByUserId ?? null,
    });
  }

  const existing = await queryable.query(
    `SELECT id, organization_id, password_hash FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
    [email],
  );
  const row = existing.rows[0] as
    | { id: string | number; organization_id: string | number | null; password_hash: string | null }
    | undefined;

  if (row) {
    const sameOrg = String(row.organization_id) === String(input.organizationId);
    const pending = row.password_hash === INVITED_PENDING_PASSWORD;
    if (!sameOrg) {
      // The email backs a user in a different workspace. We never reassign an
      // existing account across tenant boundaries on admin action — but when
      // that other workspace is an ORPHAN (sole member, never onboarded, zero
      // activity) we productize this year's manual-SQL support fix: mint an
      // invitation for the existing account and let the INVITEE consent to
      // folding their unused workspace in (Phase 0.5). A pending-sentinel
      // account is excluded — it cannot sign in, so it can never give the
      // signed-in consent the absorb accept requires.
      if (pending) {
        return { status: 'email_taken' };
      }
      const check = await evaluateOrphanWorkspace(queryable, {
        organizationId: row.organization_id,
        userId: row.id,
      });
      if (!check.orphan) {
        return { status: 'email_taken' };
      }

      await queryable.query('BEGIN', []);
      try {
        const { rawToken, expiresAt } = await insertInvitationRow(queryable, {
          organizationId: input.organizationId,
          userId: String(row.id),
          email,
          role,
          invitedByUserId: input.invitedByUserId ?? null,
        });
        await queryable.query('COMMIT', []);
        return { status: 'invited_existing_orphan', email, role, rawToken, expiresAt };
      } catch (error) {
        await queryable.query('ROLLBACK', []);
        throw error;
      }
    }
    if (!pending) {
      return { status: 'already_member' };
    }
  }

  await queryable.query('BEGIN', []);
  try {
    let profile: TenantUserProfile;
    let status: 'invited' | 'reinvited';

    if (row) {
      const updated = await updateTenantUserProfile(queryable, {
        tenantId: input.organizationId,
        userId: String(row.id),
        fullName: input.fullName === undefined ? undefined : input.fullName,
        role,
      });
      if (updated.status !== 'ok') {
        await queryable.query('ROLLBACK', []);
        return { status: updated.status === 'tenant_mismatch' ? 'email_taken' : 'already_member' };
      }
      profile = updated.profile;
      status = 'reinvited';
    } else {
      profile = await createTenantUserProfile(queryable, {
        tenantId: input.organizationId,
        email,
        fullName: input.fullName,
        role,
      });
      status = 'invited';
    }

    const { rawToken, expiresAt } = await insertInvitationRow(queryable, {
      organizationId: input.organizationId,
      userId: profile.userId,
      email,
      role,
      invitedByUserId: input.invitedByUserId ?? null,
    });

    await queryable.query('COMMIT', []);
    return { status, profile, rawToken, expiresAt };
  } catch (error) {
    await queryable.query('ROLLBACK', []);
    throw error;
  }
}

/**
 * Flag-ON invite (multi-workspace Phase 2, Decision 4). The invite state
 * machine, in precedence order:
 *
 *  1. ACTIVE member of THIS org (membership.status='active', or a legacy
 *     pointer-member without a row) → 'already_member' — the only refusal left.
 *  2. Pending-sentinel account invited here (same-org re-invite, or a pending
 *     account created by ANOTHER org's invite) → refresh + 'invited'/'reinvited'
 *     with the set-password email (the account still has no credentials).
 *  3. Existing ACTIVE account, no membership here, whose own workspace is an
 *     ORPHAN → Phase 0.5 absorb relief keeps precedence: invitation only, no
 *     membership row until the consent accept ('invited_existing_orphan').
 *  4. Existing ACTIVE account otherwise (the new happy path) → create/refresh a
 *     status='invited' membership + invitation ('invited_existing_account');
 *     accept ADDS this workspace — credentials are never touched.
 *  5. Brand-new email → create-or-select `ON CONFLICT (email)` (eng finding 6:
 *     two orgs racing the same new email never 500 — the loser attaches a
 *     membership to the winner's row) + membership + invitation.
 *
 * Every path supersedes tokens scoped to (user, org) — an org-B invite can no
 * longer kill a pending org-A invitation — writes an 'invited' audit event
 * when a membership is created/refreshed, and the membership upsert can never
 * downgrade an 'active' row (concurrent duplicate invite → idempotent).
 */
async function inviteWorkspaceMemberWithMemberships(
  queryable: Queryable,
  input: {
    organizationId: string;
    email: string;
    fullName?: string | null;
    role: TenantRole;
    invitedByUserId: string | null;
  },
): Promise<InviteWorkspaceMemberResult> {
  const orgId = input.organizationId;

  const existing = await queryable.query(
    `SELECT id, organization_id, email, full_name, role, password_hash, created_at
       FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
    [input.email],
  );
  const row = existing.rows[0] as
    | {
        id: string | number;
        organization_id: string | number | null;
        email: string;
        full_name: string | null;
        password_hash: string | null;
        created_at: string | Date;
      }
    | undefined;

  if (!row) {
    // Brand-new email: create-or-select + membership + invitation, one txn.
    await queryable.query('BEGIN', []);
    try {
      const created = await findOrCreateInvitedTenantUserProfile(queryable as never, {
        tenantId: orgId,
        email: input.email,
        fullName: input.fullName,
        role: input.role,
        invitedByUserId: input.invitedByUserId,
      });
      await recordOrganizationMembershipEvent(queryable as never, {
        organizationId: orgId,
        userId: created.profile.userId,
        actorUserId: input.invitedByUserId,
        eventType: 'invited',
        metadata: { role: input.role, created_user: created.created },
      });
      const { rawToken, expiresAt } = await insertInvitationRow(queryable, {
        organizationId: orgId,
        userId: created.profile.userId,
        email: input.email,
        role: input.role,
        invitedByUserId: input.invitedByUserId,
        supersedeScope: 'user_org',
      });
      await queryable.query('COMMIT', []);
      if (!created.created && !created.pendingCredentials) {
        // Lost the create race to an existing ACTIVE account — same contract
        // as the deliberate existing-account invite below.
        return { status: 'invited_existing_account', email: input.email, role: input.role, rawToken, expiresAt };
      }
      return { status: 'invited', profile: created.profile, rawToken, expiresAt };
    } catch (error) {
      await queryable.query('ROLLBACK', []);
      throw error;
    }
  }

  const pending = row.password_hash === INVITED_PENDING_PASSWORD;
  const pointerHere = String(row.organization_id) === String(orgId);

  const membershipResult = await queryable.query(
    `SELECT role, status FROM organization_memberships
      WHERE user_id = $1 AND organization_id = $2 LIMIT 1`,
    [Number(row.id), Number(orgId)],
  );
  const membership = membershipResult.rows[0] as
    | { role: TenantRole; status: 'invited' | 'active' }
    | undefined;

  if (membership?.status === 'active') {
    return { status: 'already_member' };
  }
  if (!membership && pointerHere && !pending) {
    // Legacy active pointer-member without a membership row (dark-period
    // drift): still a member — the resolver self-heal converges the row.
    return { status: 'already_member' };
  }

  if (pending) {
    // Credential-less account: same-org re-invite, or a pending account minted
    // by another org's invite. Either way the account can be invited HERE with
    // the normal set-password flow — no credentials exist to protect yet, and
    // accept activates exactly the (user, org) of the token used.
    await queryable.query('BEGIN', []);
    try {
      let fullName = row.full_name ?? null;
      if (pointerHere && input.fullName !== undefined) {
        await queryable.query(`UPDATE users SET full_name = $1 WHERE id = $2`, [
          input.fullName ?? null,
          Number(row.id),
        ]);
        fullName = input.fullName ?? null;
      }
      if (pointerHere) {
        // users.role legacy mirror — this org is the pending account's active
        // pointer (its only workspace), so the mirror tracks the invite role.
        await queryable.query(`UPDATE users SET role = $1 WHERE id = $2`, [
          input.role,
          Number(row.id),
        ]);
      }
      await upsertInvitedMembership(queryable as never, {
        userId: row.id,
        organizationId: orgId,
        role: input.role,
        invitedByUserId: input.invitedByUserId,
      });
      await recordOrganizationMembershipEvent(queryable as never, {
        organizationId: orgId,
        userId: row.id,
        actorUserId: input.invitedByUserId,
        eventType: 'invited',
        metadata: { role: input.role, reinvite: Boolean(membership) || pointerHere },
      });
      const { rawToken, expiresAt } = await insertInvitationRow(queryable, {
        organizationId: orgId,
        userId: String(row.id),
        email: input.email,
        role: input.role,
        invitedByUserId: input.invitedByUserId,
        supersedeScope: 'user_org',
      });
      await queryable.query('COMMIT', []);
      const profile: TenantUserProfile = {
        userId: String(row.id),
        tenantId: String(orgId),
        email: row.email,
        fullName,
        role: input.role,
        status: 'invited',
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      };
      return { status: pointerHere ? 'reinvited' : 'invited', profile, rawToken, expiresAt };
    } catch (error) {
      await queryable.query('ROLLBACK', []);
      throw error;
    }
  }

  if (!membership) {
    // Absorb-orphan relief keeps precedence over the second-workspace path
    // (Phase 0.5): an unused workspace is folded in (replacement, stays free),
    // not attached as a paid second workspace.
    const check = await evaluateOrphanWorkspace(queryable, {
      organizationId: row.organization_id,
      userId: row.id,
    });
    if (check.orphan) {
      await queryable.query('BEGIN', []);
      try {
        const { rawToken, expiresAt } = await insertInvitationRow(queryable, {
          organizationId: orgId,
          userId: String(row.id),
          email: input.email,
          role: input.role,
          invitedByUserId: input.invitedByUserId,
          supersedeScope: 'user_org',
        });
        await queryable.query('COMMIT', []);
        return { status: 'invited_existing_orphan', email: input.email, role: input.role, rawToken, expiresAt };
      } catch (error) {
        await queryable.query('ROLLBACK', []);
        throw error;
      }
    }
  }

  // The new happy path (Decision 4): existing ACTIVE account gains (or
  // refreshes) a status='invited' membership here; accepting adds this
  // workspace to their account with zero credential writes.
  await queryable.query('BEGIN', []);
  try {
    await upsertInvitedMembership(queryable as never, {
      userId: row.id,
      organizationId: orgId,
      role: input.role,
      invitedByUserId: input.invitedByUserId,
    });
    await recordOrganizationMembershipEvent(queryable as never, {
      organizationId: orgId,
      userId: row.id,
      actorUserId: input.invitedByUserId,
      eventType: 'invited',
      metadata: { role: input.role, existing_account: true, reinvite: Boolean(membership) },
    });
    const { rawToken, expiresAt } = await insertInvitationRow(queryable, {
      organizationId: orgId,
      userId: String(row.id),
      email: input.email,
      role: input.role,
      invitedByUserId: input.invitedByUserId,
      supersedeScope: 'user_org',
    });
    await queryable.query('COMMIT', []);
    return { status: 'invited_existing_account', email: input.email, role: input.role, rawToken, expiresAt };
  } catch (error) {
    await queryable.query('ROLLBACK', []);
    throw error;
  }
}

/**
 * Mint a fresh invitation token for a member who is still pending (never set a
 * password). Used by the "Resend invite" admin action. A no-op-with-signal for
 * a member who is already active.
 */
export async function resendWorkspaceInvitation(
  queryable: Queryable,
  input: { organizationId: string; userId: string; invitedByUserId?: string | null },
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResendInvitationResult> {
  if (isMultiWorkspaceEnabled(env)) {
    // Phase 2 (eng finding 2 — sentinel dichotomy): the resend gate reads
    // membership.status='invited' for (user, org), NOT the global
    // pending-password sentinel projection. This is what lets an existing
    // ACTIVE account with a pending second-workspace invite be re-sent its
    // link (and what makes the Phase-1 chooser's Accept action work for a
    // zero-pointer invitee — the pointer never enters the gate).
    const result = await queryable.query(
      `SELECT u.id, u.email, u.password_hash, m.role, m.status
         FROM organization_memberships m
         JOIN users u ON u.id = m.user_id
        WHERE m.user_id = $1 AND m.organization_id = $2
        LIMIT 1`,
      [Number(input.userId), Number(input.organizationId)],
    );
    const row = result.rows[0] as
      | { id: string | number; email: string; password_hash: string | null; role: TenantRole; status: string }
      | undefined;
    if (!row) {
      const userExists = await queryable.query(`SELECT 1 FROM users WHERE id = $1 LIMIT 1`, [
        Number(input.userId),
      ]);
      return { status: userExists.rows.length > 0 ? 'tenant_mismatch' : 'not_found' };
    }
    if (row.status !== 'invited') {
      return { status: 'already_active' };
    }
    const { rawToken, expiresAt } = await insertInvitationRow(queryable, {
      organizationId: input.organizationId,
      userId: String(row.id),
      email: row.email,
      role: row.role,
      invitedByUserId: input.invitedByUserId ?? null,
      supersedeScope: 'user_org',
    });
    return {
      status: 'ok',
      email: row.email,
      role: row.role,
      rawToken,
      expiresAt,
      emailVariant:
        row.password_hash === INVITED_PENDING_PASSWORD ? 'set_password' : 'existing_account',
    };
  }

  const lookup = await getTenantUserProfileById(
    queryable,
    {
      tenantId: input.organizationId,
      userId: input.userId,
    },
    env,
  );
  if (lookup.status !== 'ok') {
    return { status: lookup.status === 'not_found' ? 'not_found' : 'tenant_mismatch' };
  }
  if (lookup.profile.status !== 'invited') {
    return { status: 'already_active' };
  }

  const { rawToken, expiresAt } = await insertInvitationRow(queryable, {
    organizationId: input.organizationId,
    userId: lookup.profile.userId,
    email: lookup.profile.email,
    role: lookup.profile.role,
    invitedByUserId: input.invitedByUserId ?? null,
  });

  return { status: 'ok', email: lookup.profile.email, role: lookup.profile.role, rawToken, expiresAt };
}

type InvitationRow = {
  id: string | number;
  user_id: string | number;
  organization_id: string | number;
  email: string;
  role: TenantRole;
  expires_at: string | Date;
  accepted_at: string | Date | null;
};

async function loadInvitationByToken(queryable: Queryable, rawToken: string): Promise<InvitationRow | null> {
  const result = await queryable.query(
    `
      SELECT id, user_id, organization_id, email, role, expires_at, accepted_at
      FROM workspace_invitations
      WHERE token_hash = $1
      LIMIT 1
    `,
    [hashInviteToken(rawToken)],
  );
  return (result.rows[0] as InvitationRow | undefined) ?? null;
}

function isExpired(expiresAt: string | Date): boolean {
  const expiry = expiresAt instanceof Date ? expiresAt.getTime() : new Date(expiresAt).getTime();
  return Number.isFinite(expiry) ? expiry <= Date.now() : true;
}

/**
 * Read-only token check for the accept page: tells the UI whose invitation this
 * is and whether it is still usable, without consuming it.
 */
export async function describeInvitationByToken(
  queryable: Queryable,
  rawToken: string,
): Promise<DescribeInvitationResult> {
  if (!rawToken) {
    return { status: 'invalid' };
  }
  const invitation = await loadInvitationByToken(queryable, rawToken);
  if (!invitation) {
    return { status: 'invalid' };
  }
  if (invitation.accepted_at) {
    return { status: 'already_accepted', email: invitation.email };
  }
  if (isExpired(invitation.expires_at)) {
    return { status: 'expired', email: invitation.email };
  }
  return { status: 'valid', email: invitation.email };
}

/**
 * Consume an invitation: set the teammate's password and mark the invitation
 * accepted, atomically. The token is single-use — a second accept reports
 * 'already_accepted'. The user can then sign in with email + the new password.
 *
 * PENDING-SENTINEL ONLY (security fix, post-Phase-0.5 review). This is the
 * legacy brand-new-teammate flow and is gated on token possession alone (see
 * the inv-01b allowlist rationale) — it must never be reachable for an
 * account that already has real credentials, because it unconditionally
 * overwrites password_hash. Phase 0.5's absorb-orphan relief mints a live
 * invitation token whose user_id points at an EXISTING ACTIVE account (see
 * `inviteWorkspaceMember`'s orphan branch); without this guard, anyone who
 * obtained that token (e.g. a forwarded absorb-consent link) could hit THIS
 * route and unconditionally reset that active account's password — an
 * account-takeover class bug. The two accept paths are mutually exclusive on
 * the `INVITED_PENDING_PASSWORD` sentinel: an absorb-type invitation must go
 * through `acceptAbsorbInvitation`, which requires a signed-in, email-matched
 * session and never touches password_hash. The user row is loaded and its
 * sentinel re-checked INSIDE this same transaction (not before BEGIN) so a
 * concurrent absorb-accept or credential change can't race past the check.
 */
export async function acceptWorkspaceInvitation(
  queryable: Queryable,
  input: { rawToken: string; password: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<AcceptInvitationResult> {
  if (!PASSWORD_RE.test(input.password ?? '')) {
    return { status: 'weak_password' };
  }

  const multiWorkspace = isMultiWorkspaceEnabled(env);

  const invitation = await loadInvitationByToken(queryable, input.rawToken ?? '');
  if (!invitation) {
    return { status: 'invalid' };
  }
  if (invitation.accepted_at) {
    return { status: 'already_accepted' };
  }
  if (isExpired(invitation.expires_at)) {
    return { status: 'expired' };
  }

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

  await queryable.query('BEGIN', []);
  try {
    const userResult = await queryable.query(
      `SELECT id, password_hash FROM users WHERE id = $1 LIMIT 1 FOR UPDATE`,
      [Number(invitation.user_id)],
    );
    const user = userResult.rows[0] as { id: string | number; password_hash: string | null } | undefined;
    if (!user || user.password_hash !== INVITED_PENDING_PASSWORD) {
      // Not a pending-sentinel account — this is an absorb/join-type
      // invitation (or some other already-credentialed account); never run
      // the password write. Flag OFF collapses to the same non-disclosing
      // 'invalid' the route returns for a dead token. Flag ON reports the
      // typed 'not_pending' so the account that just set a password via a
      // sibling invite gets a VISIBLE "sign in with the password you just
      // set" instead of a dead-link message (eng finding 5) — the invitation
      // itself stays live for the join flow.
      await queryable.query('ROLLBACK', []);
      if (multiWorkspace && user) {
        return { status: 'not_pending' };
      }
      return { status: 'invalid' };
    }

    await queryable.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [
      passwordHash,
      Number(invitation.user_id),
    ]);
    if (multiWorkspace) {
      // Membership role: the admin may have edited the invited membership's
      // role after the invitation email went out — the membership row is the
      // freshest admin intent, so activation prefers it over the token's role.
      const membershipResult = await queryable.query(
        `SELECT role, status FROM organization_memberships
      WHERE user_id = $1 AND organization_id = $2 LIMIT 1
      FOR UPDATE`,
        [Number(invitation.user_id), Number(invitation.organization_id)],
      );
      const membershipRole = (membershipResult.rows[0] as { role?: TenantRole } | undefined)?.role;
      const activationRole =
        membershipRole && TENANT_ROLES.has(membershipRole) ? membershipRole : invitation.role;
      // Org-scoped consume (CEO F6): accepting THIS org's invitation must not
      // consume a pending sibling-org invitation — under multi-membership each
      // (user, org) invitation has its own lifecycle. The password-reset
      // hazard the legacy consume-all guarded against is closed by the
      // in-transaction sentinel re-check above: once this accept commits, the
      // account is no longer pending and a stale sibling token can never
      // reach the password write again.
      await queryable.query(
        `UPDATE workspace_invitations SET accepted_at = now() WHERE user_id = $1 AND organization_id = $2 AND accepted_at IS NULL`,
        [Number(invitation.user_id), Number(invitation.organization_id)],
      );
      await upsertOrganizationMembership(queryable as never, {
        userId: invitation.user_id,
        organizationId: invitation.organization_id,
        role: activationRole,
        status: 'active',
      });
      // Post-accept, the accepted workspace becomes the active pointer, with
      // the legacy users.role mirror moving in the SAME statement (no skew
      // window). Matters for a pending account invited by TWO orgs: the
      // pointer may still target the other org.
      await queryable.query(`UPDATE users SET organization_id = $1, role = $2 WHERE id = $3`, [
        Number(invitation.organization_id),
        activationRole,
        Number(invitation.user_id),
      ]);
      await recordOrganizationMembershipEvent(queryable as never, {
        organizationId: invitation.organization_id,
        userId: invitation.user_id,
        actorUserId: invitation.user_id,
        eventType: 'accepted',
        metadata: { invitation_id: Number(invitation.id), role: activationRole, via: 'set_password' },
      });
    } else {
      // Consume every outstanding invitation for this user, not just the token
      // that was used — so a stale sibling token can never re-set the password.
      await queryable.query(
        `UPDATE workspace_invitations SET accepted_at = now() WHERE user_id = $1 AND accepted_at IS NULL`,
        [Number(invitation.user_id)],
      );
      // Dual-write: flip the membership row to 'active' with accepted_at=now()
      // (multi-workspace Phase 0, Eng finding 1a). The row was created 'invited' by
      // createTenantUserProfile; this promotes it in the same transaction as the
      // credential + invitation writes. Additive — nothing reads it yet, and this
      // does NOT otherwise change accept semantics (that is Phase 2).
      await upsertOrganizationMembership(queryable as never, {
        userId: invitation.user_id,
        organizationId: invitation.organization_id,
        role: invitation.role,
        status: 'active',
      });
    }
    await queryable.query('COMMIT', []);
  } catch (error) {
    await queryable.query('ROLLBACK', []);
    throw error;
  }

  return { status: 'ok', email: invitation.email };
}

/**
 * Read-only token check for the accept page that also resolves WHICH accept
 * flow applies (Phase 0.5): 'set_password' for a pending-sentinel account
 * (today's flow) vs 'absorb' for an existing active account in another
 * workspace, plus the workspace/inviter/role context the consent page
 * discloses. Never consumes the token.
 */
export async function describeInvitationAcceptContext(
  queryable: Queryable,
  rawToken: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<InvitationAcceptContext> {
  if (!rawToken) {
    return { status: 'invalid' };
  }

  if (isMultiWorkspaceEnabled(env)) {
    return describeInvitationAcceptContextWithMemberships(queryable, rawToken);
  }

  const result = await queryable.query(
    `
      SELECT
        wi.id, wi.user_id, wi.organization_id, wi.email, wi.role, wi.expires_at, wi.accepted_at,
        o.name AS workspace_name,
        inviter.full_name AS inviter_name,
        u.password_hash AS invitee_password_hash,
        u.organization_id AS invitee_organization_id
      FROM workspace_invitations wi
      LEFT JOIN organizations o ON o.id = wi.organization_id
      LEFT JOIN users inviter ON inviter.id = wi.invited_by_user_id
      LEFT JOIN users u ON u.id = wi.user_id
      WHERE wi.token_hash = $1
      LIMIT 1
    `,
    [hashInviteToken(rawToken)],
  );
  const row = result.rows[0] as
    | (InvitationRow & {
        workspace_name: string | null;
        inviter_name: string | null;
        invitee_password_hash: string | null;
        invitee_organization_id: string | number | null;
      })
    | undefined;
  if (!row) {
    return { status: 'invalid' };
  }
  if (row.accepted_at) {
    return { status: 'already_accepted', email: row.email };
  }
  if (isExpired(row.expires_at)) {
    return { status: 'expired', email: row.email };
  }

  const pending = row.invitee_password_hash === INVITED_PENDING_PASSWORD;
  if (!pending && String(row.invitee_organization_id) === String(row.organization_id)) {
    // Active account already in the inviting workspace with a live token —
    // there is nothing left to accept.
    return { status: 'already_accepted', email: row.email };
  }

  return {
    status: 'valid',
    email: row.email,
    mode: pending ? 'set_password' : 'absorb',
    workspaceName: row.workspace_name ?? null,
    inviterName: row.inviter_name ?? null,
    role: row.role,
  };
}

/**
 * Flag-ON accept-context resolution (multi-workspace Phase 2). Mode dichotomy
 * for a live token, driven by account credential state + the (user, org)
 * membership row:
 *  - pending-sentinel account            → 'set_password' (today's flow);
 *  - active account, membership 'active' → already_accepted (idempotent —
 *    "You're already a member");
 *  - active account, membership 'invited'→ 'join' (activation only — the
 *    Phase 2 second-workspace consent);
 *  - active account, NO membership row   → 'absorb' (a Phase 0.5 orphan-fold
 *    invitation never creates a membership before consent).
 */
async function describeInvitationAcceptContextWithMemberships(
  queryable: Queryable,
  rawToken: string,
): Promise<InvitationAcceptContext> {
  const result = await queryable.query(
    `
      SELECT
        wi.id, wi.user_id, wi.organization_id, wi.email, wi.role, wi.expires_at, wi.accepted_at,
        o.name AS workspace_name,
        inviter.full_name AS inviter_name,
        u.password_hash AS invitee_password_hash,
        u.organization_id AS invitee_organization_id,
        m.status AS membership_status,
        m.role AS membership_role
      FROM workspace_invitations wi
      LEFT JOIN organizations o ON o.id = wi.organization_id
      LEFT JOIN users inviter ON inviter.id = wi.invited_by_user_id
      LEFT JOIN users u ON u.id = wi.user_id
      LEFT JOIN organization_memberships m
        ON m.user_id = wi.user_id AND m.organization_id = wi.organization_id
      WHERE wi.token_hash = $1
      LIMIT 1
    `,
    [hashInviteToken(rawToken)],
  );
  const row = result.rows[0] as
    | (InvitationRow & {
        workspace_name: string | null;
        inviter_name: string | null;
        invitee_password_hash: string | null;
        invitee_organization_id: string | number | null;
        membership_status: string | null;
        membership_role: TenantRole | null;
      })
    | undefined;
  if (!row) {
    return { status: 'invalid' };
  }
  if (row.accepted_at) {
    return { status: 'already_accepted', email: row.email };
  }
  if (isExpired(row.expires_at)) {
    return { status: 'expired', email: row.email };
  }

  const pending = row.invitee_password_hash === INVITED_PENDING_PASSWORD;
  const context = {
    email: row.email,
    workspaceName: row.workspace_name ?? null,
    inviterName: row.inviter_name ?? null,
    // The membership row carries the freshest admin intent when present.
    role: row.membership_role && TENANT_ROLES.has(row.membership_role) ? row.membership_role : row.role,
  };

  if (pending) {
    return { status: 'valid', mode: 'set_password', ...context };
  }
  if (row.membership_status === 'active') {
    // Already an active member of the inviting workspace — nothing to accept.
    return { status: 'already_accepted', email: row.email };
  }
  if (!row.membership_status && String(row.invitee_organization_id) === String(row.organization_id)) {
    // Legacy pointer-member without a membership row (dark-period drift).
    return { status: 'already_accepted', email: row.email };
  }
  if (row.membership_status === 'invited') {
    return { status: 'valid', mode: 'join', ...context };
  }
  return { status: 'valid', mode: 'absorb', ...context };
}

/**
 * Consume a JOIN invitation (multi-workspace Phase 2, Decision 4): activate an
 * existing ACTIVE account's status='invited' membership in the inviting
 * workspace — activation ONLY. No password write, ever; no cross-org
 * invitation consume; no absorb/repoint of the account's other workspaces.
 * Executes ONLY on the invitee's consent click, and ONLY for a signed-in
 * session that IS the invited account (the same consent-auth rule as absorb —
 * token possession alone must never mutate an account).
 *
 * One transaction, in order (eng finding 5 — lock-based accept semantics):
 *  1. lock the invitation row (FOR UPDATE) + re-check accepted_at/expiry;
 *  2. verify the session is the invited account (user id + email match);
 *  3. lock the user row (FOR UPDATE) and re-check credential state — a
 *     pending-sentinel account belongs to the set-password flow ('not_join');
 *  4. verify the inviting org still exists ('workspace_gone', never a 500);
 *  5. lock the (user, org) membership row: 'active' → idempotent
 *     already_member (consume + commit); missing → 'not_join' (an absorb
 *     invitation, or a revoked membership whose tokens die with it);
 *  6. entitlement INSIDE the txn (Decision 13): counting active memberships
 *     FOR UPDATE, an ADDITION to a free account rolls back — the invited
 *     membership + invitation PERSIST for accept-after-upgrade;
 *  7. activate exactly that (user, organization) membership (role = the
 *     membership row's own, the freshest admin intent);
 *  8. repoint users.organization_id to the accepted workspace + move the
 *     legacy users.role mirror in the same statement (post-accept "you're
 *     in" — the dashboard loads the new workspace);
 *  9. write the 'accepted' audit event (actor = invitee);
 * 10. consume outstanding invitations scoped to (user, org) — accepting org
 *     B's invite must not consume a pending org-A invitation (CEO F6).
 */
export async function acceptJoinInvitation(
  queryable: Queryable,
  input: { rawToken: string; sessionUserId: string; sessionEmail?: string | null },
  env: NodeJS.ProcessEnv = process.env,
): Promise<AcceptJoinResult> {
  if (!isMultiWorkspaceEnabled(env)) {
    // Join invitations only exist flag-ON; without the flag this endpoint's
    // machinery is invisible.
    return { status: 'invalid' };
  }
  if (!input.rawToken || !input.sessionUserId) {
    return { status: 'invalid' };
  }

  await queryable.query('BEGIN', []);
  try {
    const invResult = await queryable.query(
      `
        SELECT id, user_id, organization_id, email, role, invited_by_user_id, expires_at, accepted_at
        FROM workspace_invitations
        WHERE token_hash = $1
        LIMIT 1
        FOR UPDATE
      `,
      [hashInviteToken(input.rawToken)],
    );
    const invitation = invResult.rows[0] as
      | (InvitationRow & { invited_by_user_id: string | number | null })
      | undefined;
    if (!invitation) {
      await queryable.query('ROLLBACK', []);
      return { status: 'invalid' };
    }
    if (invitation.accepted_at) {
      await queryable.query('ROLLBACK', []);
      return { status: 'already_accepted' };
    }
    if (isExpired(invitation.expires_at)) {
      await queryable.query('ROLLBACK', []);
      return { status: 'expired' };
    }

    // Consent auth: the signed-in session must BE the invited account.
    if (String(invitation.user_id) !== String(input.sessionUserId)) {
      await queryable.query('ROLLBACK', []);
      return { status: 'email_mismatch' };
    }
    const sessionEmail = normalizeEmail(input.sessionEmail ?? '');
    if (sessionEmail && sessionEmail !== normalizeEmail(invitation.email)) {
      await queryable.query('ROLLBACK', []);
      return { status: 'email_mismatch' };
    }

    const userResult = await queryable.query(
      `
        SELECT id, email, organization_id, role, password_hash
        FROM users
        WHERE id = $1
        LIMIT 1
        FOR UPDATE
      `,
      [Number(invitation.user_id)],
    );
    const user = userResult.rows[0] as
      | {
          id: string | number;
          email: string;
          organization_id: string | number | null;
          role: string | null;
          password_hash: string | null;
        }
      | undefined;
    if (!user) {
      await queryable.query('ROLLBACK', []);
      return { status: 'invalid' };
    }
    if (user.password_hash === INVITED_PENDING_PASSWORD) {
      // A credential-less account belongs to the legacy set-password flow —
      // it can never have given signed-in consent in the first place.
      await queryable.query('ROLLBACK', []);
      return { status: 'not_join' };
    }

    const targetOrgId = Number(invitation.organization_id);

    const orgResult = await queryable.query(`SELECT id FROM organizations WHERE id = $1 LIMIT 1`, [
      targetOrgId,
    ]);
    if (orgResult.rows.length === 0) {
      // Org deleted before accept (CEO hardening 6) — user-visible rescue.
      await queryable.query('ROLLBACK', []);
      return { status: 'workspace_gone' };
    }

    const membershipResult = await queryable.query(
      `SELECT role, status FROM organization_memberships
      WHERE user_id = $1 AND organization_id = $2 LIMIT 1
      FOR UPDATE`,
      [Number(user.id), targetOrgId],
    );
    const membership = membershipResult.rows[0] as
      | { role: TenantRole; status: 'invited' | 'active' }
      | undefined;

    if (membership?.status === 'active') {
      // Idempotent convergence: already a member — consume this org's token,
      // change nothing else. Reloads and double-clicks land here.
      await queryable.query(
        `UPDATE workspace_invitations SET accepted_at = now() WHERE user_id = $1 AND organization_id = $2 AND accepted_at IS NULL`,
        [Number(user.id), targetOrgId],
      );
      await queryable.query('COMMIT', []);
      return { status: 'already_member', email: invitation.email };
    }
    if (!membership) {
      // No invited membership: this is an absorb-type invitation (Phase 0.5)
      // or the membership was revoked — either way, not a join.
      await queryable.query('ROLLBACK', []);
      return { status: 'not_join' };
    }

    // Entitlement (Decision 13): activating a membership for an account that
    // already holds ≥1 ACTIVE membership is an ADDITION and needs the paid
    // plan. Runs INSIDE this transaction, counting FOR UPDATE, so concurrent
    // accepts can't both slip under the free limit. Denial rolls back — the
    // invited membership + invitation persist for accept-after-upgrade.
    const entitlement = await assertMultiWorkspaceEntitlement(queryable, user.id);
    if (!entitlement.allowed) {
      await queryable.query('ROLLBACK', []);
      return { status: 'requires_pro' };
    }

    const activationRole =
      membership.role && TENANT_ROLES.has(membership.role) ? membership.role : invitation.role;

    await queryable.query(
      `UPDATE organization_memberships
      SET status = 'active',
          role = $1,
          accepted_at = COALESCE(accepted_at, now()),
          last_active_at = now(),
          updated_at = now()
      WHERE user_id = $2 AND organization_id = $3`,
      [activationRole, Number(user.id), targetOrgId],
    );

    // Post-accept, the accepted workspace becomes the active pointer; the
    // legacy users.role mirror moves in the SAME statement (no skew window).
    // NO password write — the account proved control by being signed in.
    await queryable.query(`UPDATE users SET organization_id = $1, role = $2 WHERE id = $3`, [
      targetOrgId,
      activationRole,
      Number(user.id),
    ]);

    await recordOrganizationMembershipEvent(queryable as never, {
      organizationId: targetOrgId,
      userId: user.id,
      actorUserId: user.id,
      eventType: 'accepted',
      metadata: {
        invitation_id: Number(invitation.id),
        role: activationRole,
        invited_by_user_id:
          invitation.invited_by_user_id === null || invitation.invited_by_user_id === undefined
            ? null
            : Number(invitation.invited_by_user_id),
        via: 'join',
      },
    });

    // Consume outstanding invitations for THIS (user, org) only — a pending
    // sibling-org invitation keeps its own lifecycle (CEO F6).
    await queryable.query(
      `UPDATE workspace_invitations SET accepted_at = now() WHERE user_id = $1 AND organization_id = $2 AND accepted_at IS NULL`,
      [Number(user.id), targetOrgId],
    );

    await queryable.query('COMMIT', []);
    return { status: 'ok', email: invitation.email, organizationId: String(targetOrgId) };
  } catch (error) {
    await queryable.query('ROLLBACK', []);
    throw error;
  }
}

/**
 * Consume an absorb invitation (Phase 0.5): fold an existing account's orphan
 * workspace into the inviting one. Executes ONLY on the invitee's consent
 * click, and ONLY for a signed-in session that IS the invited account (eng
 * review finding 3c — token possession alone must never absorb).
 *
 * One transaction, in order:
 *  1. lock the invitation row (FOR UPDATE) and re-check token validity;
 *  2. verify the session is the invited account (user id + email match);
 *  3. lock the user row (FOR UPDATE);
 *  4. re-check the FULL orphan predicate INSIDE the transaction (finding 3a) —
 *     on failure the invitation is terminated LOUDLY (expired, not silently
 *     consumed) and the caller surfaces "this workspace is now in use";
 *  5. repoint users.organization_id + set the ADMIN-CHOSEN invitation role
 *     (never the carried-over source-workspace role), with NO password write —
 *     the account is existing/active and proved control by being signed in;
 *  6. move the Phase-0 membership row in the SAME transaction (finding 3b);
 *  7. write the 'absorbed' audit event (actor = invitee: consent executes it);
 *  8. consume every outstanding invitation for the user (mirrors the legacy
 *     accept's stale-sibling-token rule).
 *
 * The old orphan org is left member-less and invisible — never deleted
 * (matches the May manual repoints). No entitlement/paywall check anywhere:
 * absorb REPLACES the old workspace, it does not add one (Decision 13c).
 */
export async function acceptAbsorbInvitation(
  queryable: Queryable,
  input: { rawToken: string; sessionUserId: string; sessionEmail?: string | null },
): Promise<AcceptAbsorbResult> {
  if (!input.rawToken || !input.sessionUserId) {
    return { status: 'invalid' };
  }

  await queryable.query('BEGIN', []);
  try {
    const invResult = await queryable.query(
      `
        SELECT id, user_id, organization_id, email, role, invited_by_user_id, expires_at, accepted_at
        FROM workspace_invitations
        WHERE token_hash = $1
        LIMIT 1
        FOR UPDATE
      `,
      [hashInviteToken(input.rawToken)],
    );
    const invitation = invResult.rows[0] as
      | (InvitationRow & { invited_by_user_id: string | number | null })
      | undefined;
    if (!invitation) {
      await queryable.query('ROLLBACK', []);
      return { status: 'invalid' };
    }
    if (invitation.accepted_at) {
      await queryable.query('ROLLBACK', []);
      return { status: 'already_accepted' };
    }
    if (isExpired(invitation.expires_at)) {
      await queryable.query('ROLLBACK', []);
      return { status: 'expired' };
    }

    // Consent auth: the signed-in session must BE the invited account. The
    // invitation was minted for exactly one existing user row; anyone else —
    // including another signed-in account holding a forwarded link — is
    // rejected without touching anything.
    if (String(invitation.user_id) !== String(input.sessionUserId)) {
      await queryable.query('ROLLBACK', []);
      return { status: 'email_mismatch' };
    }
    const sessionEmail = normalizeEmail(input.sessionEmail ?? '');
    if (sessionEmail && sessionEmail !== normalizeEmail(invitation.email)) {
      await queryable.query('ROLLBACK', []);
      return { status: 'email_mismatch' };
    }

    const userResult = await queryable.query(
      `
        SELECT id, email, organization_id, role, password_hash
        FROM users
        WHERE id = $1
        LIMIT 1
        FOR UPDATE
      `,
      [Number(invitation.user_id)],
    );
    const user = userResult.rows[0] as
      | {
          id: string | number;
          email: string;
          organization_id: string | number | null;
          role: string | null;
          password_hash: string | null;
        }
      | undefined;
    if (!user) {
      await queryable.query('ROLLBACK', []);
      return { status: 'invalid' };
    }
    if (user.password_hash === INVITED_PENDING_PASSWORD) {
      // A credential-less account belongs to the legacy set-password flow —
      // it can never have given signed-in consent in the first place.
      await queryable.query('ROLLBACK', []);
      return { status: 'not_absorb' };
    }

    const targetOrgId = Number(invitation.organization_id);
    if (String(user.organization_id) === String(targetOrgId)) {
      // Already in the inviting workspace (e.g. an earlier manual repoint):
      // converge idempotently — consume the token, change nothing else.
      await queryable.query(
        `UPDATE workspace_invitations SET accepted_at = now() WHERE user_id = $1 AND accepted_at IS NULL`,
        [Number(user.id)],
      );
      await queryable.query('COMMIT', []);
      return { status: 'already_member', email: invitation.email };
    }

    // Re-check the FULL orphan predicate inside the transaction — the
    // invite-time check is advisory and the workspace may have gained members
    // or activity since the email went out.
    const check = await evaluateOrphanWorkspace(queryable, {
      organizationId: user.organization_id,
      userId: user.id,
    });
    if (!check.orphan) {
      // Terminal + loud: expire (never accept) the token so the invitation is
      // not consumed silently, and a later click reports a dead link instead
      // of absorbing a workspace that is now in use.
      await queryable.query(
        `UPDATE workspace_invitations SET expires_at = now() WHERE id = $1 AND accepted_at IS NULL`,
        [Number(invitation.id)],
      );
      await queryable.query('COMMIT', []);
      console.warn('[workspace-absorb] source workspace no longer orphan — invitation terminated', {
        invitationId: Number(invitation.id),
        sourceOrganizationId: user.organization_id,
        targetOrganizationId: targetOrgId,
        reason: check.reason,
      });
      return { status: 'workspace_in_use' };
    }

    const sourceOrgId = Number(user.organization_id);

    // Repoint the account. Role is the ADMIN-CHOSEN invitation role, never the
    // carried-over source-workspace tenant_admin. NO password write.
    await queryable.query(`UPDATE users SET organization_id = $1, role = $2 WHERE id = $3`, [
      targetOrgId,
      invitation.role,
      Number(user.id),
    ]);

    // Move the Phase-0 dual-write membership row in the same transaction: the
    // (user, old-org) row becomes (user, new-org) with the admin-chosen role.
    // Delete + upsert (ON CONFLICT-safe) — a pointer to org B with a membership
    // still on org A would resolve as NULL at flag-flip (eng finding 3b).
    await queryable.query(
      `DELETE FROM organization_memberships WHERE user_id = $1 AND organization_id = $2`,
      [Number(user.id), sourceOrgId],
    );
    await upsertOrganizationMembership(queryable as never, {
      userId: user.id,
      organizationId: targetOrgId,
      role: invitation.role,
      status: 'active',
      invitedByUserId: invitation.invited_by_user_id ?? null,
    });

    // Audit: consent executes the absorb, so the invitee is the actor; the
    // admin who invited and the source org ride in metadata.
    await queryable.query(
      `
        INSERT INTO organization_membership_events
          (organization_id, user_id, actor_user_id, event_type, metadata)
        VALUES ($1, $2, $3, 'absorbed', $4::jsonb)
      `,
      [
        targetOrgId,
        Number(user.id),
        Number(user.id),
        JSON.stringify({
          source_organization_id: sourceOrgId,
          invited_by_user_id:
            invitation.invited_by_user_id === null || invitation.invited_by_user_id === undefined
              ? null
              : Number(invitation.invited_by_user_id),
          invitation_id: Number(invitation.id),
          role: invitation.role,
        }),
      ],
    );

    // Consume every outstanding invitation for this user, mirroring the legacy
    // accept — a stale sibling token must never re-run the absorb.
    await queryable.query(
      `UPDATE workspace_invitations SET accepted_at = now() WHERE user_id = $1 AND accepted_at IS NULL`,
      [Number(user.id)],
    );

    await queryable.query('COMMIT', []);
    return { status: 'ok', email: invitation.email, organizationId: String(targetOrgId) };
  } catch (error) {
    await queryable.query('ROLLBACK', []);
    throw error;
  }
}

/**
 * Decline an absorb invitation (Phase 0.5). A real, visible action — the
 * invitation token is expired (never accepted) so the link dies immediately.
 * Requires the same signed-in, email-matched consent as accept; idempotent
 * (declining an already-expired invitation succeeds quietly).
 */
export async function declineAbsorbInvitation(
  queryable: Queryable,
  input: { rawToken: string; sessionUserId: string; sessionEmail?: string | null },
): Promise<DeclineAbsorbResult> {
  if (!input.rawToken || !input.sessionUserId) {
    return { status: 'invalid' };
  }
  const invitation = await loadInvitationByToken(queryable, input.rawToken);
  if (!invitation) {
    return { status: 'invalid' };
  }
  if (String(invitation.user_id) !== String(input.sessionUserId)) {
    return { status: 'email_mismatch' };
  }
  const sessionEmail = normalizeEmail(input.sessionEmail ?? '');
  if (sessionEmail && sessionEmail !== normalizeEmail(invitation.email)) {
    return { status: 'email_mismatch' };
  }
  if (invitation.accepted_at) {
    return { status: 'invalid' };
  }
  await queryable.query(
    `UPDATE workspace_invitations SET expires_at = now() WHERE id = $1 AND accepted_at IS NULL AND expires_at > now()`,
    [Number(invitation.id)],
  );
  return { status: 'ok' };
}
