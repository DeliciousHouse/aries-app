import AppShellLayout from '@/frontend/app-shell/layout';
import AriesLatestPostView from '@/frontend/aries-v1/latest-post-view';

export default function DashboardBrandReviewPage() {
  return (
    <AppShellLayout currentRouteId="brandReview">
      <AriesLatestPostView
        view="brand"
        title="No campaigns yet"
        description="Create a social content job to start the brand review workflow."
      />
    </AppShellLayout>
  );
}
