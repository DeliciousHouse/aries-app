import AppShellLayout from '@/frontend/app-shell/layout';
import AriesCalendarScreen from '@/frontend/aries-v1/calendar-screen';
import {
  isLinkedInEnabled,
  isRedditEnabled,
  isXEnabled,
  isYouTubeEnabled,
} from '@/backend/integrations/providers/integration-config';
import type { AllowedTargetPlatform } from '@/backend/social-content/scheduled-posts';

export const metadata = {
  title: 'Calendar — Aries AI',
};

export default function DashboardCalendarPage() {
  const allowedPublishPlatforms: AllowedTargetPlatform[] = [
    'facebook',
    'instagram',
    ...(isXEnabled() ? (['x'] as const) : []),
    ...(isRedditEnabled() ? (['reddit'] as const) : []),
    ...(isLinkedInEnabled() ? (['linkedin'] as const) : []),
    ...(isYouTubeEnabled() ? (['youtube'] as const) : []),
  ];

  return (
    <AppShellLayout currentRouteId="calendar" loginRedirectPath="/dashboard/calendar">
      <AriesCalendarScreen allowedPublishPlatforms={allowedPublishPlatforms} />
    </AppShellLayout>
  );
}
