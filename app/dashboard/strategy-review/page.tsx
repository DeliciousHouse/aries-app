import AppShellLayout from '@/frontend/app-shell/layout';
import AriesLatestCampaignView from '@/frontend/aries-v1/latest-campaign-view';

export default function DashboardStrategyReviewPage() {
  return (
    <AppShellLayout currentRouteId="strategyReview">
      <AriesLatestCampaignView
        view="strategy"
        title="No strategy review available"
        description="Create a campaign to generate a strategy proposal you can review and revise."
      />
    </AppShellLayout>
  );
}
