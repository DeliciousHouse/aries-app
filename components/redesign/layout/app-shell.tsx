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
  /**
   * When true, the shell skips the onboarding redirect. Use for surfaces that
   * must stay reachable for users who have not finished onboarding (for
   * example, external approvers landing on `/review/:jobId`).
   */
  skipOnboardingGate?: boolean;
}

const REVIEW_COUNT_TIMEOUT_MS = 1500;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const timeoutPromise = new Promise<T>((resolve) => {
    timeoutId = setTimeout(() => resolve(fallback), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });
}

export default async function RedesignAppShell({
  children,
  currentRouteId,
  title,
  subtitle,
  actions,
  skipOnboardingGate = false,
}: RedesignAppShellProps): Promise<JSX.Element> {
  const session = await auth();
  if (!session?.user) {
    redirect('/login');
  }

  if (!skipOnboardingGate) {
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
      redirect('/onboarding/start');
    }
  }

  const currentRoute = currentRouteId ? getRouteById(currentRouteId) : null;
  let reviewCount = 0;
  if (session.user.tenantId) {
    try {
      reviewCount = await withTimeout(
        countPendingMarketingReviewItemsForTenant(String(session.user.tenantId)),
        REVIEW_COUNT_TIMEOUT_MS,
        0,
      );
    } catch (error) {
      console.warn('[app-shell] Unable to resolve review count without blocking render.', {
        tenantId: String(session.user.tenantId),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

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
