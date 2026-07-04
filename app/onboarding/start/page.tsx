import { redirect } from 'next/navigation';

import { auth } from '@/auth';
import pool from '@/lib/db';
import AriesOnboardingFlow from '@/frontend/aries-v1/onboarding-flow';
import { evaluateOnboardingGate } from '@/lib/onboarding-gate';
import { resolveTenantContextForSession, TenantContextError } from '@/lib/tenant-context';
import { isMultiWorkspaceEnabled } from '@/backend/tenant/multi-workspace-env';

export default async function OnboardingStartPage({
  searchParams,
}: {
  searchParams: Promise<{ new?: string }>;
}) {
  const session = await auth();

  // "Create new workspace" intent (multi-workspace plan Phase 4): an
  // already-onboarded user coming from the account-menu entry point must be
  // able to onboard a SECOND business. Only honored flag-ON — flag-OFF the
  // multi-workspace model does not exist, so the intent is ignored and the
  // existing already-onboarded → dashboard redirect stands (byte-identical).
  const { new: newParam } = await searchParams;
  const createNewWorkspace = isMultiWorkspaceEnabled() && newParam === '1';

  // Send already-onboarded operators onward instead of re-rendering the flow.
  // After the meta-gate softening, `meta_not_connected` tenants are allowed
  // into the dashboard (the banner nudge handles the connect prompt), so the
  // gate decision's `allowed === true` is the single signal we forward on.
  if (session?.user?.id && !createNewWorkspace) {
    const client = await pool.connect();
    try {
      const tenantContext = await resolveTenantContextForSession(client, session);
      const decision = await evaluateOnboardingGate({ client, tenantId: tenantContext.tenantId });
      if (decision.allowed) {
        redirect('/dashboard');
      }
    } catch (error) {
      if (!(error instanceof TenantContextError)) {
        throw error;
      }
      // No tenant yet — fall through to render the flow.
    } finally {
      client.release();
    }
  }

  return <AriesOnboardingFlow initialAuthenticated={Boolean(session?.user?.id)} />;
}
