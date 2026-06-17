import AppShellLayout from '@/frontend/app-shell/layout';
import AriesAnalyticsScreen from '@/frontend/aries-v1/analytics-screen';

export const metadata = {
  title: 'Analytics — Aries AI',
};

export default function DashboardAnalyticsPage() {
  return (
    <AppShellLayout currentRouteId="analytics" loginRedirectPath="/dashboard/analytics">
      <AriesAnalyticsScreen />
    </AppShellLayout>
  );
}
