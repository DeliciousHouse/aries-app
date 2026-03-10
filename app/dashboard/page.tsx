import AppShellLayout from '../../frontend/app-shell/layout';

export default function DashboardPage() {
  return (
    <AppShellLayout currentRouteId="dashboard">
      <h2>Operations Dashboard</h2>
      <p>Aries parity shell is now centered on operator workflows, not runtime-only routes.</p>
      <ul>
        <li>Connection health summary across Meta, LinkedIn, X, YouTube, TikTok, and Reddit</li>
        <li>n8n dispatch queue visibility and retry backlog</li>
        <li>Scheduled publish volume and token expiry watchlist</li>
      </ul>
    </AppShellLayout>
  );
}
