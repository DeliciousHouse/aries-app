import AppShellLayout from '@/frontend/app-shell/layout';
import AriesCampaignListScreen from '@/frontend/aries-v1/campaign-list';

export const metadata = {
  title: 'Campaigns · Aries AI',
};

export default function DashboardCampaignsPage() {
  return (
    <AppShellLayout currentRouteId="campaigns">
      <AriesCampaignListScreen />
    </AppShellLayout>
  );
}
