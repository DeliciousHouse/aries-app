import type { Metadata } from 'next';

import AppShellLayout from '@/frontend/app-shell/layout';
import AriesPostWorkspace from '@/frontend/aries-v1/post-workspace';
import type { AppRouteId } from '@/frontend/app-shell/routes';

function routeIdForView(view: string | undefined): AppRouteId {
  if (view === 'brand') return 'brandReview';
  if (view === 'strategy') return 'strategyReview';
  if (view === 'creative') return 'creativeReview';
  if (view === 'publish') return 'publishStatus';
  return 'socialContent';
}

function titleForView(view: string | undefined): string {
  if (view === 'brand') return 'Brand Review';
  if (view === 'strategy') return 'Strategy Review';
  if (view === 'creative') return 'Creative Review';
  if (view === 'publish') return 'Publish Status';
  return 'Campaign';
}

// Per-view title so the stage routes that redirect here (brand/creative/strategy/
// publish-status → /dashboard/social-content/<id>?view=…) keep a unique,
// descriptive <title> instead of all collapsing to "Campaign" (WCAG 2.4.2).
export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}): Promise<Metadata> {
  const { view } = await searchParams;
  return { title: `${titleForView(view)} — Aries AI` };
}

export default async function DashboardCampaignWorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ postId: string }>;
  searchParams: Promise<{ view?: string }>;
}) {
  const { postId } = await params;
  const { view } = await searchParams;

  return (
    <AppShellLayout currentRouteId={routeIdForView(view)}>
      <AriesPostWorkspace
        postId={postId}
        initialView={view === 'brand' || view === 'strategy' || view === 'creative' || view === 'publish' ? view : undefined}
      />
    </AppShellLayout>
  );
}
