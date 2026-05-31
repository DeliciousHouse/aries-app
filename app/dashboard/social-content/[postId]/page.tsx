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

export const metadata = {
  title: 'Campaign — Aries AI',
};

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
