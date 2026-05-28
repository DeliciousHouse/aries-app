import AppShellLayout from '@/frontend/app-shell/layout';
import AriesPostListScreen from '@/frontend/aries-v1/post-list';

export const metadata = {
  title: 'Campaigns · Aries AI',
};

export default function DashboardCampaignsPage() {
  return (
    <AppShellLayout currentRouteId="socialContent" loginRedirectPath="/dashboard/social-content">
      <AriesPostListScreen />
    </AppShellLayout>
  );
}
