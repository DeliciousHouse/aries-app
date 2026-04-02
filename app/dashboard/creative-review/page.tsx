import AppShellLayout from '@/frontend/app-shell/layout';
import AriesLatestCampaignView from '@/frontend/aries-v1/latest-campaign-view';

export default function DashboardCreativeReviewPage() {
  return (
    <AppShellLayout currentRouteId="creativeReview">
      <AriesLatestCampaignView
        view="creative"
        title="No creative review available"
        description="Create a campaign to move into per-asset creative review."
      />
    </AppShellLayout>
  );
}
