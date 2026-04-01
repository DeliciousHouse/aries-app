import AppShellLayout from '@/frontend/app-shell/layout';
import AriesChannelIntegrationsScreen from '@/frontend/aries-v1/channel-integrations-screen';

export default function DashboardChannelIntegrationsPage() {
  return (
    <AppShellLayout currentRouteId="channelIntegrations">
      <AriesChannelIntegrationsScreen />
    </AppShellLayout>
  );
}

