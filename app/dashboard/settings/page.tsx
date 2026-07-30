import AppShellLayout from '@/frontend/app-shell/layout';
import AriesSettingsScreen from '@/frontend/aries-v1/settings-screen';
import { isUsageAnalyticsEnabled } from '@/backend/telemetry/usage-analytics-env';

export const metadata = {
  title: 'Settings — Aries AI',
};

export default function DashboardSettingsPage() {
  return (
    <AppShellLayout currentRouteId="settings">
      {/* AA-166: read server-side so the usage-breakdown link is only offered
          when the flag-gated page actually exists. */}
      <AriesSettingsScreen usageAnalyticsEnabled={isUsageAnalyticsEnabled()} />
    </AppShellLayout>
  );
}
