import AppShellLayout from '@/frontend/app-shell/layout';
import AriesCampaignWorkspace from '@/frontend/aries-v1/campaign-workspace';
import type { AppRouteId } from '@/frontend/app-shell/routes';

function routeIdForView(view: string | undefined): AppRouteId {
  if (view === 'brand') return 'brandReview';
  if (view === 'strategy') return 'strategyReview';
  if (view === 'creative') return 'creativeReview';
  if (view === 'publish') return 'publishStatus';
  return 'campaigns';
}

export default async function DashboardCampaignWorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ campaignId: string }>;
  searchParams: Promise<{ view?: string }>;
}) {
  const { campaignId } = await params;
  const { view } = await searchParams;

  return (
    <AppShellLayout currentRouteId={routeIdForView(view)}>
      <AriesCampaignWorkspace
        campaignId={campaignId}
        initialView={view === 'brand' || view === 'strategy' || view === 'creative' || view === 'publish' ? view : undefined}
      />
    </AppShellLayout>
  );
}
