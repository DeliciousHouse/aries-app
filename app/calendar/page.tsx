import AppShellLayout from '../../frontend/app-shell/layout';

export default function CalendarPage() {
  return (
    <AppShellLayout currentRouteId="calendar">
      <h2>Calendar</h2>
      <p>Schedule sync and publish windows are orchestrated via n8n workflows.</p>
      <pre>{JSON.stringify({ sync_workflow: 'n8n/calendar-schedule-sync.workflow.json', retry_workflow: 'n8n/publish-retry.workflow.json' }, null, 2)}</pre>
    </AppShellLayout>
  );
}
