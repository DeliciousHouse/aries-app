import AppShellLayout from '@/frontend/app-shell/layout';
import AriesCommentsScreen from '@/frontend/aries-v1/comments-screen';

export const metadata = {
  title: 'Comments — Aries AI',
};

export default function DashboardCommentsPage() {
  return (
    <AppShellLayout currentRouteId="comments" loginRedirectPath="/dashboard/comments">
      <AriesCommentsScreen />
    </AppShellLayout>
  );
}
