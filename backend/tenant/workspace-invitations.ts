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
 * Add (or re-invite) a teammate to the organization and mint a single-use
 * invitation token. Idempotent for a still-pending invitee in the same org:
 * it refreshes their role/name and issues a fresh token. Refuses to touch a
 * user who already belongs to another org, or an already-active member of this
 * org. Caller is responsible for sending the email with the returned rawToken.
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
      // The email already backs a user in a different workspace — we never
      // reassign an existing account across tenant boundaries.
      return { status: 'email_taken' };
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
