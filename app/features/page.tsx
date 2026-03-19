import React from 'react';

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
    <MarketingLayout>
      <section className="public-page-section">
        <div className="container">
          <div className="mb-14 max-w-4xl">
            <span className="eyebrow mb-6">
              Platform capabilities
            </span>
            <h1 className="public-heading-lg mb-6 max-w-4xl">
              Everything needed to run a premium <span className="text-gradient">marketing control plane</span>
            </h1>
            <p className="public-subcopy">
              Aries combines AI reasoning, workflow orchestration, and multi-platform delivery into a single integrated system.
            </p>
          </div>

          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            {FEATURES.map((feature) => (
              <article key={feature.title} className="glass rounded-[1.8rem] border border-white/10 p-6 md:p-8">
                <div className="mb-5 w-fit rounded-2xl bg-white/6 p-4 text-2xl">{feature.icon}</div>
                <h2 className="mb-4 font-display text-2xl font-semibold text-white">{feature.title}</h2>
                <p className="text-sm leading-7 text-white/68 md:text-base">{feature.desc}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="pb-18 md:pb-24">
        <div className="container">
          <div className="glass mx-auto max-w-5xl rounded-[2.3rem] p-7 text-center md:p-12">
            <h2 className="public-heading-lg mb-5">Ready to see the operator experience end-to-end?</h2>
            <p className="mx-auto mb-8 max-w-3xl text-base leading-8 text-white/70 md:text-lg">
              Review the runtime docs, connect a platform, and start the canonical brand campaign flow through Aries.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link href="/documentation" className="inline-flex min-h-13 items-center justify-center rounded-full bg-gradient-to-r from-primary to-secondary px-7 py-3.5 text-base font-semibold text-white shadow-xl shadow-primary/20">
                Read the docs
              </Link>
              <Link href="/login" className="inline-flex min-h-13 items-center justify-center rounded-full border border-white/10 bg-white/5 px-7 py-3.5 text-base font-semibold text-white transition-all hover:bg-white/10">
                Open the console
              </Link>
            </div>
          </div>
        </div>
      </section>
    </MarketingLayout>
  );
}
