import AppShellLayout from '@/frontend/app-shell/layout';
import MarketingNewJobScreen from '@/frontend/marketing/new-job';

export const metadata = {
  title: 'New Campaign · Aries AI',
};

export default function DashboardNewCampaignPage() {
  return (
    <AppShellLayout currentRouteId="newCampaign">
      <MarketingNewJobScreen embedded redirectMode="dashboard" />
    </AppShellLayout>
  );
}
