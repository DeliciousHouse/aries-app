import AppShellLayout from "@/frontend/app-shell/layout";
import { InsightsDashboard } from "@/frontend/insights/InsightsDashboard";

export const metadata = {
  title: "Insights — Aries AI",
};

/**
 * /insights — the redesigned, real-backend analytics dashboard.
 *
 * Renders inside the shared AppShellLayout (same chrome as every other authed
 * screen) so it inherits the real left-nav, the real operator identity, and the
 * auth + onboarding gate (the shell redirects unauthenticated users to /login).
 * The dark insights canvas + the nine data sections live in InsightsDashboard.
 */
export default function InsightsPage() {
  return (
    <AppShellLayout currentRouteId="insights" loginRedirectPath="/insights">
      <InsightsDashboard />
    </AppShellLayout>
  );
}
