import AppShellLayout from '@/frontend/app-shell/layout';
import AriesCampaignWorkspace from '@/frontend/aries-v1/campaign-workspace';

export default async function CampaignWorkspacePage({
  params,
}: {
  params: Promise<{ campaignId: string }>;
}) {
  const { campaignId } = await params;

  return (
    <AppShellLayout currentRouteId="campaigns">
      <AriesCampaignWorkspace campaignId={campaignId} />
    </AppShellLayout>
  );
}
