import MarketingLayout from '../frontend/marketing/MarketingLayout';
import { ButtonLink } from '@/components/redesign/primitives/button';
import { Card } from '@/components/redesign/primitives/card';

const HERO_METRICS = [
  { value: '7', label: 'supported channels' },
  { value: '1', label: 'internal API boundary' },
  { value: '24/7', label: 'workflow visibility' },
];

const FEATURES_PREVIEW = [
  {
    icon: '◈',
    title: 'AI-native campaign intelligence',
    desc: 'Research, strategy, production, approvals, and publish workflows in one control plane.',
  },
  {
    icon: '◎',
    title: 'Platform-aware delivery',
    desc: 'Operate Facebook, Instagram, LinkedIn, X, YouTube, Reddit, and TikTok from a shared API surface.',
  },
  {
    icon: '⇄',
    title: 'OpenClaw + Lobster boundary',
    desc: 'Keep browsers talking only to Aries while the runtime delegates execution through the gateway safely.',
  },
  {
    icon: '✦',
    title: 'Operational approvals',
    desc: 'Human-in-the-loop review, retries, sync controls, and route-safe status views for critical flows.',
  },
];

export default function HomePage() {
  return (
    <MarketingLayout currentPath="/">
      <section className="rd-hero">
        <div className="rd-container rd-hero__grid">
          <div>
            <p className="rd-hero__eyebrow">Autonomous marketing operations</p>
            <h1 className="rd-hero__title">
              Turn campaign execution into an <span className="rd-gradient-text">observable growth system</span>
            </h1>
            <p className="rd-hero__description">
              Aries gives teams a premium operator surface for running internal API workflows, approvals,
              platform connections, and publish controls without leaking OpenClaw or Lobster internals into the browser.
            </p>
            <div className="rd-hero__actions">
              <ButtonLink href="/login" id="cta-get-started">
                Launch operator console
              </ButtonLink>
              <ButtonLink href="/features" variant="secondary" id="cta-learn-more">
                Explore platform capabilities
              </ButtonLink>
            </div>
          </div>

          <Card>
            <div style={{ display: 'grid', gap: '1rem' }}>
              <div>
                <p className="rd-section-label">Execution boundary</p>
                <h2 style={{ margin: '1rem 0 0.75rem', fontFamily: 'var(--rd-font-display)', fontSize: '1.8rem' }}>
                  Browser → Aries API → OpenClaw Gateway → Lobster
                </h2>
                <p className="rd-section-description">
                  The browser stays inside Aries. Workflow execution stays server-side.
                </p>
              </div>

              <div className="rd-metric-grid">
                {HERO_METRICS.map((metric) => (
                  <div key={metric.label} className="rd-glass" style={{ padding: '1rem', borderRadius: '1rem' }}>
                    <strong style={{ display: 'block', fontSize: '1.8rem', fontFamily: 'var(--rd-font-display)' }}>
                      {metric.value}
                    </strong>
                    <span style={{ color: 'var(--rd-text-secondary)', fontSize: '0.9rem' }}>{metric.label}</span>
                  </div>
                ))}
              </div>

              <div className="rd-alert rd-alert--info">
                <div>
                  <strong style={{ display: 'block', marginBottom: '0.3rem' }}>Current runtime contract</strong>
                  <span>Stable internal routes, typed frontend clients, and workflow-aware status handling.</span>
                </div>
              </div>
            </div>
          </Card>
        </div>
      </section>

      <section className="rd-section">
        <div className="rd-container" style={{ display: 'grid', gap: '1.5rem' }}>
          <div style={{ display: 'grid', gap: '1rem', maxWidth: '48rem' }}>
            <span className="rd-section-label">Capabilities</span>
            <h2 className="rd-section-title">Built for teams that need control, not magic</h2>
            <p className="rd-section-description">
              From onboarding to multi-platform publishing, Aries keeps the UI semantic and operator-friendly while the backend
              remains responsible for orchestration details.
            </p>
          </div>

          <div className="rd-card-grid rd-card-grid--4">
            {FEATURES_PREVIEW.map((f) => (
              <Card key={f.title}>
                <div style={{ display: 'grid', gap: '1rem' }}>
                  <span className="rd-feature-icon">{f.icon}</span>
                  <h3 style={{ margin: 0, fontFamily: 'var(--rd-font-display)', fontSize: '1.25rem' }}>{f.title}</h3>
                  <p className="rd-section-description" style={{ fontSize: '0.98rem' }}>{f.desc}</p>
                </div>
              </Card>
            ))}
          </div>
        </div>
      </section>

      <section className="rd-section">
        <div className="rd-container">
          <Card>
            <div style={{ display: 'grid', gap: '1.25rem', textAlign: 'center', maxWidth: '52rem', margin: '0 auto' }}>
              <span className="rd-section-label" style={{ justifySelf: 'center' }}>Get started</span>
              <h2 className="rd-section-title">Operate campaigns with clearer contracts and a sharper interface</h2>
              <p className="rd-section-description">
                Start with the operator console, connect platforms through internal Aries routes, and keep campaign workflows visible end-to-end.
              </p>
              <div className="rd-hero__actions" style={{ justifyContent: 'center' }}>
                <ButtonLink href="/login" id="cta-contact">
                  Open the console
                </ButtonLink>
                <ButtonLink href="/documentation" variant="secondary" id="cta-docs">
                  Read deployment docs
                </ButtonLink>
              </div>
            </div>
          </Card>
        </div>
      </section>
    </MarketingLayout>
  );
}
