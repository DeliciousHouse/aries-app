import AppShellLayout from '@/frontend/app-shell/layout';
import AriesLatestPostView from '@/frontend/aries-v1/latest-post-view';

export const metadata = {
  title: 'Strategy Review — Aries AI',
};

export default function DashboardStrategyReviewPage() {
  return (
    <AppShellLayout currentRouteId="strategyReview">
      <AriesLatestPostView
        view="strategy"
        title="No strategy review available"
        description="Create a social content job to generate a strategy proposal you can review and revise."
      />
    </AppShellLayout>
  );
}
