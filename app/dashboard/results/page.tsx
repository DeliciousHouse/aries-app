import AppShellLayout from '@/frontend/app-shell/layout';
import AriesResultsScreen from '@/frontend/aries-v1/results-screen';

export const metadata = {
  title: 'Results — Aries AI',
};

export default function DashboardResultsPage() {
  return (
    <AppShellLayout currentRouteId="results" loginRedirectPath="/dashboard/results">
      <AriesResultsScreen />
    </AppShellLayout>
  );
}
