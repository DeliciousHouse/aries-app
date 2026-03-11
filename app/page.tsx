import MarketingLayout from '../frontend/marketing/MarketingLayout';

const FEATURES_PREVIEW = [
  { icon: '🧠', title: 'LLM-Powered Intelligence', desc: 'Multi-model reasoning chains for research, strategy, and content production.' },
  { icon: '📡', title: 'Multi-Platform Publishing', desc: 'Unified dispatch to Facebook, Instagram, LinkedIn, X, YouTube, Reddit, and TikTok.' },
  { icon: '🔄', title: 'n8n Workflow Engine', desc: 'Production-grade orchestration with automatic repair, retry, and approval flows.' },
  { icon: '🛡️', title: 'Enterprise Security', desc: 'Tenant isolation, RBAC, secure token storage, and session hardening.' },
];

export default function HomePage() {
  return (
    <MarketingLayout currentPath="/">
      {/* Hero */}
      <section className="hero">
        <img
          src="/aries-logo.png"
          alt="Aries AI"
          className="hero-logo"
          width={180}
          height={180}
        />
        <span className="hero-brand">Aries AI</span>
        <h1 className="hero-title">Next-Generation LLM-Powered Agent</h1>
        <p className="hero-subtitle">
          Sophisticated reasoning and seamless integrations for your most demanding tasks.
        </p>
        <div className="hero-actions">
          <a href="/dashboard" className="btn btn-primary btn-lg" id="cta-get-started">
            Get Started
          </a>
          <a href="/features" className="btn btn-secondary btn-lg" id="cta-learn-more">
            Explore Features
          </a>
        </div>
      </section>

      {/* Features Preview */}
      <section className="section">
        <div className="container">
          <div className="section-header">
            <span className="section-label">Capabilities</span>
            <h2 className="section-title">Built for Serious Work</h2>
            <p className="section-desc">
              From research to publishing, Aries orchestrates every stage of your content pipeline with precision.
            </p>
          </div>
          <div className="grid-4">
            {FEATURES_PREVIEW.map((f) => (
              <div className="glass-card" key={f.title}>
                <div className="feature-icon">{f.icon}</div>
                <h3 className="feature-title">{f.title}</h3>
                <p className="feature-desc">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="section">
        <div className="container" style={{ textAlign: 'center' }}>
          <div className="section-header">
            <span className="section-label">Get Started</span>
            <h2 className="section-title">Ready to Transform Your Workflow?</h2>
            <p className="section-desc">
              Deploy Aries in minutes. Connect your platforms, configure your pipelines, and let the agent handle the rest.
            </p>
          </div>
          <div className="hero-actions">
            <a href="/contact" className="btn btn-primary btn-lg" id="cta-contact">
              Contact Us
            </a>
            <a href="/documentation" className="btn btn-secondary btn-lg" id="cta-docs">
              Read the Docs
            </a>
          </div>
        </div>
      </section>
    </MarketingLayout>
  );
}
