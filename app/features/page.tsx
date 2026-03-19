import React from 'react';
import MarketingLayout from '../../frontend/marketing/MarketingLayout';
import Link from 'next/link';

const FEATURES = [
  {
    icon: '◈',
    title: 'Direct Route Boundary',
    desc: 'Browsers talk to Aries page routes and internal APIs only. Request validation, auth, and payload shaping stay inside the app boundary.',
  },
  {
    icon: '◎',
    title: 'OpenClaw Execution Handoff',
    desc: 'Execution leaves the UI boundary through OpenClaw instead of leaking workflow internals or provider secrets into the browser.',
  },
  {
    icon: '✦',
    title: 'Canonical Marketing Intake',
    desc: 'The operator flow starts one canonical `brand_campaign` job with required brand and competitor inputs.',
  },
  {
    icon: '◇',
    title: 'Runtime Read Models',
    desc: 'Onboarding status and marketing job state are exposed through browser-safe read models backed by runtime files and database state.',
  },
  {
    icon: '⇄',
    title: 'Approval Resume Controls',
    desc: 'Human approval gates are represented explicitly so operators can inspect status and resume approved work from the app shell.',
  },
  {
    icon: '⟲',
    title: 'OAuth Broker Surface',
    desc: 'Platform connection state, reconnect flows, and token health stay centralized behind the Aries integrations APIs.',
  },
  {
    icon: '⬢',
    title: 'Operator Shell',
    desc: 'Dashboard, platforms, posts, calendar, and settings live behind a shared authenticated shell built for tenant-aware operations.',
  },
  {
    icon: '⌁',
    title: 'Typed Internal APIs',
    desc: 'The UI contract is documented through route handlers and typed client calls instead of ad hoc browser-to-workflow integrations.',
  },
  {
    icon: '◷',
    title: 'Route Verification',
    desc: 'Public-route smoke checks, banned-pattern checks, marketing-flow tests, and homepage performance audits keep the documented surface honest.',
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
              The current Aries runtime is a <span className="text-gradient">direct operator surface</span>
            </h1>
            <p className="text-xl text-white/60">
              Public docs, authenticated operator routes, runtime read models, and OpenClaw execution handoff are the supported architecture in this repo today.
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
            <h2 className="text-4xl md:text-5xl font-bold mb-5">Ready to verify the runtime end to end?</h2>
            <p className="text-white/60 text-lg mb-8 max-w-3xl mx-auto">
              Use the docs for setup, run the validation commands, and launch the canonical marketing flow from the operator shell.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link href="/documentation" className="px-8 py-4 rounded-full bg-gradient-to-r from-primary to-secondary text-white font-semibold shadow-xl shadow-primary/20">
                Read the docs
              </Link>
              <Link href="/api-docs" className="px-8 py-4 rounded-full bg-white/5 border border-white/10 text-white font-semibold hover:bg-white/10 transition-all">
                Review the APIs
              </Link>
            </div>
          </div>
        </div>
      </section>
    </MarketingLayout>
  );
}
