import AppShellLayout from '../../frontend/app-shell/layout';
import AriesHomeDashboard from '@/frontend/aries-v1/home-dashboard';

export const metadata = {
  title: 'Dashboard — Aries AI',
};

export default function DashboardPage() {
  return (
    <AppShellLayout currentRouteId="home">
      <AriesHomeDashboard />
    </AppShellLayout>
  );
}
