import pool from '@/lib/db';
import { getTenantContext } from '@/lib/tenant-context';
import { resendWorkspaceInvitation } from '@/backend/tenant/workspace-invitations';
import { sendWorkspaceInviteEmail } from '@/lib/email';
import { buildInviteAcceptUrl, roleLabel, INVITE_EXPIRES_IN_DAYS } from '@/backend/tenant/invite-presentation';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function parseUserId(raw: string): string | null {
  return /^[1-9]\d*$/.test(raw) ? raw : null;
}

export async function POST(_req: Request, { params }: { params: Promise<{ userId: string }> }) {
  const { userId: rawUserId } = await params;
  const userId = parseUserId(rawUserId);
  if (!userId) {
    return json({ error: 'invalid_user_id' }, 400);
  }

  let tenantContext;
  try {
    tenantContext = await getTenantContext();
  } catch (error) {
    return json({ error: 'Authentication required.' }, 403);
  }

  if (tenantContext.role !== 'tenant_admin') {
    return json({ error: 'forbidden' }, 403);
  }

  const client = await pool.connect();
  try {
    const result = await resendWorkspaceInvitation(client, {
      organizationId: tenantContext.tenantId,
      userId,
      invitedByUserId: tenantContext.userId,
    });

    if (result.status !== 'ok') {
      if (result.status === 'not_found') {
        return json({ error: 'not_found' }, 404);
      }
      if (result.status === 'tenant_mismatch') {
        return json({ error: 'tenant_mismatch' }, 403);
      }
      return json({ error: 'already_active' }, 409);
    }

    let orgName: string | null = null;
    let inviterName: string | null = null;
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
      orgName = row?.org_name ?? null;
      inviterName = row?.inviter_name ?? null;
    } catch (lookupError) {
      console.error('[tenant-profiles] resend email context lookup failed', {
        tenantId: tenantContext.tenantId,
        error: lookupError instanceof Error ? lookupError.message : String(lookupError),
      });
    }

    await sendWorkspaceInviteEmail({
      to: result.email,
      inviterName,
      workspaceName: orgName || 'your Aries AI workspace',
      roleLabel: roleLabel(result.role),
      acceptUrl: buildInviteAcceptUrl(result.rawToken),
      expiresInDays: INVITE_EXPIRES_IN_DAYS,
      // Flag ON, resending to an existing ACTIVE account invited to an
      // additional workspace: the copy must say "sign in with your existing
      // credentials", not "set your password". Flag OFF emailVariant is absent
      // and the default set-password copy applies (byte-identical).
      variant: result.emailVariant === 'existing_account' ? 'existing_account' : undefined,
    });

    return json({ status: 'sent' });
  } catch (error) {
    console.error('[tenant-profiles]', {
      event: 'resend-failed',
      tenantId: tenantContext.tenantId,
      userId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return json({ error: 'An unexpected error occurred' }, 500);
  } finally {
    client.release();
  }
}
