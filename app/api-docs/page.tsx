import MarketingLayout from '../../frontend/marketing/MarketingLayout';

const ENDPOINTS = [
  {
    method: 'POST',
    path: '/api/contact',
    desc: 'Submit a contact inquiry',
    body: '{ "user": { "name", "email", "company" }, "details": { "message" } }',
    response: '{ "status": "ok", "received": true }',
  },
  {
    method: 'POST',
    path: '/api/demo',
    desc: 'Request a demo / get started',
    body: '{ "user": { "name", "email", "company", "teamSize" }, "details": { "useCase" } }',
    response: '{ "status": "ok", "tenant_id": "...", "state": "accepted" }',
  },
  {
    method: 'POST',
    path: '/api/sandbox/launch',
    desc: 'Launch a sandbox environment',
    body: '{ "user": { "email" }, "details": { "useCase" } }',
    response: '{ "status": "ok", "tenant_id": "...", "tenant_type": "sandbox" }',
  },
  {
    method: 'POST',
    path: '/api/onboarding/start',
    desc: 'Start tenant onboarding',
    body: '{ "tenant_id", "tenant_type", "signup_event_id" }',
    response: '{ "status": "ok", "tenant_id": "...", "state": "accepted|validated|duplicate" }',
  },
  {
    method: 'GET',
    path: '/api/onboarding/status/:tenantId',
    desc: 'Check provisioning status',
    body: '—',
    response: '{ "status": "ok", "provisioning_status": "..." }',
  },
  {
    method: 'POST',
    path: '/api/marketing/jobs',
    desc: 'Create a new marketing job',
    body: '{ "tenant_id", "topic", "platforms": [...], "tone", "audience" }',
    response: '{ "status": "accepted", "job_id": "..." }',
  },
  {
    method: 'GET',
    path: '/api/marketing/jobs/:jobId',
    desc: 'Get job status and outputs',
    body: '—',
    response: '{ "status": "ok", "job": { ... } }',
  },
  {
    method: 'POST',
    path: '/api/publish/dispatch',
    desc: 'Dispatch a publish event',
    body: '{ "tenant_id", "provider", "content", "media_urls" }',
    response: '{ "status": "ok", "dispatched_to": "n8n/publish-dispatch" }',
  },
  {
    method: 'GET',
    path: '/api/integrations',
    desc: 'List all platform connections',
    body: '—',
    response: '{ "status": "ok", "cards": [...] }',
  },
  {
    method: 'POST',
    path: '/api/events',
    desc: 'Track frontend events',
    body: '{ "intent": "cta_click", "page": "/", "meta": {} }',
    response: '{ "status": "ok", "tracked": true }',
  },
];

export default function ApiDocsPage() {
  return (
    <MarketingLayout currentPath="/api-docs">
      <section className="section page-api">
        <div className="container">
          <div className="section-header">
            <span className="section-label">API Reference</span>
            <h1 className="section-title">Aries Platform API</h1>
            <p className="section-desc">
              Internal API endpoints for frontend integration, webhook proxying, and platform operations.
            </p>
          </div>

          <div className="glass-card-static" style={{ marginBottom: '2rem', padding: '1.5rem' }}>
            <h3 style={{ marginBottom: '0.75rem', fontSize: '1rem' }}>Base URL</h3>
            <div className="code-block">
              <code>https://aries.sugarandleather.com</code>
            </div>
            <p style={{ marginTop: '0.75rem', fontSize: '0.875rem', color: 'rgba(248,245,242,0.65)' }}>
              All endpoints accept and return JSON. Authentication is handled via session cookies for app-shell routes.
              Marketing site endpoints (contact, demo, events) are public.
            </p>
          </div>

          <div style={{ display: 'grid', gap: '1.5rem' }}>
            {ENDPOINTS.map((ep) => (
              <div className="glass-card-static" key={`${ep.method}-${ep.path}`} style={{ padding: '1.5rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem' }}>
                  <span style={{
                    display: 'inline-block',
                    padding: '2px 10px',
                    borderRadius: '4px',
                    fontSize: '0.75rem',
                    fontWeight: 700,
                    letterSpacing: '0.05em',
                    background: ep.method === 'GET' ? 'rgba(52,211,153,0.15)' : 'rgba(96,165,250,0.15)',
                    color: ep.method === 'GET' ? '#34D399' : '#60A5FA',
                    border: `1px solid ${ep.method === 'GET' ? 'rgba(52,211,153,0.3)' : 'rgba(96,165,250,0.3)'}`,
                  }}>
                    {ep.method}
                  </span>
                  <code style={{ fontSize: '0.9rem', fontWeight: 600 }}>{ep.path}</code>
                </div>
                <p style={{ fontSize: '0.875rem', color: 'rgba(248,245,242,0.65)', marginBottom: '0.75rem' }}>
                  {ep.desc}
                </p>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                  <div>
                    <p style={{ fontSize: '0.75rem', fontWeight: 600, color: 'rgba(248,245,242,0.4)', marginBottom: '0.5rem' }}>Request Body</p>
                    <div className="code-block"><code>{ep.body}</code></div>
                  </div>
                  <div>
                    <p style={{ fontSize: '0.75rem', fontWeight: 600, color: 'rgba(248,245,242,0.4)', marginBottom: '0.5rem' }}>Response</p>
                    <div className="code-block"><code>{ep.response}</code></div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </MarketingLayout>
  );
}
