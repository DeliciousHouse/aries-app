import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';

import { auth, signOut } from '@/auth';
import { countPendingMarketingReviewItemsForTenant } from '@/backend/marketing/runtime-views';
import { getRouteById, type AppRouteId } from '@/frontend/app-shell/routes';
import pool from '@/lib/db';
import { shouldRequireOnboarding, getUserJourneyRow, isTenantOnboardingComplete } from '@/lib/auth-user-journey';

import AppShellClient from './app-shell-client';

export interface RedesignAppShellProps {
  children: ReactNode;
  currentRouteId?: AppRouteId;
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
}

export default async function RedesignAppShell({
  children,
  currentRouteId,
  title,
  subtitle,
  actions,
}: RedesignAppShellProps): Promise<JSX.Element> {
  const session = await auth();
  if (!session?.user) {
    redirect('/login');
  }

  const client = await pool.connect();
  let shouldRedirectToOnboarding = false;
  try {
    const row = await getUserJourneyRow(client, session.user.id);
    const onboardingCompleted = await isTenantOnboardingComplete(
      client,
      session.user.tenantId
        ? String(session.user.tenantId)
        : row?.organization_id !== null && row?.organization_id !== undefined
          ? String(row.organization_id)
          : null,
    );

    if (row) {
      shouldRedirectToOnboarding = shouldRequireOnboarding({
        onboardingRequired: row.onboarding_required,
        onboardingCompletedAt: row.onboarding_completed_at,
        onboardingCompleted,
      });
    }
  } finally {
    client.release();
  }

  if (shouldRedirectToOnboarding) {
    redirect('/onboarding/pipeline-intake');
  }

  const currentRoute = currentRouteId ? getRouteById(currentRouteId) : null;
  const reviewCount = session.user.tenantId
    ? await countPendingMarketingReviewItemsForTenant(String(session.user.tenantId))
    : 0;

  async function logoutAction(_formData: FormData) {
    'use server';
    await signOut({ redirectTo: '/' });
  }

  return (
    <AppShellClient
      currentRouteId={currentRouteId}
      title={title ?? currentRoute?.title ?? 'Aries'}
      subtitle={
        subtitle ??
        currentRoute?.description ??
        'A calmer way to plan, approve, launch, and improve marketing.'
      }
      actions={actions}
      reviewCount={reviewCount}
      user={{
        name: session.user.name,
        email: session.user.email,
      }}
      logoutAction={logoutAction}
    >
      {children}
    </AppShellClient>
  );
}
