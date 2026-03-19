import MarketingLayout from '../../frontend/marketing/MarketingLayout';

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
    <MarketingLayout>
      <section className="pt-36 pb-24">
        <div className="container mx-auto px-6 space-y-10">
          <div className="max-w-4xl">
            <span className="inline-flex px-4 py-2 rounded-full border border-primary/20 bg-primary/10 text-primary text-xs uppercase tracking-[0.2em] font-semibold mb-6">
              API reference
            </span>
            <h1 className="text-5xl md:text-6xl font-bold leading-tight mb-6">
              Internal routes that keep the browser contract <span className="text-gradient">safe</span>
            </h1>
            <p className="text-xl text-white/60">
              These are the routes the browser can call. Aries stays responsible for validation, auth context, payload shaping, and execution-boundary orchestration.
            </p>
          </div>

          <div className="glass rounded-[2rem] p-8 md:p-10">
            <h2 className="text-2xl font-bold mb-4">Base URL</h2>
            <div className="rounded-[1.25rem] border border-white/10 bg-black/30 p-5 font-mono text-white/75">[REDACTED]</div>
            <p className="text-white/60 mt-4">
              App-shell endpoints use session authentication. Public marketing endpoints exist, but contact, waitlist, and events are still explicit placeholders until corresponding workflows are deployed.
            </p>
          </div>

          <div className="space-y-6">
            {ENDPOINTS.map((endpoint) => (
              <div key={`${endpoint.method}-${endpoint.path}`} className="glass rounded-[2rem] p-8">
                <div className="flex flex-wrap items-center gap-3 mb-4">
                  <span className="inline-flex px-3 py-1 rounded-full bg-primary/15 border border-primary/20 text-primary text-xs uppercase tracking-[0.2em] font-semibold">
                    {endpoint.method}
                  </span>
                  <code className="font-semibold text-white">{endpoint.path}</code>
                </div>
                <p className="text-white/60 mb-6">{endpoint.desc}</p>
                <div className="grid lg:grid-cols-2 gap-6">
                  <div>
                    <p className="text-xs uppercase tracking-[0.2em] text-white/40 mb-3">Request body</p>
                    <div className="rounded-[1.25rem] border border-white/10 bg-black/30 p-5 font-mono text-sm text-white/75 break-words">
                      {endpoint.body}
                    </div>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-[0.2em] text-white/40 mb-3">Response</p>
                    <div className="rounded-[1.25rem] border border-white/10 bg-black/30 p-5 font-mono text-sm text-white/75 break-words">
                      {endpoint.response}
                    </div>
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
