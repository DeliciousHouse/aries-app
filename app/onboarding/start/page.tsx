import { redirect } from 'next/navigation';

import { auth } from '@/auth';
import pool from '@/lib/db';
import AriesOnboardingFlow from '@/frontend/aries-v1/onboarding-flow';
import { evaluateOnboardingGate, META_CONNECT_REDIRECT_DESTINATION } from '@/lib/onboarding-gate';
import { resolveTenantContextForSession, TenantContextError } from '@/lib/tenant-context';

export default async function OnboardingStartPage() {
  const session = await auth();

  // Send already-onboarded operators onward instead of re-rendering the flow.
  // Without this, every redirect that lands here (e.g. /dashboard bouncing for
  // a missing Meta connection) renders the flow, which POSTs a fresh draft on
  // mount — leaking marketing_onboarding_drafts rows on every navigation.
  if (session?.user?.id) {
    const client = await pool.connect();
    try {
      const tenantContext = await resolveTenantContextForSession(client, session);
      const decision = await evaluateOnboardingGate({ client, tenantId: tenantContext.tenantId });
      if (decision.allowed) {
        redirect('/dashboard');
      }
      if (decision.reason === 'meta_not_connected') {
        redirect(META_CONNECT_REDIRECT_DESTINATION);
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
