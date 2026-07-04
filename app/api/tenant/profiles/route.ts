import pool from '@/lib/db';
import { getTenantContext, type TenantRole } from '@/lib/tenant-context';
import { listTenantUserProfiles } from '@/backend/tenant/user-profiles';
import { inviteWorkspaceMember } from '@/backend/tenant/workspace-invitations';
import { sendWorkspaceInviteEmail } from '@/lib/email';
import { isMarketingPublicMode } from '@/lib/marketing-public-mode';
import { buildInviteAcceptUrl, roleLabel, INVITE_EXPIRES_IN_DAYS } from '@/backend/tenant/invite-presentation';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export async function GET() {
  let tenantContext;
  try {
    tenantContext = await getTenantContext();
  } catch (error) {
    if (isMarketingPublicMode()) {
      return json({ profiles: [] });
    }
    return json({ error: 'Authentication required.' }, 403);
  }

  const client = await pool.connect();
  try {
    const profiles = await listTenantUserProfiles(client, tenantContext.tenantId);
    return json({
      profiles,
      viewer: { userId: tenantContext.userId, role: tenantContext.role },
    });
  } finally {
    client.release();
  }
}

export async function POST(req: Request) {
  let tenantContext;
  try {
    tenantContext = await getTenantContext();
  } catch (error) {
    return json({ error: 'Authentication required.' }, 403);
  }

  if (tenantContext.role !== 'tenant_admin') {
    return json({ error: 'forbidden' }, 403);
  }

  let payload: { email?: string; fullName?: string | null; role?: TenantRole } = {};
  try {
    payload = await req.json();
  } catch {
    payload = {};
  }

  const client = await pool.connect();
  try {
    const result = await inviteWorkspaceMember(client, {
      organizationId: tenantContext.tenantId,
      email: payload.email ?? '',
      fullName: payload.fullName,
      role: payload.role,
      invitedByUserId: tenantContext.userId,
    });

    if (
      result.status !== 'invited' &&
      result.status !== 'reinvited' &&
      result.status !== 'invited_existing_orphan' &&
      result.status !== 'invited_existing_account'
    ) {
      if (result.status === 'missing_email') {
        return json({ error: 'missing_required_fields:email' }, 400);
      }
      if (result.status === 'invalid_role') {
        return json({ error: 'invalid_role' }, 400);
      }
      if (result.status === 'already_member') {
        return json({ error: 'already_member' }, 409);
      }
      return json({ error: 'email_taken' }, 409);
    }

    // Best-effort email: the invitation row + token already exist, so a mail
    // outage never blocks the add. The admin can "Resend invite" to retry.
    let emailContext: { orgName: string | null; inviterName: string | null } = {
      orgName: null,
      inviterName: null,
    };
    try {
      const ctx = await client.query(
        `SELECT o.name AS org_name, u.full_name AS inviter_name
           FROM organizations o
           LEFT JOIN users u ON u.id = $2
          WHERE o.id = $1
          LIMIT 1`,
        [Number(tenantContext.tenantId), Number(tenantContext.userId)],
      );
      const row = ctx.rows[0] as { org_name?: string | null; inviter_name?: string | null } | undefined;
      emailContext = { orgName: row?.org_name ?? null, inviterName: row?.inviter_name ?? null };
    } catch (lookupError) {
      console.error('[tenant-profiles] invite email context lookup failed', {
        tenantId: tenantContext.tenantId,
        error: lookupError instanceof Error ? lookupError.message : String(lookupError),
      });
    }

    if (result.status === 'invited_existing_orphan') {
      // Phase 0.5 absorb relief: the email backs an existing account whose
      // workspace is an orphan. The invitee stays OUT of this org's member
      // list until they consent on the accept page — so no profile here.
      await sendWorkspaceInviteEmail({
        to: result.email,
        inviterName: emailContext.inviterName,
        workspaceName: emailContext.orgName || 'your Aries AI workspace',
        roleLabel: roleLabel(result.role),
        acceptUrl: buildInviteAcceptUrl(result.rawToken),
        expiresInDays: INVITE_EXPIRES_IN_DAYS,
        variant: 'absorb',
      });
      return json({ invited: true, absorb: true, email: result.email }, 201);
    }

    if (result.status === 'invited_existing_account') {
      // Multi-workspace Phase 2 (flag ON): the email backs an existing ACTIVE
      // account elsewhere. A status='invited' membership was created — the
      // team list shows them pending — and accepting adds this workspace to
      // their account. They sign in with their EXISTING credentials; there is
      // no password step, so the email copy says exactly that.
      await sendWorkspaceInviteEmail({
        to: result.email,
        inviterName: emailContext.inviterName,
        workspaceName: emailContext.orgName || 'your Aries AI workspace',
        roleLabel: roleLabel(result.role),
        acceptUrl: buildInviteAcceptUrl(result.rawToken),
        expiresInDays: INVITE_EXPIRES_IN_DAYS,
        variant: 'existing_account',
      });
      return json({ invited: true, existingAccount: true, email: result.email }, 201);
    }

    await sendWorkspaceInviteEmail({
      to: result.profile.email,
      inviterName: emailContext.inviterName,
      workspaceName: emailContext.orgName || 'your Aries AI workspace',
      roleLabel: roleLabel(result.profile.role),
      acceptUrl: buildInviteAcceptUrl(result.rawToken),
      expiresInDays: INVITE_EXPIRES_IN_DAYS,
    });

    return json({ profile: result.profile, invited: true }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[tenant-profiles]', {
      event: 'invite-failed',
      tenantId: tenantContext.tenantId,
      error: message,
      stack: error instanceof Error ? error.stack : undefined,
    });
    return json({ error: 'An unexpected error occurred' }, 500);
  } finally {
    client.release();
  }
}
