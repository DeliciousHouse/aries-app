import MarketingLayout from '../../frontend/marketing/MarketingLayout';
import { Card } from '@/components/redesign/primitives/card';

const ENDPOINTS = [
  {
    method: 'POST',
    path: '/api/contact',
    desc: 'Log a contact inquiry and return an explicit placeholder error.',
    body: '{ "user": { "name", "email", "company" }, "details": { "message" } }',
    response:
      '{ "status": "error", "message": "Contact submissions are not implemented in this runtime.", "details": { "wired": false, "reason": "no_contact_workflow", "logged": true } }',
  },
  {
    method: 'POST',
    path: '/api/waitlist',
    desc: 'Log a waitlist signup and return an explicit placeholder error.',
    body: '{ "user": { "email" } }',
    response:
      '{ "status": "error", "message": "Waitlist signups are not implemented in this runtime.", "details": { "wired": false, "reason": "no_waitlist_workflow", "logged": true } }',
  },
  {
    method: 'POST',
    path: '/api/onboarding/start',
    desc: 'Start tenant onboarding via the Aries internal API.',
    body: '{ "tenant_id", "tenant_type", "signup_event_id" }',
    response:
      '{ "status": "ok", "tenant_id": "...", "tenant_type": "...", "signup_event_id": "...", "onboarding_status": "accepted|validated|duplicate|needs_repair" }',
  },
  {
    method: 'GET',
    path: '/api/onboarding/status/:tenantId',
    desc: 'Read onboarding status from local runtime state without exposing artifact paths.',
    body: '—',
    response:
      '{ "onboarding_status": "ok", "tenant_id": "...", "signup_event_id": "...", "provisioning_status": "validated|needs_repair|in_progress|duplicate|not_found", "validation_status": "pass|fail|unknown", "progress_hint": "...", "artifacts": { "draft": true, "validated": false, "validation_report": false, "idempotency_marker": true } }',
  },
  {
    method: 'POST',
    path: '/api/marketing/jobs',
    desc: 'Create the canonical brand campaign marketing job.',
    body:
      '{ "jobType": "brand_campaign", "payload": { "brandUrl", "competitorUrl" } }',
    response:
      '{ "marketing_job_status": "accepted", "jobId": "...", "jobType": "brand_campaign", "approvalRequired": true, "jobStatusUrl": "/marketing/job-status?jobId=..." }',
  },
  {
    method: 'GET',
    path: '/api/marketing/jobs/:jobId',
    desc: 'Read current marketing job state from the local runtime read model.',
    body: '—',
    response:
      '{ "jobId": "...", "marketing_job_state": "...", "marketing_job_status": "...", "marketing_stage": "...", "marketing_stage_status": {...}, "updatedAt": "...", "needs_attention": false, "approvalRequired": true, "summary": { "headline": "...", "subheadline": "..." }, "stageCards": [...], "artifacts": [...], "timeline": [...], "approval": { "required": true, "title": "...", "message": "..." }, "nextStep": "submit_approval", "repairStatus": "not_required" }',
  },
  {
    method: 'POST',
    path: '/api/marketing/jobs/:jobId/approve',
    desc: 'Approve a marketing job through the OpenClaw boundary.',
    body:
      '{ "approvedBy", "approvedStages"?: ["research"|"strategy"|"production"|"publish"], "resumePublishIfNeeded"?: true }',
    response:
      '{ "approval_status": "resumed|error", "jobId": "...", "resumedStage": "publish", "completed": true, "reason"?: "approval_not_available", "jobStatusUrl": "/marketing/job-status?jobId=..." }',
  },
  {
    method: 'POST',
    path: '/api/publish/dispatch',
    desc: 'Normalize and dispatch a publish event through Aries internal APIs.',
    body: '{ "provider", "content", "media_urls", "scheduled_for"?: "..." }',
    response:
      '{ "status": "error", "reason": "workflow_missing_for_route", "route": "publish.dispatch", "message": "..." }',
  },
  {
    method: 'GET',
    path: '/api/integrations',
    desc: 'List live OAuth broker status for supported platforms.',
    body: '—',
    response:
      '{ "status": "ok", "cards": [{ "platform": "facebook", "connection_state": "connected|not_connected|reauth_required", "health": "healthy|degraded|error|unknown", "last_synced_at": null, "expires_at": "..."|null }] }',
  },
  {
    method: 'POST',
    path: '/api/integrations/sync',
    desc: 'Trigger a manual integration sync through the OpenClaw boundary.',
    body: '{ "platform": "facebook" }',
    response:
      '{ "status": "error", "reason": "workflow_missing_for_route", "route": "integrations.sync", "message": "..." }',
  },
  {
    method: 'POST',
    path: '/api/events',
    desc: 'Log a frontend event and return an explicit placeholder error.',
    body: '{ "intent": "cta_click", "page": "/", "meta": {} }',
    response:
      '{ "status": "error", "message": "Event tracking is not implemented in this runtime.", "details": { "wired": false, "reason": "no_event_workflow", "logged": true } }',
  },
];

export default function ApiDocsPage() {
  return (
    <MarketingLayout currentPath="/api-docs">
      <section className="rd-section">
        <div className="rd-container" style={{ display: 'grid', gap: '1.5rem' }}>
          <div style={{ display: 'grid', gap: '1rem', maxWidth: '52rem' }}>
            <span className="rd-section-label">API reference</span>
            <h1 className="rd-section-title">Internal routes that keep the browser contract safe</h1>
            <p className="rd-section-description">
              These are the routes the browser can call. Aries stays responsible for validation, auth context, payload shaping,
              and workflow orchestration boundaries.
            </p>
          </div>

          <Card>
            <div style={{ display: 'grid', gap: '1rem' }}>
              <h3 style={{ margin: 0, fontFamily: 'var(--rd-font-display)', fontSize: '1.3rem' }}>Base URL</h3>
              <div className="rd-json-panel">
                <code>[REDACTED]</code>
              </div>
              <p className="rd-section-description">
                App-shell endpoints use session authentication. Public marketing endpoints exist, but contact, waitlist,
                and events are still explicit placeholders until corresponding workflows are deployed.
              </p>
            </div>
          </Card>

          <div style={{ display: 'grid', gap: '1.25rem' }}>
            {ENDPOINTS.map((endpoint) => (
              <Card key={`${endpoint.method}-${endpoint.path}`}>
                <div style={{ display: 'grid', gap: '1rem' }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.75rem' }}>
                    <span className="rd-badge">{endpoint.method}</span>
                    <code style={{ fontWeight: 700 }}>{endpoint.path}</code>
                  </div>
                  <p className="rd-section-description">{endpoint.desc}</p>
                  <div className="rd-workflow-grid rd-workflow-grid--2">
                    <div>
                      <p className="rd-label" style={{ marginBottom: '0.5rem' }}>Request body</p>
                      <div className="rd-json-panel"><code>{endpoint.body}</code></div>
                    </div>
                    <div>
                      <p className="rd-label" style={{ marginBottom: '0.5rem' }}>Response</p>
                      <div className="rd-json-panel"><code>{endpoint.response}</code></div>
                    </div>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      </section>
    </MarketingLayout>
  );
}
