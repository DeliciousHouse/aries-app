import MarketingLayout from '../../frontend/marketing/MarketingLayout';
import { Card } from '@/components/redesign/primitives/card';

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
    <MarketingLayout currentPath="/documentation">
      <section className="rd-section">
        <div className="rd-container" style={{ display: 'grid', gap: '1.5rem' }}>
          <div style={{ display: 'grid', gap: '1rem', maxWidth: '52rem' }}>
            <span className="rd-section-label">Documentation</span>
            <h1 className="rd-section-title">Getting Aries running locally without losing runtime truth</h1>
            <p className="rd-section-description">
              The goal of this runtime is clarity: stable page routes, stable internal APIs, and a workflow boundary that never leaks browser concerns into OpenClaw or Lobster.
            </p>
          </div>

          <div className="rd-card-grid rd-card-grid--3">
            {SUMMARY_SECTIONS.map((section) => (
              <Card key={section.title}>
                <div style={{ display: 'grid', gap: '0.9rem' }}>
                  <h2 style={{ margin: 0, fontFamily: 'var(--rd-font-display)', fontSize: '1.3rem' }}>{section.title}</h2>
                  <p className="rd-section-description" style={{ fontSize: '0.98rem' }}>{section.body}</p>
                </div>
              </Card>
            ))}
          </div>

          <Card>
            <div style={{ display: 'grid', gap: '1rem' }}>
              <span className="rd-section-label">Quick start</span>
              <h2 style={{ margin: 0, fontFamily: 'var(--rd-font-display)', fontSize: '2rem' }}>Recommended local development flow</h2>
              <div className="rd-json-panel">
                <code>{`NODE_ENV=development npm ci
cp .env.example .env
export DB_HOST=localhost DB_PORT=5432 DB_USER=aries_user DB_PASSWORD=aries_pass DB_NAME=aries_dev
export CODE_ROOT=/workspace DATA_ROOT=/tmp/aries-data NODE_ENV=development
export APP_BASE_URL=http://localhost:3000 NEXTAUTH_URL=http://localhost:3000 AUTH_URL=http://localhost:3000 AUTH_TRUST_HOST=true
npx next dev -p 3000 --turbopack`}</code>
              </div>
              <p className="rd-section-description">
                Turbopack is required in this repo. The VM also injects environment variables at the OS level, so explicit overrides are part of a reliable local flow.
              </p>
            </div>
          </Card>

          <Card>
            <div style={{ display: 'grid', gap: '1rem' }}>
              <span className="rd-section-label">Workflow catalog</span>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--rd-border)' }}>
                      <th style={{ textAlign: 'left', padding: '0.75rem', color: 'var(--rd-text-muted)' }}>Workflow</th>
                      <th style={{ textAlign: 'left', padding: '0.75rem', color: 'var(--rd-text-muted)' }}>Pipeline</th>
                      <th style={{ textAlign: 'left', padding: '0.75rem', color: 'var(--rd-text-muted)' }}>Purpose</th>
                    </tr>
                  </thead>
                  <tbody>
                    {WORKFLOW_ROWS.map(([name, pipeline, purpose]) => (
                      <tr key={name} style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                        <td style={{ padding: '0.75rem', fontWeight: 700 }}>{name}</td>
                        <td style={{ padding: '0.75rem', color: 'var(--rd-text-secondary)' }}><code>{pipeline}</code></td>
                        <td style={{ padding: '0.75rem', color: 'var(--rd-text-secondary)' }}>{purpose}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </Card>
        </div>
      </section>
    </MarketingLayout>
  );
}
