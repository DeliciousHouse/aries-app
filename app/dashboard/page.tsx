import AppShellLayout from '../../frontend/app-shell/layout';
import AriesHomeDashboard from '@/frontend/aries-v1/home-dashboard';
import { getLatestPmBoardStandup } from '@/lib/pm-board-standup';

export default function DashboardPage() {
  const latestStandup = getLatestPmBoardStandup();

  return (
    <AppShellLayout currentRouteId="home">
      <AriesHomeDashboard latestStandup={latestStandup} />
    </AppShellLayout>
  );
}
