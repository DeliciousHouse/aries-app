import AppShellLayout from '@/frontend/app-shell/layout';
import AriesAnalyticsScreen from '@/frontend/aries-v1/analytics-screen';
import {
  isXEnabled,
  isYouTubeEnabled,
  isRedditEnabled,
  isLinkedInEnabled,
} from '@/backend/integrations/providers/integration-config';
import type { Platform } from '@/backend/insights/platforms/registry';

export const metadata = {
  title: 'Analytics — Aries AI',
};

export default function DashboardAnalyticsPage() {
  // Build the ordered enabled-platforms list server-side from env flags.
  // Facebook is always first. All other platforms are gated by their rollout
  // flags; when all flags are OFF this collapses to ['facebook'] and the
  // client-side selector is never rendered (length === 1 guard in the screen).
  const enabledPlatforms: Platform[] = [
    'facebook',
    ...(isXEnabled() ? (['x'] as const) : []),
    ...(isYouTubeEnabled() ? (['youtube'] as const) : []),
    ...(isRedditEnabled() ? (['reddit'] as const) : []),
    ...(isLinkedInEnabled() ? (['linkedin'] as const) : []),
  ];

  return (
    <AppShellLayout currentRouteId="analytics" loginRedirectPath="/dashboard/analytics">
      <AriesAnalyticsScreen enabledPlatforms={enabledPlatforms} />
    </AppShellLayout>
  );
}
