import React from 'react';
import MarketingLayout from '../../frontend/marketing/MarketingLayout';

const ENDPOINTS = [
  {
    method: 'POST',
    path: '/api/contact',
    desc: 'Accept a browser-safe contact payload and return explicit unavailable semantics until a real contact adapter is configured.',
    body: '{ "name", "email", "message" }',
    response:
      '{ "status": "error", "reason": "contact_not_configured", "message": "Contact intake is not configured in this Aries runtime yet.", "request": { "name": "...", "email": "...", "message_present": true } }',
  },
  {
    method: 'POST',
    path: '/api/onboarding/start',
    desc: 'Start tenant onboarding through the Aries route boundary.',
    body: '{ "tenant_id", "tenant_type", "signup_event_id" }',
    response:
      '{ "status": "ok", "tenant_id": "...", "tenant_type": "...", "signup_event_id": "...", "onboarding_status": "accepted|validated|duplicate|needs_repair" }',
  },
  {
    method: 'GET',
    path: '/api/onboarding/status/:tenantId',
    desc: 'Read onboarding status from runtime state without exposing artifact paths.',
    body: '—',
    response:
      '{ "onboarding_status": "ok", "tenant_id": "...", "signup_event_id": "...", "provisioning_status": "validated|needs_repair|in_progress|duplicate|not_found", "validation_status": "pass|fail|unknown", "progress_hint": "...", "artifacts": { "draft": true, "validated": false, "validation_report": false, "idempotency_marker": true } }',
  },
  {
    method: 'POST',
    path: '/api/marketing/jobs',
    desc: 'Create the canonical `brand_campaign` marketing job.',
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
    desc: 'Resume an approval-gated marketing run.',
    body:
      '{ "approvedBy", "approvedStages"?: ["research"|"strategy"|"production"|"publish"], "resumePublishIfNeeded"?: true }',
    response:
      '{ "approval_status": "resumed|error", "jobId": "...", "resumedStage": "publish", "completed": true, "reason"?: "approval_not_available", "jobStatusUrl": "/marketing/job-status?jobId=..." }',
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
    path: '/api/integrations/connect',
    desc: 'Start a provider connection from the authenticated app shell.',
    body: '{ "platform": "facebook" }',
    response:
      '{ "broker_status": "ok|error", "provider": "facebook", "authorization_url"?: "..." }',
  },
  {
    method: 'POST',
    path: '/api/integrations/disconnect',
    desc: 'Disconnect an existing provider connection.',
    body: '{ "platform": "facebook" }',
    response:
      '{ "broker_status": "ok|error", "provider": "facebook" }',
  },
  {
    method: 'GET',
    path: '/api/platform-connections',
    desc: 'Read summarized platform connection state and token health.',
    body: '—',
    response:
      '{ "status": "ok", "connections": [{ "platform": "facebook", "state": "connected|not_connected|reauth_required", "token_health": "healthy|degraded|error|unknown" }] }',
  },
  {
    method: 'POST',
    path: '/api/publish/dispatch',
    desc: 'Submit publish work through the Aries route boundary.',
    body: '{ "provider", "content", "media_urls", "scheduled_for"?: "..." }',
    response:
      '{ "status": "accepted|error", "workflow_id"?: "publish_dispatch", "workflow_status"?: "...", "result"?: {...}, "reason"?: "...", "message"?: "..." }',
  },
  {
    method: 'POST',
    path: '/api/calendar/sync',
    desc: 'Request a calendar synchronization run.',
    body: '{ "window_start"?: "...", "window_end"?: "..." }',
    response:
      '{ "status": "accepted|error", "workflow_id"?: "calendar_sync", "workflow_status"?: "...", "result"?: {...}, "reason"?: "...", "message"?: "..." }',
  },
];

const VALIDATION_COMMANDS = [
  './node_modules/.bin/tsx --test tests/runtime-pages.test.ts',
  'node scripts/check-banned-patterns.mjs',
  'APP_BASE_URL=https://aries.example.com ./node_modules/.bin/tsx --test tests/marketing-job-flow.test.ts tests/onboarding-marketing-contracts.test.ts',
  "mkdir -p .artifacts && npx --yes lighthouse http://127.0.0.1:3000 --only-categories=performance --preset=desktop --chrome-flags='--headless=new --no-sandbox --disable-dev-shm-usage' --output=json --output-path=.artifacts/lighthouse-homepage.json",
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
              Browser-safe routes for the <span className="text-gradient">current Aries contract</span>
            </h1>
            <p className="text-xl text-white/60">
              These are the internal routes the current UI depends on. Aries owns validation, auth context, payload shaping, and the handoff into runtime state or OpenClaw execution.
            </p>
          </div>

          <div className="glass rounded-[2rem] p-8 md:p-10">
            <h2 className="text-2xl font-bold mb-4">Base URL</h2>
            <div className="rounded-[1.25rem] border border-white/10 bg-black/30 p-5 font-mono text-white/75">http://localhost:3000</div>
            <p className="text-white/60 mt-4">
              Public docs live outside auth, while operator endpoints require session and tenant context. Routes that are not fully configured still return explicit unavailable semantics instead of silent fake success payloads.
            </p>
          </div>

          <div className="glass rounded-[2rem] p-8 md:p-10">
            <h2 className="text-2xl font-bold mb-4">Validation</h2>
            <div className="space-y-3">
              {VALIDATION_COMMANDS.map((command) => (
                <div key={command} className="rounded-[1.25rem] border border-white/10 bg-black/30 p-5 font-mono text-sm text-white/75 break-all">
                  {command}
                </div>
              ))}
            </div>
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
