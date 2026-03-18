import AppShellLayout from '../../frontend/app-shell/layout';
import CalendarConsole from '../../frontend/app-shell/calendar-console';

export default function CalendarPage() {
  return (
    <AppShellLayout currentRouteId="calendar">
      <CalendarConsole />
    </AppShellLayout>
  );
}
