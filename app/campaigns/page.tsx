import AppShellLayout from '@/frontend/app-shell/layout';
import AriesCampaignListScreen from '@/frontend/aries-v1/campaign-list';

export default function CampaignsPage() {
  return (
    <AppShellLayout currentRouteId="campaigns">
      <AriesCampaignListScreen />
    </AppShellLayout>
  );
}
