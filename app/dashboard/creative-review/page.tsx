import AppShellLayout from '@/frontend/app-shell/layout';
import AriesLatestCampaignView from '@/frontend/aries-v1/latest-post-view';

export default function DashboardCreativeReviewPage() {
  return (
    <AppShellLayout currentRouteId="creativeReview">
      <AriesLatestCampaignView
        view="creative"
        title="No creative review available"
        description="Create a social content job to move into per-asset creative review."
      />
    </AppShellLayout>
  );
}
