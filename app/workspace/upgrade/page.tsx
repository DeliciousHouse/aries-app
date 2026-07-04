import { redirect } from 'next/navigation';

import { auth } from '@/auth';
import { isMultiWorkspaceEnabled } from '@/backend/tenant/multi-workspace-env';
import { WORKSPACE_UPGRADE_PATH } from '@/backend/tenant/workspace-upgrade';
import AuthLayout from '@/frontend/auth/auth-layout';

export const metadata = {
  title: 'Upgrade to add a workspace — Aries AI',
};

/**
 * Upgrade-required screen for the Phase-4 create-second-workspace paywall
 * (multi-workspace plan Decision 13 + the design review's create-path note).
 * Reached when a free account tries to onboard a SECOND business: the onboarding
 * resume RSC's entitlement check denied it (nothing was created) and routed
 * here. Framed as the account's plan state, not an error — no dark-pattern
 * urgency. Lives outside the gated dashboard layout so it's always reachable.
 *
 * Flag OFF this path is not part of any journey — converge on the dashboard.
 */
export default async function WorkspaceUpgradePage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect(`/login?callbackUrl=${encodeURIComponent(WORKSPACE_UPGRADE_PATH)}`);
  }
  if (!isMultiWorkspaceEnabled()) {
    redirect('/dashboard');
  }

  const email = session.user.email ?? null;

  return (
    <AuthLayout>
      <div className="mx-auto max-w-md rounded-2xl border border-white/10 bg-white/5 px-6 py-10 text-left text-white/80 space-y-4">
        <p className="text-lg font-semibold text-white">Adding a workspace needs Aries Pro.</p>
        <div className="space-y-2 text-sm text-white/70">
          <p>
            {email ? (
              <>
                Your account (<span className="font-semibold text-white">{email}</span>) is on the
                free plan, which includes one workspace.
              </>
            ) : (
              <>Your account is on the free plan, which includes one workspace.</>
            )}
          </p>
          <p>
            Creating a second business for the same account needs Aries Pro. Contact the Aries team
            about upgrading your account, then start onboarding your new business again.
          </p>
        </div>
        <a
          href="/dashboard"
          className="inline-block text-sm font-semibold text-white/70 underline underline-offset-4 decoration-white/40 hover:decoration-white hover:text-white transition-all"
        >
          Back to your workspace
        </a>
      </div>
    </AuthLayout>
  );
}
