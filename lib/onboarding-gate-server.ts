import 'server-only';

import { redirect } from 'next/navigation';

import { auth } from '@/auth';
import pool from '@/lib/db';
import { isMarketingPublicMode } from '@/lib/marketing-public-mode';
import { GATE_REDIRECT_DESTINATION, evaluateOnboardingGate } from '@/lib/onboarding-gate';
import { resolveTenantContextForSession, TenantContextError } from '@/lib/tenant-context';

export async function enforceOnboardingGate(): Promise<void> {
  if (isMarketingPublicMode()) {
    return;
  }

  const session = await auth();

  if (!session?.user?.id) {
    redirect(`/login?callbackUrl=${encodeURIComponent('/auth/post-login')}`);
  }

  const client = await pool.connect();
  try {
    let tenantId: string;
    try {
      const tenantContext = await resolveTenantContextForSession(client, session);
      tenantId = tenantContext.tenantId;
    } catch (error) {
      if (error instanceof TenantContextError) {
        redirect(GATE_REDIRECT_DESTINATION);
      }
      throw error;
    }

    const decision = await evaluateOnboardingGate({ client, tenantId });
    if (!decision.allowed && decision.redirectTo) {
      redirect(decision.redirectTo);
    }
  } finally {
    client.release();
  }
}
