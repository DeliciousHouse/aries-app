"use client";

import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  BookOpen,
  Terminal,
  Layout,
  GitBranch,
  Plug,
  ShieldCheck,
  Book,
} from 'lucide-react';

const sections = [
  { id: 'overview', title: 'Overview', icon: BookOpen },
  { id: 'quick-start', title: 'Getting Started', icon: Terminal },
  { id: 'architecture', title: 'How It Works', icon: Layout },
  { id: 'campaigns', title: 'Campaigns', icon: GitBranch },
  { id: 'integrations', title: 'Integrations', icon: Plug },
  { id: 'security', title: 'Security', icon: ShieldCheck },
];

export default function Docs() {
  const [activeSection, setActiveSection] = useState('overview');
  const sectionRefs = useRef<{ [key: string]: HTMLElement | null }>({});

  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    const handleScroll = () => {
      const scrollPosition = window.scrollY + 100;

      for (const section of sections) {
        const ref = sectionRefs.current[section.id];
        if (ref && scrollPosition >= ref.offsetTop && scrollPosition < ref.offsetTop + ref.offsetHeight) {
          setActiveSection(section.id);
          break;
        }
      }
    };

    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const scrollToSection = (id: string) => {
    const ref = sectionRefs.current[id];
    if (ref) {
      window.scrollTo({
        top: ref.offsetTop - 80,
        behavior: 'smooth',
      });
    }
  };

  return (
    <div className="min-h-screen bg-[#050505] text-white selection:bg-primary/30">
      <main className="relative z-10 pt-32 pb-20">
        <div className="container mx-auto px-6 max-w-7xl">
          {/* Header */}
          <div className="text-center mb-16">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-primary/10 border border-primary/20 text-primary mb-6"
            >
              <Book className="w-4 h-4" />
              <span className="text-xs font-bold uppercase tracking-widest font-display">Documentation</span>
            </motion.div>

            <motion.h1
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="text-[48px] font-semibold mb-6 tracking-tight leading-tight"
            >
              Getting Started with <span className="text-gradient">Aries</span>
            </motion.h1>

            <motion.p
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
              className="text-lg md:text-xl text-white/60 max-w-3xl mx-auto font-sans"
            >
              Everything you need to get started, run campaigns, and get results with Aries.
            </motion.p>
          </div>

          <div className="flex flex-col lg:flex-row gap-12 relative">
            {/* Sidebar */}
            <aside className="lg:w-64 flex-shrink-0">
              <div className="lg:sticky lg:top-24 space-y-2">
                <nav className="flex lg:flex-col overflow-x-auto lg:overflow-visible pb-4 lg:pb-0 gap-2 scrollbar-hide">
                  {sections.map((section) => {
                    const Icon = section.icon;
                    return (
                      <button
                        key={section.id}
                        onClick={() => scrollToSection(section.id)}
                        className={cn(
                          "flex items-center gap-3 px-4 py-3 rounded-xl transition-all text-left whitespace-nowrap lg:whitespace-normal group",
                          activeSection === section.id
                            ? "bg-white/10 border border-white/10 text-white shadow-xl shadow-black/20"
                            : "text-white/50 hover:text-white hover:bg-white/5 border border-transparent"
                        )}
                      >
                        <div className={cn(
                          "w-8 h-8 rounded-lg flex items-center justify-center transition-colors",
                          activeSection === section.id ? "bg-primary/20 text-primary" : "bg-white/5 text-white/40 group-hover:text-white/60"
                        )}>
                          <Icon className="w-4 h-4" />
                        </div>
                        <span className="font-semibold text-sm tracking-wide">
                          {section.title}
                        </span>
                        {activeSection === section.id && (
                          <motion.div
                            layoutId="active-indicator"
                            className="hidden lg:block ml-auto w-1 h-4 bg-primary rounded-full"
                          />
                        )}
                      </button>
                    );
                  })}
                </nav>
              </div>
            </aside>

            {/* Content Area */}
            <div className="flex-grow max-w-4xl space-y-24">
              {/* Overview Section */}
              <section
                id="overview"
                ref={(el) => { sectionRefs.current['overview'] = el; }}
                className="scroll-mt-24"
              >
                <div className="flex items-center gap-4 mb-8">
                  <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-primary/20 to-secondary/20 flex items-center justify-center border border-white/10">
                    <BookOpen className="w-6 h-6 text-primary" />
                  </div>
                  <h2 className="text-3xl font-bold tracking-tight">Overview</h2>
                </div>

                <div className="prose prose-invert prose-p:text-white/70 prose-p:leading-relaxed prose-p:text-lg max-w-none">
                  <p>
                    Aries AI is a marketing operating system for small businesses. It helps business owners plan campaigns, review creative, approve launches, and see what worked from one calm workspace.
                  </p>
                  <p className="mt-6">
                    The system is built around a clear product loop: set up your business, review the plan, approve the creative, schedule the launch, and see the results. Every step stays approval-safe and human-readable.
                  </p>
                </div>
              </section>

              {/* Quick Start Section */}
              <section
                id="quick-start"
                ref={(el) => { sectionRefs.current['quick-start'] = el; }}
                className="scroll-mt-24 pt-12 border-t border-white/5"
              >
                <div className="flex items-center gap-4 mb-8">
                  <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-primary/20 to-secondary/20 flex items-center justify-center border border-white/10">
                    <Terminal className="w-6 h-6 text-primary" />
                  </div>
                  <h2 className="text-3xl font-bold tracking-tight">Getting Started</h2>
                </div>

                <div className="prose prose-invert prose-p:text-white/70 prose-p:leading-relaxed prose-p:text-lg max-w-none space-y-6">
                  <p>
                    <strong className="text-white">Create your first campaign from the dashboard.</strong> Once you're signed in, head to the Campaigns section and click "New Campaign." You'll be guided through naming it, describing your offer, and setting your goal. Aries uses this context to prepare a full strategy and creative plan for your review.
                  </p>
                  <p>
                    <strong className="text-white">Connect your Meta and Instagram accounts.</strong> Go to Settings and open the Integrations tab. From there you can connect your Facebook Page and Instagram Business account. Aries will show the connection status before any campaign is published, so you always know what's live and what isn't.
                  </p>
                  <p>
                    <strong className="text-white">Review and approve creative before anything goes live.</strong> Every campaign passes through a review step before it publishes. You'll see the generated copy, images, and channel-specific assets in a single approval view. Nothing is dispatched until you explicitly approve it.
                  </p>
                  <p>
                    <strong className="text-white">Monitor performance in the results dashboard.</strong> After a campaign launches, results appear in the Results section of your workspace. You can see reach, engagement, and spend at a glance — no marketing software experience required.
                  </p>
                </div>
              </section>

              {/* Architecture Section */}
              <section
                id="architecture"
                ref={(el) => { sectionRefs.current['architecture'] = el; }}
                className="scroll-mt-24 pt-12 border-t border-white/5"
              >
                <div className="flex items-center gap-4 mb-8">
                  <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-primary/20 to-secondary/20 flex items-center justify-center border border-white/10">
                    <Layout className="w-6 h-6 text-primary" />
                  </div>
                  <h2 className="text-3xl font-bold tracking-tight">How It Works</h2>
                </div>

                <div className="prose prose-invert prose-p:text-white/70 prose-p:leading-relaxed prose-p:text-lg max-w-none">
                  <p>
                    Aries follows a four-stage workflow designed around human approval at every step: Research, Strategy, Creative, and Publish.
                  </p>
                  <p className="mt-4">
                    In the <strong className="text-white">Research</strong> stage, Aries reviews your business profile and any website content you've connected to understand your offer, audience, and goals. In the <strong className="text-white">Strategy</strong> stage, it produces a campaign plan — positioning, channel selection, and messaging direction — which you review before anything moves forward. The <strong className="text-white">Creative</strong> stage generates copy and visual assets for each channel. Finally, in the <strong className="text-white">Publish</strong> stage, approved content is dispatched to your connected channels on the schedule you've set. You stay in control at every handoff.
                  </p>
                </div>
              </section>

              {/* Campaigns Section */}
              <section
                id="campaigns"
                ref={(el) => { sectionRefs.current['campaigns'] = el; }}
                className="scroll-mt-24 pt-12 border-t border-white/5"
              >
                <div className="flex items-center gap-4 mb-8">
                  <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-primary/20 to-secondary/20 flex items-center justify-center border border-white/10">
                    <GitBranch className="w-6 h-6 text-primary" />
                  </div>
                  <h2 className="text-3xl font-bold tracking-tight">Campaigns</h2>
                </div>

                <div className="prose prose-invert prose-p:text-white/70 prose-p:leading-relaxed prose-p:text-lg max-w-none">
                  <p>
                    Campaigns begin from the business profile and attached website source. Aries uses that context to prepare strategy, creative direction, review checkpoints, and launch-ready assets.
                  </p>
                  <p className="mt-4">
                    Every campaign keeps approval visible. Strategy, production, and publishing steps can require human approval before the workflow moves forward.
                  </p>
                </div>

                <div className="mt-8 grid gap-4 md:grid-cols-3">
                  {[
                    ['Strategy', 'Review the offer, audience, positioning, and campaign plan before production begins.'],
                    ['Creative', 'Inspect generated copy, visuals, and channel-specific assets before anything goes live.'],
                    ['Launch', 'Approve publishing only after the campaign is aligned with the business source and goal.'],
                  ].map(([title, description]) => (
                    <div key={title} className="rounded-2xl border border-white/10 bg-white/[0.04] p-5">
                      <h3 className="font-bold text-white">{title}</h3>
                      <p className="mt-3 text-sm leading-7 text-white/60">{description}</p>
                    </div>
                  ))}
                </div>
              </section>

              {/* Integrations Section */}
              <section
                id="integrations"
                ref={(el) => { sectionRefs.current['integrations'] = el; }}
                className="scroll-mt-24 pt-12 border-t border-white/5"
              >
                <div className="flex items-center gap-4 mb-8">
                  <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-primary/20 to-secondary/20 flex items-center justify-center border border-white/10">
                    <Plug className="w-6 h-6 text-primary" />
                  </div>
                  <h2 className="text-3xl font-bold tracking-tight">Integrations</h2>
                </div>

                <div className="prose prose-invert prose-p:text-white/70 prose-p:leading-relaxed prose-p:text-lg max-w-none">
                  <p>
                    Aries connects to the channels where your audience lives. You authorize each connection from the Settings page, and Aries handles the rest securely on your behalf.
                  </p>
                  <p className="mt-4">
                    Integration status is always visible inside the app so you can see whether a channel is connected, disconnected, or needs to be reconnected before a campaign goes live.
                  </p>
                </div>

                <div className="mt-8 rounded-2xl border border-white/10 bg-[#0D0D0D] p-6">
                  <div className="grid gap-4 md:grid-cols-2">
                    {[
                      ['Connection status', 'See which channels are connected and ready before scheduling a campaign.'],
                      ['One-click authorization', 'Connect your accounts in a few clicks from the Settings page.'],
                      ['Publishing safety', 'Only approved campaign content is ever sent to your connected channels.'],
                      ['Reconnect reminders', 'Aries alerts you if a channel needs to be reconnected before use.'],
                    ].map(([title, description]) => (
                      <div key={title} className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
                        <h3 className="font-semibold text-white">{title}</h3>
                        <p className="mt-2 text-sm leading-6 text-white/60">{description}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </section>

              {/* Security Section */}
              <section
                id="security"
                ref={(el) => { sectionRefs.current['security'] = el; }}
                className="scroll-mt-24 pt-12 border-t border-white/5"
              >
                <div className="flex items-center gap-4 mb-8">
                  <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-primary/20 to-secondary/20 flex items-center justify-center border border-white/10">
                    <ShieldCheck className="w-6 h-6 text-primary" />
                  </div>
                  <h2 className="text-3xl font-bold tracking-tight">Security</h2>
                </div>

                <div className="prose prose-invert prose-p:text-white/70 prose-p:leading-relaxed prose-p:text-lg max-w-none">
                  <p>
                    Aries is designed to keep your account, your campaigns, and your channel connections secure. You must be signed in to access your workspace, and every action that affects a live channel requires your explicit approval.
                  </p>
                  <p className="mt-4">
                    New users complete a short onboarding before reaching the dashboard. Your workspace is private to your account and any team members you invite.
                  </p>
                </div>

                <div className="mt-8 space-y-4">
                  {[
                    ['Protected workspaces', 'Your campaigns and dashboard are only accessible when you are signed in.'],
                    ['Approval gates', 'Each campaign stage requires your review and approval before moving forward.'],
                    ['Secure channel connections', 'Your connected accounts are authorized securely and never shared across workspaces.'],
                  ].map(([title, description]) => (
                    <div key={title} className="rounded-2xl border border-white/10 bg-white/[0.04] p-5">
                      <h3 className="font-bold text-white">{title}</h3>
                      <p className="mt-2 text-sm leading-7 text-white/60">{description}</p>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function cn(...classes: any[]) {
  return classes.filter(Boolean).join(' ');
}
