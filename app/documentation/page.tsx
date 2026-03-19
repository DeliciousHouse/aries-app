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
    body: 'Connect platforms, launch campaign jobs, review status, approve strategy/production/publish checkpoints, and generate platform-specific publish packages from typed internal routes.',
  },
];

const WORKFLOW_ROWS = [
  ['marketing_stage1_research', 'stage-1-research/workflow.lobster', 'Research stage execution'],
  ['marketing_stage2_strategy_review', 'stage-2-strategy/review-workflow.lobster', 'Strategy stage execution and approval checkpoint'],
  ['marketing_stage2_strategy_finalize', 'stage-2-strategy/finalize-workflow.lobster', 'Strategy handoff finalization after approval'],
  ['marketing_stage3_production_review', 'stage-3-production/review-workflow.lobster', 'Production stage execution and approval checkpoint'],
  ['marketing_stage3_production_finalize', 'stage-3-production/finalize-workflow.lobster', 'Production handoff finalization after approval'],
  ['marketing_stage4_publish_review', 'stage-4-publish-optimize/review-workflow.lobster', 'Publish preflight and launch approval checkpoint'],
  ['marketing_stage4_publish_finalize', 'stage-4-publish-optimize/publish-workflow.lobster', 'Publish/optimize execution with platform-aware controls'],
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
      <section className="pt-36 pb-24">
        <div className="container mx-auto px-6 space-y-10">
          <div className="max-w-4xl">
            <span className="inline-flex px-4 py-2 rounded-full border border-primary/20 bg-primary/10 text-primary text-xs uppercase tracking-[0.2em] font-semibold mb-6">
              Documentation
            </span>
            <h1 className="text-5xl md:text-6xl font-bold leading-tight mb-6">
              Getting Aries running locally without losing <span className="text-gradient">runtime truth</span>
            </h1>
            <p className="text-xl text-white/60">
              The goal of this runtime is clarity: stable page routes, stable internal APIs, and an execution boundary that never leaks browser concerns into OpenClaw or Lobster.
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-8">
            {SUMMARY_SECTIONS.map((section) => (
              <div key={section.title} className="glass rounded-[2rem] p-8">
                <h2 className="text-2xl font-bold mb-4">{section.title}</h2>
                <p className="text-white/55 leading-relaxed">{section.body}</p>
              </div>
            ))}
          </div>

          <div className="glass rounded-[2.5rem] p-8 md:p-10">
            <span className="inline-flex px-4 py-2 rounded-full border border-primary/20 bg-primary/10 text-primary text-xs uppercase tracking-[0.2em] font-semibold mb-5">
              Quick start
            </span>
            <h2 className="text-3xl md:text-4xl font-bold mb-5">Recommended local development flow</h2>
            <div className="rounded-[1.5rem] border border-white/10 bg-black/30 p-6 overflow-x-auto">
              <pre className="text-sm md:text-base text-white/75 whitespace-pre-wrap">{`NODE_ENV=development npm ci
cp .env.example .env
export DB_HOST=localhost DB_PORT=5432 DB_USER=aries_user DB_PASSWORD=aries_pass DB_NAME=aries_dev
export CODE_ROOT=/workspace DATA_ROOT=/tmp/aries-data NODE_ENV=development
export APP_BASE_URL=http://localhost:3000 NEXTAUTH_URL=http://localhost:3000 AUTH_URL=http://localhost:3000 AUTH_TRUST_HOST=true
npx next dev -p 3000 --turbopack`}</pre>
            </div>
            <p className="text-white/60 mt-5">
              Turbopack is required in this repo. The VM also injects environment variables at the OS level, so explicit overrides are part of a reliable local flow.
            </p>
          </div>

          <div className="glass rounded-[2.5rem] p-8 md:p-10">
            <span className="inline-flex px-4 py-2 rounded-full border border-primary/20 bg-primary/10 text-primary text-xs uppercase tracking-[0.2em] font-semibold mb-5">
              Execution catalog
            </span>
            <div className="overflow-x-auto">
              <table className="w-full border-separate border-spacing-y-3">
                <thead>
                  <tr className="text-left text-white/40 uppercase tracking-[0.2em] text-xs">
                    <th className="px-4">Workflow</th>
                    <th className="px-4">Pipeline</th>
                    <th className="px-4">Purpose</th>
                  </tr>
                </thead>
                <tbody>
                  {WORKFLOW_ROWS.map(([name, pipeline, purpose]) => (
                    <tr key={name} className="bg-white/5">
                      <td className="px-4 py-4 rounded-l-2xl font-semibold">{name}</td>
                      <td className="px-4 py-4 text-white/65"><code>{pipeline}</code></td>
                      <td className="px-4 py-4 rounded-r-2xl text-white/65">{purpose}</td>
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
