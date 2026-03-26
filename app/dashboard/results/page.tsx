import AppShellLayout from '@/frontend/app-shell/layout';
import AriesResultsScreen from '@/frontend/aries-v1/results-screen';

export default function DashboardResultsPage() {
  return (
    <AppShellLayout currentRouteId="results">
      <AriesResultsScreen />
    </AppShellLayout>
  );
}
