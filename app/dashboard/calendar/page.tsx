import AppShellLayout from '@/frontend/app-shell/layout';
import AriesCalendarScreen from '@/frontend/aries-v1/calendar-screen';

export default function DashboardCalendarPage() {
  return (
    <AppShellLayout currentRouteId="calendar">
      <AriesCalendarScreen />
    </AppShellLayout>
  );
}
