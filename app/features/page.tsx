import type { Metadata } from 'next';
import React from 'react';
import MarketingLayout from '../../frontend/marketing/MarketingLayout';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Features · Aries',
  description: 'Everything a small business needs to market with confidence.',
};

const FEATURES = [
  {
    icon: '◈',
    title: 'Campaign Planning',
    desc: 'Turn your business goals into a clear campaign plan with messaging, channels, and timing you can review in seconds.',
  },
  {
    icon: '◎',
    title: 'Creative Review',
    desc: 'See every draft before it goes live. Compare versions, request changes, and approve with confidence.',
  },
  {
    icon: '✦',
    title: 'Approval Safety',
    desc: 'Nothing publishes without sign-off. Material edits automatically return to review before scheduling continues.',
  },
  {
    icon: '◇',
    title: 'Launch Scheduling',
    desc: 'See exactly what is going out, when, and on which channels. Scheduling stays human-readable and approval-safe.',
  },
  {
    icon: '⇄',
    title: 'Results Clarity',
    desc: 'Business-readable reporting that answers one question: is this working? Every summary ends with a clear next step.',
  },
  {
    icon: '⟲',
    title: 'Channel Connections',
    desc: 'Connect Meta, Instagram, LinkedIn, Google Business, and more. Channel health stays visible so you know when something needs attention.',
  },
  {
    icon: '⬢',
    title: 'Home Dashboard',
    desc: 'One calm screen that shows what is running, what needs approval, what is scheduled next, and what to do now.',
  },
  {
    icon: '⌁',
    title: 'Review Queue',
    desc: 'A dedicated place for every decision that could affect a launch. Approve, request changes, or reject from one queue.',
  },
  {
    icon: '◷',
    title: 'Next-Step Recommendations',
    desc: 'Every campaign result ends with a recommended next action so you always know where to focus.',
  },
];

export default function FeaturesPage() {
  return (
    <MarketingLayout>
      <section className="pt-36 pb-20 relative">
        <div className="container mx-auto px-6">
          <div className="max-w-4xl mb-16">
            <span className="inline-flex px-4 py-2 rounded-full border border-primary/20 bg-primary/10 text-primary text-xs uppercase tracking-[0.2em] font-semibold mb-6">
              Product capabilities
            </span>
            <h1 className="text-5xl md:text-6xl font-bold leading-tight mb-6">
              Everything a small business needs to <span className="text-gradient">market with confidence</span>
            </h1>
            <p className="text-xl text-white/60">
              Aries keeps the complex work behind the scenes so you can focus on the decisions that matter: what to say, when to launch, and what to do next.
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
            <h2 className="text-4xl md:text-5xl font-bold mb-5">Ready to see how it works?</h2>
            <p className="text-white/60 text-lg mb-8 max-w-3xl mx-auto">
              Set up your business, review your first campaign plan, and approve what ships before anything goes live.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link href="/onboarding/start" className="px-8 py-4 rounded-full bg-gradient-to-r from-primary to-secondary text-white font-semibold shadow-xl shadow-primary/20">
                Start with your business
              </Link>
              <Link href="/login" className="px-8 py-4 rounded-full bg-white/5 border border-white/10 text-white font-semibold hover:bg-white/10 transition-all">
                Sign in
              </Link>
            </div>
          </div>
        </div>
      </section>
    </MarketingLayout>
  );
}
