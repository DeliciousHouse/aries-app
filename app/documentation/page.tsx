import MarketingLayout from '../../frontend/marketing/MarketingLayout';

export default function DocumentationPage() {
  return (
    <MarketingLayout currentPath="/documentation">
      <section className="section page-docs">
        <div className="container">
          <div className="section-header">
            <span className="section-label">Documentation</span>
            <h1 className="section-title">Getting Started with Aries</h1>
            <p className="section-desc">
              Everything you need to deploy, configure, and operate the Aries platform.
            </p>
          </div>

          <div className="doc-grid">
            <aside className="doc-sidebar">
              <nav>
                <ul className="doc-nav">
                  <li><a href="#overview" className="doc-nav-link active">Overview</a></li>
                  <li><a href="#quickstart" className="doc-nav-link">Quick Start</a></li>
                  <li><a href="#architecture" className="doc-nav-link">Architecture</a></li>
                  <li><a href="#n8n-workflows" className="doc-nav-link">n8n Workflows</a></li>
                  <li><a href="#integrations" className="doc-nav-link">Integrations</a></li>
                  <li><a href="#security" className="doc-nav-link">Security</a></li>
                </ul>
              </nav>
            </aside>

            <div className="doc-content">
              <h2 id="overview">Overview</h2>
              <p>
                Aries AI is a multi-tenant platform that orchestrates AI-powered content pipelines across 7 social platforms.
                Built on Next.js 15 and n8n, it provides end-to-end automation from research and strategy
                through production, approval, and publishing.
              </p>
              <p>
                The system uses a workflow-first architecture: every operation — from onboarding a new tenant to
                publishing a scheduled post — is modeled as an n8n workflow with built-in repair, retry, and observability.
              </p>

              <h2 id="quickstart">Quick Start</h2>
              <h3>Prerequisites</h3>
              <ul>
                <li>Node.js 18+ and npm</li>
                <li>A running n8n instance with API access</li>
                <li>Platform OAuth credentials (Meta, LinkedIn, X, etc.)</li>
              </ul>

              <h3>Environment Setup</h3>
              <div className="code-block">
                <code>{`# Clone and install
git clone <repo-url> && cd aries-app
npm install

# Configure environment
cp .env.example .env
# Edit .env with your N8N_BASE_URL and N8N_API_KEY

# Start development server
npm run dev`}</code>
              </div>

              <h3>First Steps</h3>
              <ol>
                <li>Verify your n8n connection by checking the dashboard</li>
                <li>Connect at least one platform via Settings → Platforms</li>
                <li>Create your first marketing job from the Posts page</li>
                <li>Monitor progress in the Dashboard</li>
              </ol>

              <h2 id="architecture">Architecture</h2>
              <p>
                Aries follows a layered architecture with clear boundaries:
              </p>
              <ul>
                <li><strong>Frontend Layer</strong> — React components, app-shell layout, marketing pages</li>
                <li><strong>API Layer</strong> — Next.js route handlers that proxy to n8n workflows</li>
                <li><strong>Backend Services</strong> — Business logic for auth, integrations, marketing, and publishing</li>
                <li><strong>n8n Workflows</strong> — Orchestration engine for all async operations</li>
              </ul>
              <p>
                All frontend-to-backend communication goes through internal <code>/api/*</code> routes.
                The API layer proxies to n8n webhooks server-side, keeping credentials secure.
              </p>

              <h2 id="n8n-workflows">n8n Workflows</h2>
              <p>The following workflows are deployed and active:</p>
              <div className="glass-card-static" style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                      <th style={{ textAlign: 'left', padding: '8px 12px', color: 'rgba(248,245,242,0.5)' }}>Workflow</th>
                      <th style={{ textAlign: 'left', padding: '8px 12px', color: 'rgba(248,245,242,0.5)' }}>Webhook Path</th>
                      <th style={{ textAlign: 'left', padding: '8px 12px', color: 'rgba(248,245,242,0.5)' }}>Purpose</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      ['tenant-provisioning', '/webhook/tenant-provisioning', 'New tenant onboarding & validation'],
                      ['tenant-repair', '/webhook/tenant-repair', 'Fix broken tenant state'],
                      ['marketing-research', '/webhook/marketing-research', 'AI-driven market research'],
                      ['marketing-strategy', '/webhook/marketing-strategy', 'Content strategy generation'],
                      ['marketing-production', '/webhook/marketing-production', 'Content asset production'],
                      ['marketing-publish', '/webhook/marketing-publish', 'Cross-platform publishing'],
                      ['marketing-approval-resume', '/webhook/marketing-approval-resume', 'Resume after human approval'],
                      ['marketing-repair', '/webhook/marketing-repair', 'Auto-repair failed marketing jobs'],
                      ['publish-dispatch', '/webhook/aries/publish', 'Normalized publish event dispatch'],
                      ['connection-events', '/webhook/aries/connection-events', 'Platform connection lifecycle'],
                    ].map(([name, path, purpose]) => (
                      <tr key={name} style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                        <td style={{ padding: '8px 12px', fontWeight: 600 }}>{name}</td>
                        <td style={{ padding: '8px 12px' }}><code>{path}</code></td>
                        <td style={{ padding: '8px 12px', color: 'rgba(248,245,242,0.65)' }}>{purpose}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <h2 id="integrations">Integrations</h2>
              <p>Aries supports 7 social platforms via a unified OAuth broker:</p>
              <ul>
                <li><strong>Facebook</strong> — Page publishing via Meta Graph API</li>
                <li><strong>Instagram</strong> — Business account content publishing</li>
                <li><strong>LinkedIn</strong> — Company page and member social posting</li>
                <li><strong>X (Twitter)</strong> — Post scheduling and analytics</li>
                <li><strong>YouTube</strong> — Channel publishing workflows</li>
                <li><strong>Reddit</strong> — Community publishing automation</li>
                <li><strong>TikTok</strong> — Business video publishing</li>
              </ul>
              <p>
                Each platform adapter handles token refresh, permission validation, and content format adaptation.
                Connection health is monitored continuously and surfaced in the dashboard.
              </p>

              <h2 id="security">Security</h2>
              <p>Aries implements defense-in-depth security:</p>
              <ul>
                <li>Multi-tenant isolation with strict boundary enforcement</li>
                <li>Role-based access control (tenant_admin, tenant_analyst, tenant_viewer)</li>
                <li>Encrypted credential storage with rotation support</li>
                <li>Session hardening: secure cookies, CSRF protection, idle timeouts</li>
                <li>All n8n API keys stay server-side — never exposed to browser code</li>
              </ul>
            </div>
          </div>
        </div>
      </section>
    </MarketingLayout>
  );
}
