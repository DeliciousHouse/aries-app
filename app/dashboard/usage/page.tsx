import { notFound } from 'next/navigation';

import AppShellLayout from '@/frontend/app-shell/layout';
import AriesUsageScreen from '@/frontend/aries-v1/usage-screen';
import { isUsageAnalyticsEnabled } from '@/backend/telemetry/usage-analytics-env';

export const metadata = {
  title: 'Usage — Aries AI',
};

/**
 * AA-166 — the usage breakdown, reached from the Settings "Usage & capacity"
 * card. Flag-gated to a real 404 so the page is invisible when the feature is
 * off, matching its route.
 *
 * currentRouteId is 'settings' rather than a new nav entry: the page is
 * admin-only, and a nav item every role can see but only admins can open would
 * be a dead end for most of the team.
 */
export default function DashboardUsagePage() {
  if (!isUsageAnalyticsEnabled()) {
    notFound();
  }

  return (
    <AppShellLayout currentRouteId="settings" loginRedirectPath="/dashboard/usage">
      <AriesUsageScreen />
    </AppShellLayout>
  );
}
