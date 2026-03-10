import AppShellLayout from '../../frontend/app-shell/layout';

export default function PostsPage() {
  return (
    <AppShellLayout currentRouteId="posts">
      <h2>Posts</h2>
      <p>Create and dispatch normalized publish events to n8n.</p>
      <pre>{JSON.stringify({ endpoint: '/api/publish/dispatch', mode: 'n8n-first', schema: 'publish_event_v1' }, null, 2)}</pre>
    </AppShellLayout>
  );
}
