import AppShellLayout from '@/frontend/app-shell/layout';
import AriesSettingsScreen from '@/frontend/aries-v1/settings-screen';

export const metadata = {
  title: 'Settings — Aries AI',
};

export default function DashboardSettingsPage() {
  return (
    <AppShellLayout currentRouteId="settings">
      <AriesSettingsScreen />
    </AppShellLayout>
  );
}
