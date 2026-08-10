import AppShellLayout from '@/frontend/app-shell/layout';
import AriesResultsScreen from '@/frontend/aries-v1/results-screen';
import WeeklyResultsReport from '@/frontend/aries-v1/weekly-results-report';
import { isWeeklyResultsEnabled } from '@/backend/marketing/weekly-results-env';

export const metadata = {
  title: 'Results — Aries AI',
};

export default function DashboardResultsPage() {
  // S5-1/AA-110: read the flag on the SERVER so a disabled deployment renders
  // today's screen with no extra component, no fetch, and no flash of a panel
  // that then disappears. Mirrors how the review page passes imageEditEnabled
  // down from its server component.
  const weeklyResultsEnabled = isWeeklyResultsEnabled();

  return (
    <AppShellLayout currentRouteId="results" loginRedirectPath="/dashboard/results">
      {weeklyResultsEnabled ? (
        <div className="space-y-5">
          <WeeklyResultsReport />
          <AriesResultsScreen />
        </div>
      ) : (
        <AriesResultsScreen />
      )}
    </AppShellLayout>
  );
}
