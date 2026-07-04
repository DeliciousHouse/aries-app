import { redirect } from 'next/navigation';

import { auth } from '@/auth';
import pool from '@/lib/db';
import { isMultiWorkspaceEnabled } from '@/backend/tenant/multi-workspace-env';
import { WORKSPACE_CHOOSER_PATH } from '@/backend/tenant/workspace-chooser';
import { DATABASE_UNAVAILABLE_ERROR } from '@/lib/auth-error-message';
import { resolvePostLoginDestinationForUser } from '@/lib/auth-user-journey';
import { loadTenantContextForUser, TenantContextError } from '@/lib/tenant-context';

export default async function PostLoginPage() {
  const session = await auth();

  if (!session?.user?.id) {
    redirect('/login');
  }

  const client = await pool.connect();
  let destination: string = '/onboarding/start';

  try {
    destination = await resolvePostLoginDestinationForUser(client, session.user.id);

    // Multi-workspace (flag ON): a zero-membership account lands on the
    // explicit workspace chooser instead of being funneled into onboarding —
    // an invited teammate who Google-signs-in before accepting must see their
    // pending invite, not mint a junk personal org (plan Decision 7 / eng
    // finding 9). Claims-incomplete and resolvable accounts keep today's
    // journey untouched.
    if (isMultiWorkspaceEnabled()) {
      try {
        await loadTenantContextForUser(client, session.user.id);
      } catch (error) {
        if (error instanceof TenantContextError && error.reason === 'tenant_membership_missing') {
          destination = WORKSPACE_CHOOSER_PATH;
        } else if (!(error instanceof TenantContextError)) {
          throw error;
        }
      }
    }
  } catch (error) {
    console.error('Unable to resolve post-login destination:', error);
    destination = `/login?error=${encodeURIComponent(DATABASE_UNAVAILABLE_ERROR)}`;
  } finally {
    client.release();
  }

  redirect(destination);
}
