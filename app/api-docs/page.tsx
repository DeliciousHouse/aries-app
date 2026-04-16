import React from 'react';
import MarketingLayout from '../../frontend/marketing/MarketingLayout';

export const metadata = {
  title: 'API — Aries AI',
};

const ENDPOINTS = [
  {
    method: 'POST',
    path: '/api/contact',
    desc: 'Submit a contact request. Returns an explicit unavailable response until a contact handler is configured.',
    body: '{ "name", "email", "message" }',
    response:
      '{ "status": "error", "reason": "contact_not_configured", "message": "Contact intake is not configured yet.", "request": { "name": "...", "email": "...", "message_present": true } }',
  },
  {
    method: 'POST',
    path: '/api/onboarding/start',
    desc: 'Start business onboarding and set up the workspace.',
    body: '{ "tenant_id", "tenant_type", "signup_event_id" }',
    response:
      '{ "status": "ok", "tenant_id": "...", "tenant_type": "...", "signup_event_id": "...", "onboarding_status": "accepted|validated|duplicate|needs_repair" }',
  },
  {
    method: 'POST',
    path: '/api/marketing/jobs',
    desc: 'Create a new marketing campaign.',
    body:
      '{ "jobType": "brand_campaign", "payload": { "brandUrl", "competitorUrl"?, "competitorBrand"?, "facebookPageUrl"?, "adLibraryUrl"?, "metaPageId"? } }',
    response:
      '{ "marketing_job_status": "accepted", "jobId": "...", "jobType": "brand_campaign", "marketing_stage": "strategy", "approvalRequired": true, "approval": { ... }, "jobStatusUrl": "/marketing/job-status?jobId=..." }',
  },
  {
    method: 'GET',
    path: '/api/marketing/jobs/:jobId',
    desc: 'Read the current state of a marketing campaign.',
    body: '\u2014',
    response:
      '{ "jobId": "...", "marketing_job_state": "...", "marketing_job_status": "...", "marketing_stage": "...", "approvalRequired": true, "summary": { ... }, "stageCards": [...], "artifacts": [...], "timeline": [...], "approval": { ... }, "nextStep": "submit_approval" }',
  },
  {
    method: 'POST',
    path: '/api/marketing/jobs/:jobId/approve',
    desc: 'Approve a campaign checkpoint and resume the next stage.',
    body:
      '{ "approvedBy", "approvedStages"?: ["strategy"|"production"|"publish"], "resumePublishIfNeeded"?: true, "publishConfig"?: { ... } }',
    response:
      '{ "approval_status": "resumed|error", "jobId": "...", "resumedStage": "publish", "completed": true }',
  },
  {
    method: 'GET',
    path: '/api/integrations',
    desc: 'List connected channel status and health.',
    body: '\u2014',
    response:
      '{ "status": "ok", "cards": [{ "platform": "facebook", "connection_state": "connected|not_connected|reauth_required", "health": "healthy|degraded|error|unknown" }] }',
  },
  {
    method: 'POST',
    path: '/api/integrations/connect',
    desc: 'Start a channel connection from the app.',
    body: '{ "platform": "facebook" }',
    response:
      '{ "broker_status": "ok|error", "provider": "facebook", "authorization_url"?: "..." }',
  },
  {
    method: 'POST',
    path: '/api/publish/dispatch',
    desc: 'Submit approved content for publishing.',
    body: '{ "provider", "content", "media_urls", "scheduled_for"?: "..." }',
    response:
      '{ "status": "accepted|error" }',
  },
  {
    method: 'POST',
    path: '/api/calendar/sync',
    desc: 'Request a calendar synchronization.',
    body: '{ "window_start"?: "...", "window_end"?: "..." }',
    response:
      '{ "status": "accepted|error" }',
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
              Browser-safe routes for the <span className="text-gradient">current Aries contract</span>
            </h1>
            <p className="text-xl text-white/60">
              These are the routes the Aries app uses internally. The app handles validation, authentication, and safe response shaping so the browser never touches internal systems directly.
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
