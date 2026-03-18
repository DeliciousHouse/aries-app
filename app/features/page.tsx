import MarketingLayout from '../../frontend/marketing/MarketingLayout';
import { ButtonLink } from '@/components/redesign/primitives/button';
import { Card } from '@/components/redesign/primitives/card';

const FEATURES = [
  {
    icon: '◈',
    title: 'Multi-Model Reasoning',
    desc: 'Chain multiple LLMs — Gemini, GPT, Claude — into sophisticated reasoning pipelines. Each model handles what it does best, orchestrated into a single coherent output.',
  },
  {
    icon: '◎',
    title: 'AI-Driven Research',
    desc: 'Automated competitor intelligence, market research, and trend analysis. Synthesized reports delivered on schedule via repo-managed workflows.',
  },
  {
    icon: '✦',
    title: 'Content Strategy Engine',
    desc: 'Generate data-driven content strategies aligned with your brand voice, audience segments, and performance history.',
  },
  {
    icon: '◇',
    title: 'Production Pipeline',
    desc: 'Full content production from brief to publish-ready assets. Copy, imagery, video — all generated and refined through approval gates.',
  },
  {
    icon: '⇄',
    title: 'Multi-Platform Publishing',
    desc: 'Unified dispatch to 7 platforms: Facebook, Instagram, LinkedIn, X, YouTube, Reddit, and TikTok. Format-aware adaptation per channel.',
  },
  {
    icon: '⟲',
    title: 'Lobster + OpenClaw Orchestration',
    desc: 'Production-grade workflow engine with automatic error repair, retry scheduling, idempotent processing, and approval resumption.',
  },
  {
    icon: '⬢',
    title: 'Enterprise Security',
    desc: 'Multi-tenant RBAC, encrypted credential storage, session hardening with CSRF/XSS protection, and audit-ready access controls.',
  },
  {
    icon: '⌁',
    title: 'OAuth Broker',
    desc: 'Centralized OAuth2 connection management across all platforms. Automatic token refresh, health monitoring, and reconnection flows.',
  },
  {
    icon: '◷',
    title: 'Calendar & Scheduling',
    desc: 'Visual scheduling with publish windows, sync controls, and cross-platform coordination. Never miss a distribution window.',
  },
  {
    icon: '⚑',
    title: 'Self-Healing Workflows',
    desc: 'Bounded repair loops detect, diagnose, and fix failures automatically. Escalation paths and failure-class tracking built in.',
  },
  {
    icon: '↗',
    title: 'Operations Dashboard',
    desc: 'Real-time visibility into queue health, publish velocity, token expiry, and platform connection status across all tenants.',
  },
  {
    icon: '◌',
    title: 'Sandbox Environment',
    desc: 'Full-fidelity sandbox provisioning for testing workflows end-to-end before production deployment. Isolated tenant simulation.',
  },
];

export default function FeaturesPage() {
  return (
    <MarketingLayout currentPath="/features">
      <section className="rd-section">
        <div className="rd-container" style={{ display: 'grid', gap: '1.5rem' }}>
          <div style={{ display: 'grid', gap: '1rem', maxWidth: '50rem' }}>
            <span className="rd-section-label">Platform capabilities</span>
            <h1 className="rd-section-title">Everything needed to run a premium marketing control plane</h1>
            <p className="rd-section-description">
              Aries combines AI reasoning, workflow orchestration, and multi-platform delivery into a single integrated system.
            </p>
          </div>

          <div className="rd-card-grid rd-card-grid--3">
            {FEATURES.map((f) => (
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
            <div style={{ display: 'grid', gap: '1rem', textAlign: 'center', maxWidth: '48rem', margin: '0 auto' }}>
              <h2 className="rd-section-title">Ready to see the operator experience end-to-end?</h2>
              <p className="rd-section-description">
                Review the runtime docs, connect a platform, and start the canonical brand campaign flow through Aries.
              </p>
              <div className="rd-hero__actions" style={{ justifyContent: 'center' }}>
                <ButtonLink href="/documentation">Read the docs</ButtonLink>
                <ButtonLink href="/login" variant="secondary">Open the console</ButtonLink>
              </div>
            </div>
          </Card>
        </div>
      </section>
    </MarketingLayout>
  );
}
