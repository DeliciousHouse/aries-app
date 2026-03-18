import AppShellLayout from '../../frontend/app-shell/layout';

export default function PostsPage() {
  return (
    <AppShellLayout currentRouteId="posts">
      <div className="grid-2" style={{ marginBottom: '2rem' }}>
        <div className="glass-card-static">
          <h3 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '0.75rem' }}>Create New Job</h3>
          <p style={{ fontSize: '0.875rem', color: 'rgba(248,245,242,0.65)', marginBottom: '1rem' }}>
            Start a new marketing pipeline via the repo-managed workflow engine.
          </p>
          <a href="/marketing/new-job" className="btn btn-primary btn-sm">New Marketing Job</a>
        </div>
        <div className="glass-card-static">
          <h3 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '0.75rem' }}>Dispatch Publish Event</h3>
          <p style={{ fontSize: '0.875rem', color: 'rgba(248,245,242,0.65)', marginBottom: '1rem' }}>
            Send a normalized publish event directly to the dispatch queue.
          </p>
          <div className="code-block" style={{ fontSize: '0.8rem' }}>
            <code>POST /api/publish/dispatch</code>
          </div>
        </div>
      </div>

      <div className="glass-card-static">
        <h3 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '0.75rem' }}>Job History</h3>
        <p style={{ fontSize: '0.875rem', color: 'rgba(248,245,242,0.65)' }}>
          Marketing job history will appear here once jobs are dispatched through the pipeline.
          Each job progresses through research → strategy → production → publish stages.
        </p>
      </div>
    </AppShellLayout>
  );
}
