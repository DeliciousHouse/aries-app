import AppShellLayout from '../../frontend/app-shell/layout';
import DashboardConsole from '@/frontend/app-shell/dashboard-console';

export default function DashboardPage() {
  return (
    <AppShellLayout currentRouteId="dashboard">
      <DashboardConsole />
    </AppShellLayout>
  );
}
