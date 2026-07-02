import AppShellLayout from '@/frontend/app-shell/layout';
import ComposioConnectionsScreen from '@/frontend/integrations/composio-connections-screen';

export const metadata = {
  title: 'Channel Integrations — Aries AI',
};

// Renders the Composio account-connections surface INSIDE the dashboard shell so
// operators connect Facebook/Instagram (and the other toolkits) from the
// existing "Channel Integrations" nav entry instead of a separate /connections
// page. The /oauth/connect route handlers remain available as the direct-OAuth
// fallback, but Composio brokers all primary connections.
export default function DashboardChannelIntegrationsPage() {
  return (
    <AppShellLayout currentRouteId="channelIntegrations">
      <ComposioConnectionsScreen />
    </AppShellLayout>
  );
}
