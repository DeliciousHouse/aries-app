import AppShellLayout from '@/frontend/app-shell/layout';
import AriesLatestPostView from '@/frontend/aries-v1/latest-post-view';

export const metadata = {
  title: 'Creative Review — Aries AI',
};

export default function DashboardCreativeReviewPage() {
  return (
    <AppShellLayout currentRouteId="creativeReview">
      <AriesLatestPostView
        view="creative"
        title="No creative review available"
        description="Create a social content job to move into per-asset creative review."
      />
    </AppShellLayout>
  );
}
