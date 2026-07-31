import AppShellLayout from "@/frontend/app-shell/layout";
import { InsightsDashboard } from "@/frontend/insights/InsightsDashboard";
import { isNativeReplyEnabled } from "@/backend/integrations/meta-reply-env";

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
  // Read the native-reply rollout flag server-side and pass it down, mirroring
  // how the review page gates the image-edit drawer. When it is off the reply
  // endpoint returns a real 404, so the UI must not offer a control that
  // cannot succeed.
  const nativeReplyEnabled = isNativeReplyEnabled();

  return (
    <AppShellLayout currentRouteId="insights" loginRedirectPath="/insights">
      <InsightsDashboard nativeReplyEnabled={nativeReplyEnabled} />
    </AppShellLayout>
  );
}
