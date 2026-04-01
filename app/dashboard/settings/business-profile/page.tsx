import AppShellLayout from '@/frontend/app-shell/layout';
import AriesBusinessProfileScreen from '@/frontend/aries-v1/business-profile-screen';

export default function DashboardBusinessProfilePage() {
  return (
    <AppShellLayout currentRouteId="businessProfile">
      <AriesBusinessProfileScreen />
    </AppShellLayout>
  );
}

