import MarketingLayout from '../frontend/marketing/MarketingLayout';
import { ButtonLink } from '@/components/redesign/primitives/button';
import { Card } from '@/components/redesign/primitives/card';
import LandingHeroOrbitSection from '@/components/redesign/marketing/landing-hero-orbit';

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
      <LandingHeroOrbitSection
        eyebrow="Marketing intelligence, orchestrated"
        title={
          <>
            Make every channel orbit around a <span className="rd-gradient-text">single Aries AI command layer</span>
          </>
        }
        description="Aries gives growth teams a polished surface for planning, generating, coordinating, and launching campaigns so strategy, creative, and distribution stay in one focused system."
        primaryAction={{ href: '/login', label: 'Launch operator console', id: 'cta-get-started' }}
        secondaryAction={{ href: '/features', label: 'Explore platform capabilities', id: 'cta-learn-more' }}
        badges={['Strategy', 'Creative', 'Distribution', 'Optimization']}
      />

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
