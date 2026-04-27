import AppShellLayout from '@/frontend/app-shell/layout';
import AriesLatestCampaignView from '@/frontend/aries-v1/latest-campaign-view';

export const metadata = {
  title: 'Publish Status · Aries AI',
};

export default function DashboardPublishStatusPage() {
  return (
    <AppShellLayout currentRouteId="publishStatus" loginRedirectPath="/dashboard/publish-status">
      <AriesLatestCampaignView
        view="publish"
        title="No publish status yet"
        description="Create a campaign to track approval gating and publish readiness."
      />
    </AppShellLayout>
  );
}
