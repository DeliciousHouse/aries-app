import MarketingLayout from '../../frontend/marketing/MarketingLayout';

const ENDPOINTS = [
  {
    method: 'POST',
    path: '/api/contact',
    desc: 'Log a contact inquiry and return an explicit placeholder error.',
    body: '{ "user": { "name", "email", "company" }, "details": { "message" } }',
    response: '{ "status": "error", "message": "Contact submissions are not implemented in this runtime.", "details": { "wired": false, "reason": "no_n8n_contact_workflow", "logged": true } }',
  },
  {
    method: 'POST',
    path: '/api/waitlist',
    desc: 'Log a waitlist signup and return an explicit placeholder error.',
    body: '{ "user": { "email" } }',
    response: '{ "status": "error", "message": "Waitlist signups are not implemented in this runtime.", "details": { "wired": false, "reason": "no_n8n_waitlist_workflow", "logged": true } }',
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
    response: '{ "status": "ok", "tenant_id": "...", "tenant_type": "...", "signup_event_id": "...", "onboarding_status": "accepted|validated|duplicate|needs_repair", "workflow_status": 200, "raw": {...} }',
  },
  {
    method: 'GET',
    path: '/api/onboarding/status/:tenantId',
    desc: 'Read onboarding status from local runtime artifacts.',
    body: '—',
    response: '{ "onboarding_status": "ok", "tenant_id": "...", "signup_event_id": "...", "provisioning_status": "validated|needs_repair|in_progress|duplicate|not_found", "validation_status": "pass|fail|unknown", "paths": {...} }',
  },
  {
    method: 'POST',
    path: '/api/marketing/jobs',
    desc: 'Create the canonical brand campaign marketing job.',
    body: '{ "tenantId", "jobType": "brand_campaign", "payload": { "brandUrl", "competitorUrl" } }',
    response: '{ "marketing_job_status": "accepted", "jobId": "...", "tenantId": "...", "jobType": "brand_campaign", "wiring": "n8n_brand_campaign_webhook|backend_fallback", "runtimePath": "generated/draft/marketing-jobs/..." }',
  },
  {
    method: 'GET',
    path: '/api/marketing/jobs/:jobId',
    desc: 'Read current marketing job state from the local runtime artifact.',
    body: '—',
    response: '{ "jobId": "...", "tenantId": "...", "marketing_job_state": "...", "marketing_job_status": "...", "marketing_stage": "...", "marketing_stage_status": {...}, "updatedAt": "...", "runtimePath": "generated/draft/marketing-jobs/..." }',
  },
  {
    method: 'POST',
    path: '/api/marketing/jobs/:jobId/approve',
    desc: 'Resume a marketing job via n8n or the local runtime fallback.',
    body: '{ "tenantId", "approvedBy", "approvedStages"?: ["research"|"strategy"|"production"|"publish"], "resumePublishIfNeeded"?: true }',
    response: '{ "approval_status": "resumed|error", "jobId": "...", "tenantId": "...", "resumedStage": "...", "completed": false, "wiring": "n8n_approval_resume_webhook|backend_fallback" }',
  },
  {
    method: 'POST',
    path: '/api/publish/dispatch',
    desc: 'Normalize and proxy a publish event to the n8n publish webhook.',
    body: '{ "tenant_id", "provider", "content", "media_urls", "scheduled_for"?: "..." }',
    response: '{ "status": "accepted", "dispatched": true, "webhookPath": "aries/publish", "downstreamStatus": 202, "event": {...} }',
  },
  {
    method: 'GET',
    path: '/api/integrations',
    desc: 'List live OAuth broker status for supported platforms.',
    body: '—',
    response: '{ "status": "ok", "cards": [{ "platform": "facebook", "connection_state": "connected|not_connected|reauth_required", "health": "healthy|degraded|error|unknown", "last_synced_at": null, "expires_at": "..."|null }] }',
  },
  {
    method: 'POST',
    path: '/api/events',
    desc: 'Log a frontend event and return an explicit placeholder error.',
    body: '{ "intent": "cta_click", "page": "/", "meta": {} }',
    response: '{ "status": "error", "message": "Event tracking is not implemented in this runtime.", "details": { "wired": false, "reason": "no_n8n_event_workflow", "logged": true } }',
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
              Marketing site endpoints are public, but `contact`, `waitlist`, and `events` are explicit placeholder APIs in the
              current runtime.
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
