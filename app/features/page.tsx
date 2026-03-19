import MarketingLayout from '../../frontend/marketing/MarketingLayout';
import Link from 'next/link';

const FEATURES = [
  {
    icon: '◈',
    title: 'Multi-Model Reasoning',
    desc: 'Chain multiple LLMs — Gemini, GPT, Claude — into sophisticated reasoning pipelines. Each model handles what it does best, orchestrated into a single coherent output.',
  },
  {
    icon: '◎',
    title: 'AI-Driven Research',
    desc: 'Automated competitor intelligence, market research, and trend analysis. Synthesized reports delivered on schedule through OpenClaw-backed automation runs.',
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
    <MarketingLayout>
      <section className="pt-36 pb-20 relative">
        <div className="container mx-auto px-6">
          <div className="max-w-4xl mb-16">
            <span className="inline-flex px-4 py-2 rounded-full border border-primary/20 bg-primary/10 text-primary text-xs uppercase tracking-[0.2em] font-semibold mb-6">
              Platform capabilities
            </span>
            <h1 className="text-5xl md:text-6xl font-bold leading-tight mb-6">
              Everything needed to run a premium <span className="text-gradient">marketing control plane</span>
            </h1>
            <p className="text-xl text-white/60">
              Aries combines AI reasoning, workflow orchestration, and multi-platform delivery into a single integrated system.
            </p>
          </div>

          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-8">
            {FEATURES.map((feature) => (
              <div key={feature.title} className="glass p-8 rounded-[2rem] border border-white/10">
                <div className="mb-6 p-4 bg-white/5 rounded-2xl w-fit text-2xl">{feature.icon}</div>
                <h2 className="text-2xl font-bold mb-4">{feature.title}</h2>
                <p className="text-white/55 leading-relaxed">{feature.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="pb-24">
        <div className="container mx-auto px-6">
          <div className="glass rounded-[3rem] p-10 md:p-14 text-center max-w-5xl mx-auto">
            <h2 className="text-4xl md:text-5xl font-bold mb-5">Ready to see the operator experience end-to-end?</h2>
            <p className="text-white/60 text-lg mb-8 max-w-3xl mx-auto">
              Review the runtime docs, connect a platform, and start the canonical brand campaign flow through Aries.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link href="/documentation" className="px-8 py-4 rounded-full bg-gradient-to-r from-primary to-secondary text-white font-semibold shadow-xl shadow-primary/20">
                Read the docs
              </Link>
              <Link href="/login" className="px-8 py-4 rounded-full bg-white/5 border border-white/10 text-white font-semibold hover:bg-white/10 transition-all">
                Open the console
              </Link>
            </div>
          </div>
        </div>
      </section>
    </MarketingLayout>
  );
}
