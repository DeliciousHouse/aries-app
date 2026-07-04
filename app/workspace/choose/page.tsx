import { redirect } from 'next/navigation';

import { auth } from '@/auth';
import pool from '@/lib/db';
import { isMultiWorkspaceEnabled } from '@/backend/tenant/multi-workspace-env';
import {
  listPendingWorkspaceInvites,
  WORKSPACE_CHOOSER_PATH,
  type PendingWorkspaceInvite,
} from '@/backend/tenant/workspace-chooser';
import { GATE_REDIRECT_DESTINATION } from '@/lib/onboarding-gate';
import { resolveTenantContextForSession, TenantContextError } from '@/lib/tenant-context';
import AuthLayout from '@/frontend/auth/auth-layout';

import { acceptPendingInviteAction } from './actions';

export const metadata = {
  title: 'Choose a workspace — Aries AI',
};

const ROLE_LABELS: Record<string, string> = {
  tenant_admin: 'Admin',
  tenant_analyst: 'Analyst',
  tenant_viewer: 'Viewer',
};

/**
 * Zero-membership workspace chooser (multi-workspace plan Decision 7 / eng
 * finding 9). Lives OUTSIDE the gated dashboard layout on purpose: the
 * onboarding gate redirects the zero-membership state here, and this page must
 * never bounce back into a gated tree (no loop) nor into the onboarding resume
 * page (which mints an org). Invite-aware per the design spec: a pending
 * invitation is the primary action; only an invite-less account is offered
 * "Create a workspace".
 */
export default async function WorkspaceChooserPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect(`/login?callbackUrl=${encodeURIComponent(WORKSPACE_CHOOSER_PATH)}`);
  }

  let resolvedDestination: string | null = null;
  let invites: PendingWorkspaceInvite[] = [];

  const client = await pool.connect();
  try {
    try {
      await resolveTenantContextForSession(client, session);
      // The account already resolves into a workspace — nothing to choose.
      resolvedDestination = '/dashboard';
    } catch (error) {
      if (!(error instanceof TenantContextError)) {
        throw error;
      }
      if (!isMultiWorkspaceEnabled()) {
        // Flag OFF this page is not part of any journey; converge on today's
        // gate destination rather than rendering a dead end.
        resolvedDestination = GATE_REDIRECT_DESTINATION;
      }
    }

    if (!resolvedDestination) {
      invites = await listPendingWorkspaceInvites(client, session.user.id);
    }
  } finally {
    client.release();
  }

  if (resolvedDestination) {
    redirect(resolvedDestination);
  }

  const { error } = await searchParams;
  const email = session.user.email ?? null;

  return (
    <AuthLayout>
      <div className="mx-auto max-w-md rounded-2xl border border-white/10 bg-white/5 px-6 py-10 text-left text-white/80 space-y-6">
        <div className="space-y-2">
          <h1 className="text-lg font-semibold text-white">You&apos;re not in a workspace yet.</h1>
          <p className="text-sm text-white/60">
            {email ? (
              <>
                Signed in as <span className="font-semibold text-white">{email}</span>. Your account
                exists, but it doesn&apos;t belong to a workspace.
              </>
            ) : (
              <>Your account exists, but it doesn&apos;t belong to a workspace.</>
            )}
          </p>
        </div>

        {error === 'invite_link' ? (
          <p className="rounded-xl border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm text-red-200">
            We couldn&apos;t open that invitation. Use the invite link from your email, or ask the
            workspace admin to resend it.
          </p>
        ) : null}

        {invites.length > 0 ? (
          <div className="space-y-4">
            {invites.map((invite) => (
              <form key={invite.organizationId} action={acceptPendingInviteAction} className="space-y-3">
                <input type="hidden" name="organizationId" value={invite.organizationId} />
                <p className="text-sm text-white/80">
                  You&apos;ve been invited to{' '}
                  <span className="font-semibold text-white">
                    {invite.workspaceName ?? 'a workspace'}
                  </span>
                  {invite.role && ROLE_LABELS[invite.role] ? (
                    <> as {ROLE_LABELS[invite.role]}</>
                  ) : null}
                  .
                </p>
                <button
                  type="submit"
                  className="inline-block rounded-xl border border-white/20 bg-white/10 px-5 py-3 text-sm font-semibold text-white hover:bg-white/20 transition-colors"
                >
                  Accept invite
                </button>
              </form>
            ))}
            <p className="text-sm text-white/60">
              Prefer email? The invitation link we sent{email ? ` to ${email}` : ''} works too.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {/*
              Phase 4 (multi-workspace plan Decision 13) adds the entitlement
              gate on second-workspace creation here. For a zero-membership
              account this is their FIRST workspace, which is always free, so
              the link goes straight into today's onboarding entry.
            */}
            <a
              href={GATE_REDIRECT_DESTINATION}
              className="inline-block rounded-xl border border-white/20 bg-white/10 px-5 py-3 text-sm font-semibold text-white hover:bg-white/20 transition-colors"
            >
              Create a workspace
            </a>
            <div className="space-y-1">
              <p className="text-sm font-semibold text-white/80">Waiting for an invite?</p>
              <p className="text-sm text-white/60">
                Ask a workspace admin to invite{' '}
                {email ? <span className="font-semibold text-white">{email}</span> : 'your email address'}{' '}
                from their Settings → Team page. The invite arrives by email and will also show up
                here.
              </p>
            </div>
          </div>
        )}
      </div>
    </AuthLayout>
  );
}
