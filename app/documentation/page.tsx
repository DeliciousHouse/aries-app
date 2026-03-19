import React from 'react';

import MarketingLayout from '../../frontend/marketing/MarketingLayout';

const SUMMARY_SECTIONS = [
  {
    title: 'Runtime overview',
    body: 'Aries serves public pages, an operator shell, and internal API routes that normalize browser requests before they cross into workflow execution.',
  },
  {
    title: 'Execution boundary',
    body: 'Browsers call Aries only. Aries calls OpenClaw. OpenClaw resolves Lobster workflows. This keeps provider secrets and workflow internals server-side.',
  },
  {
    title: 'Operator workflow',
    body: 'Connect platforms, launch campaign jobs, review status, approve human-in-the-loop stages, and trigger publish or sync actions from typed internal routes.',
  },
];

const WORKFLOW_ROWS = [
  ['marketing_start', 'marketing-pipeline.lobster', 'Canonical brand campaign flow'],
  ['demo_start', 'parity/demo-start/workflow.lobster', 'Demo provisioning parity stub'],
  ['sandbox_launch', 'parity/sandbox-launch/workflow.lobster', 'Sandbox provisioning parity stub'],
  ['onboarding_start', 'parity/onboarding-start/workflow.lobster', 'Tenant onboarding parity stub'],
  ['publish_dispatch', 'parity/publish-dispatch/workflow.lobster', 'Publish dispatch parity stub'],
  ['publish_retry', 'parity/publish-retry/workflow.lobster', 'Retry and repair parity stub'],
  ['calendar_sync', 'parity/calendar-sync/workflow.lobster', 'Calendar synchronization parity stub'],
  ['integrations_sync', 'parity/integrations-sync/workflow.lobster', 'Platform sync parity stub'],
];

export default function DocumentationPage() {
  return (
    <MarketingLayout>
      <section className="public-page-section">
        <div className="container space-y-8 md:space-y-10">
          <div className="max-w-4xl">
            <span className="eyebrow mb-6">
              Documentation
            </span>
            <h1 className="public-heading-lg mb-6 max-w-5xl">
              Getting Aries running locally without losing <span className="text-gradient">runtime truth</span>
            </h1>
            <p className="public-subcopy">
              The goal of this runtime is clarity: stable page routes, stable internal APIs, and a workflow boundary that never leaks browser concerns into OpenClaw or Lobster.
            </p>
          </div>

          <div className="grid gap-5 md:grid-cols-3">
            {SUMMARY_SECTIONS.map((section) => (
              <article key={section.title} className="glass rounded-[1.8rem] p-6 md:p-8">
                <h2 className="mb-4 font-display text-2xl font-semibold text-white">{section.title}</h2>
                <p className="text-sm leading-7 text-white/68 md:text-base">{section.body}</p>
              </article>
            ))}
          </div>

          <div className="glass rounded-[2rem] p-6 md:p-8 lg:p-10">
            <span className="eyebrow mb-5">
              Quick start
            </span>
            <h2 className="mb-5 font-display text-[clamp(2rem,4vw,3.3rem)] font-semibold leading-tight text-white">Recommended local development flow</h2>
            <div className="overflow-x-auto rounded-[1.5rem] border border-white/10 bg-black/30 p-5 md:p-6">
              <pre className="whitespace-pre-wrap text-sm leading-7 text-white/76 md:text-base">{`NODE_ENV=development npm ci
cp .env.example .env
export DB_HOST=localhost DB_PORT=5432 DB_USER=aries_user DB_PASSWORD=aries_pass DB_NAME=aries_dev
export CODE_ROOT=/workspace DATA_ROOT=/tmp/aries-data NODE_ENV=development
export APP_BASE_URL=http://localhost:3000 NEXTAUTH_URL=http://localhost:3000 AUTH_URL=http://localhost:3000 AUTH_TRUST_HOST=true
npx next dev -p 3000 --turbopack`}</pre>
            </div>
            <p className="mt-5 text-sm leading-7 text-white/68 md:text-base">
              Turbopack is required in this repo. The VM also injects environment variables at the OS level, so explicit overrides are part of a reliable local flow.
            </p>
          </div>

          <div className="glass rounded-[2rem] p-6 md:p-8 lg:p-10">
            <span className="eyebrow mb-5">
              Workflow catalog
            </span>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] border-separate border-spacing-y-3">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-[0.2em] text-white/44">
                    <th className="px-4">Workflow</th>
                    <th className="px-4">Pipeline</th>
                    <th className="px-4">Purpose</th>
                  </tr>
                </thead>
                <tbody>
                  {WORKFLOW_ROWS.map(([name, pipeline, purpose]) => (
                    <tr key={name} className="bg-white/5">
                      <td className="rounded-l-2xl px-4 py-4 font-semibold text-white">{name}</td>
                      <td className="px-4 py-4 text-sm text-white/68"><code>{pipeline}</code></td>
                      <td className="rounded-r-2xl px-4 py-4 text-sm text-white/68">{purpose}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>
    </MarketingLayout>
  );
}
