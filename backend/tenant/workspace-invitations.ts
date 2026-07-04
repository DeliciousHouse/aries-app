import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

import type { TenantRole } from '@/lib/tenant-context';
import { upsertOrganizationMembership } from '@/lib/auth-tenant-membership';
import {
  INVITED_PENDING_PASSWORD,
  createTenantUserProfile,
  getTenantUserProfileById,
  updateTenantUserProfile,
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
  | { status: 'already_member' | 'email_taken' | 'invalid_role' | 'missing_email' };

export type ResendInvitationResult =
  | { status: 'ok'; email: string; role: TenantRole; rawToken: string; expiresAt: Date }
  | { status: 'not_found' | 'tenant_mismatch' | 'already_active' };

export type AcceptInvitationResult =
  | { status: 'ok'; email: string }
  | { status: 'invalid' | 'expired' | 'already_accepted' | 'weak_password' };

export type DescribeInvitationResult =
  | { status: 'valid' | 'expired' | 'already_accepted'; email: string }
  | { status: 'invalid' };

// Extended read-only token check for the accept page (Phase 0.5). `mode`
// distinguishes the legacy set-password flow (pending-sentinel account) from
// the absorb-consent flow (existing active account in another workspace); the
// workspace/inviter/role context feeds the consent page's disclosure copy.
export type InvitationAcceptContext =
  | { status: 'invalid' }
  | { status: 'expired' | 'already_accepted'; email: string }
  | {
      status: 'valid';
      email: string;
      mode: 'set_password' | 'absorb';
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
  },
): Promise<{ rawToken: string; expiresAt: Date }> {
  const { rawToken, tokenHash } = generateInviteToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

  // Supersede any still-live invitation for this user so only the newest token
  // works. Without this, every re-invite/resend would leave the prior token
  // independently usable until its own 7-day expiry (mirrors the way
  // reset-password invalidates sibling rows on issue).
  await queryable.query(
    `UPDATE workspace_invitations
        SET expires_at = now()
      WHERE user_id = $1 AND accepted_at IS NULL AND expires_at > now()`,
    [Number(input.userId)],
  );

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
): Promise<InviteWorkspaceMemberResult> {
  const email = normalizeEmail(input.email ?? '');
  if (!email) {
    return { status: 'missing_email' };
  }

  const role = input.role ?? 'tenant_analyst';
  if (!TENANT_ROLES.has(role)) {
    return { status: 'invalid_role' };
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
 * Mint a fresh invitation token for a member who is still pending (never set a
 * password). Used by the "Resend invite" admin action. A no-op-with-signal for
 * a member who is already active.
 */
export async function resendWorkspaceInvitation(
  queryable: Queryable,
  input: { organizationId: string; userId: string; invitedByUserId?: string | null },
): Promise<ResendInvitationResult> {
  const lookup = await getTenantUserProfileById(queryable, {
    tenantId: input.organizationId,
    userId: input.userId,
  });
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
 */
export async function acceptWorkspaceInvitation(
  queryable: Queryable,
  input: { rawToken: string; password: string },
): Promise<AcceptInvitationResult> {
  if (!PASSWORD_RE.test(input.password ?? '')) {
    return { status: 'weak_password' };
  }

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
    await queryable.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [
      passwordHash,
      Number(invitation.user_id),
    ]);
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
): Promise<InvitationAcceptContext> {
  if (!rawToken) {
    return { status: 'invalid' };
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
