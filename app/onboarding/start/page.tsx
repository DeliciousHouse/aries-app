import { redirect } from 'next/navigation';

import { auth } from '@/auth';
import pool from '@/lib/db';
import AriesOnboardingFlow from '@/frontend/aries-v1/onboarding-flow';
import { evaluateOnboardingGate } from '@/lib/onboarding-gate';
import { resolveTenantContextForSession, TenantContextError } from '@/lib/tenant-context';

export default async function OnboardingStartPage() {
  const session = await auth();

  // Send already-onboarded operators onward instead of re-rendering the flow.
  // After the meta-gate softening, `meta_not_connected` tenants are allowed
  // into the dashboard (the banner nudge handles the connect prompt), so the
  // gate decision's `allowed === true` is the single signal we forward on.
  if (session?.user?.id) {
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
