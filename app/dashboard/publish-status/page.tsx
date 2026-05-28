import AppShellLayout from '@/frontend/app-shell/layout';
import AriesLatestPostView from '@/frontend/aries-v1/latest-post-view';

export const metadata = {
  title: 'Publish Status · Aries AI',
};

export default function DashboardPublishStatusPage() {
  return (
    <AppShellLayout currentRouteId="publishStatus" loginRedirectPath="/dashboard/publish-status">
      <AriesLatestPostView
        view="publish"
        title="No publish status yet"
        description="Create a social content job to track approval gating and publish readiness."
      />
    </AppShellLayout>
  );
}
