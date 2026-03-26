import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';

import { auth, signOut } from '@/auth';
import { countPendingMarketingReviewItemsForTenant } from '@/backend/marketing/runtime-views';
import { getRouteById, type AppRouteId } from '@/frontend/app-shell/routes';

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
