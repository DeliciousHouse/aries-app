import AppShellLayout from '@/frontend/app-shell/layout';
import ComposioConnectionsScreen from '@/frontend/integrations/composio-connections-screen';

export const metadata = {
  title: 'Channel Integrations — Aries AI',
};

// Renders the Composio account-connections surface INSIDE the dashboard shell so
// operators connect Facebook/Instagram (and the other toolkits) from the
// existing "Channel Integrations" nav entry instead of a separate /connections
// page. The legacy direct-Meta OAuth screen (AriesChannelIntegrationsScreen) and
// its /oauth/connect routes are retained but are no longer the primary connect
// surface now that Composio brokers connections.
export default function DashboardChannelIntegrationsPage() {
  return (
    <AppShellLayout currentRouteId="channelIntegrations">
      <ComposioConnectionsScreen />
    </AppShellLayout>
  );
}
