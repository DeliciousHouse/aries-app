import AppShellLayout from '@/frontend/app-shell/layout';
import MarketingNewJobScreen from '@/frontend/marketing/new-job';

export default function DashboardNewCampaignPage() {
  return (
    <AppShellLayout currentRouteId="newCampaign">
      <MarketingNewJobScreen embedded redirectMode="dashboard" />
    </AppShellLayout>
  );
}
