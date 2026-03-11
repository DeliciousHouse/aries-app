import MarketingLayout from '../../frontend/marketing/MarketingLayout';

const FEATURES = [
  {
    icon: '🧠',
    title: 'Multi-Model Reasoning',
    desc: 'Chain multiple LLMs — Gemini, GPT, Claude — into sophisticated reasoning pipelines. Each model handles what it does best, orchestrated into a single coherent output.',
  },
  {
    icon: '📊',
    title: 'AI-Driven Research',
    desc: 'Automated competitor intelligence, market research, and trend analysis. Synthesized reports delivered on schedule via n8n workflows.',
  },
  {
    icon: '✍️',
    title: 'Content Strategy Engine',
    desc: 'Generate data-driven content strategies aligned with your brand voice, audience segments, and performance history.',
  },
  {
    icon: '🎬',
    title: 'Production Pipeline',
    desc: 'Full content production from brief to publish-ready assets. Copy, imagery, video — all generated and refined through approval gates.',
  },
  {
    icon: '📡',
    title: 'Multi-Platform Publishing',
    desc: 'Unified dispatch to 7 platforms: Facebook, Instagram, LinkedIn, X, YouTube, Reddit, and TikTok. Format-aware adaptation per channel.',
  },
  {
    icon: '🔄',
    title: 'n8n Orchestration',
    desc: 'Production-grade workflow engine with automatic error repair, retry scheduling, idempotent processing, and approval resumption.',
  },
  {
    icon: '🛡️',
    title: 'Enterprise Security',
    desc: 'Multi-tenant RBAC, encrypted credential storage, session hardening with CSRF/XSS protection, and audit-ready access controls.',
  },
  {
    icon: '🔌',
    title: 'OAuth Broker',
    desc: 'Centralized OAuth2 connection management across all platforms. Automatic token refresh, health monitoring, and reconnection flows.',
  },
  {
    icon: '📅',
    title: 'Calendar & Scheduling',
    desc: 'Visual scheduling with publish windows, sync controls, and cross-platform coordination. Never miss a distribution window.',
  },
  {
    icon: '🔧',
    title: 'Self-Healing Workflows',
    desc: 'Bounded repair loops detect, diagnose, and fix failures automatically. Escalation paths and failure-class tracking built in.',
  },
  {
    icon: '📈',
    title: 'Operations Dashboard',
    desc: 'Real-time visibility into queue health, publish velocity, token expiry, and platform connection status across all tenants.',
  },
  {
    icon: '🧪',
    title: 'Sandbox Environment',
    desc: 'Full-fidelity sandbox provisioning for testing workflows end-to-end before production deployment. Isolated tenant simulation.',
  },
];

export default function FeaturesPage() {
  return (
    <MarketingLayout currentPath="/features">
      <section className="section page-features">
        <div className="container">
          <div className="section-header">
            <span className="section-label">Platform Capabilities</span>
            <h1 className="section-title">Everything You Need to Ship at Scale</h1>
            <p className="section-desc">
              Aries combines AI reasoning, workflow orchestration, and multi-platform delivery into a single integrated system.
            </p>
          </div>
          <div className="grid-3">
            {FEATURES.map((f) => (
              <div className="glass-card" key={f.title}>
                <div className="feature-icon">{f.icon}</div>
                <h3 className="feature-title">{f.title}</h3>
                <p className="feature-desc">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container" style={{ textAlign: 'center' }}>
          <h2 className="section-title">Ready to See It in Action?</h2>
          <p className="section-desc" style={{ marginBottom: '2rem' }}>
            Get hands-on with Aries and experience the full pipeline.
          </p>
          <a href="/contact" className="btn btn-primary btn-lg">Get in Touch</a>
        </div>
      </section>
    </MarketingLayout>
  );
}
