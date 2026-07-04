import 'server-only';

import { redirect } from 'next/navigation';

import { auth } from '@/auth';
import pool from '@/lib/db';
import { isMultiWorkspaceEnabled } from '@/backend/tenant/multi-workspace-env';
import { WORKSPACE_CHOOSER_PATH } from '@/backend/tenant/workspace-chooser';
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
        // Multi-workspace (flag ON): a zero-membership account must land on
        // the explicit workspace chooser — NOT the onboarding resume page,
        // which mints an org and would silently resurrect auto-provisioning
        // through a different door (plan eng finding 9). The chooser lives
        // outside this gated layout, so the redirect terminates.
        if (isMultiWorkspaceEnabled() && error.reason === 'tenant_membership_missing') {
          redirect(WORKSPACE_CHOOSER_PATH);
        }
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
