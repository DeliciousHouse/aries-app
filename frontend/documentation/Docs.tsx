"use client";

import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  BookOpen,
  ChevronRight,
  Terminal,
  Layout,
  GitBranch,
  Plug,
  ShieldCheck,
  Copy,
  Check,
  Search,
  Book,
  Code,
  Sparkles
} from 'lucide-react';

const sections = [
  { id: 'overview', title: 'Overview', icon: BookOpen },
  { id: 'quick-start', title: 'Quick Start', icon: Terminal },
  { id: 'architecture', title: 'Architecture', icon: Layout },
  { id: 'n8n-workflows', title: 'n8n Workflows', icon: GitBranch },
  { id: 'integrations', title: 'Integrations', icon: Plug },
  { id: 'security', title: 'Security', icon: ShieldCheck },
];

export default function Docs() {
  const [activeSection, setActiveSection] = useState('overview');
  const [copied, setCopied] = useState(false);
  const sectionRefs = useRef<{ [key: string]: HTMLElement | null }>({});

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

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
              Everything you need to deploy, configure, and operate the Aries platform.
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
                    Aries AI is a multi-tenant platform that orchestrates AI-powered content pipelines across 7 social platforms. Built on Next.js 15 and n8n, it provides end-to-end automation from research and strategy through production, approval, and publishing.
                  </p>
                  <p className="mt-6">
                    The system uses a workflow-first architecture: every operation — from onboarding a new tenant to publishing a scheduled post — is modeled as an n8n workflow with built-in repair, retry, and observability.
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
                  <h2 className="text-3xl font-bold tracking-tight">Quick Start</h2>
                </div>

                <div className="space-y-12">
                  <div>
                    <h3 className="text-2xl font-bold mb-6 flex items-center gap-3">
                      <ChevronRight className="w-5 h-5 text-primary" />
                      Environment Setup
                    </h3>
                    <div className="relative group">
                      <button
                        onClick={() => copyToClipboard('git clone <repo-url> && cd aries-app\nnpm install\ncp .env.example .env')}
                        className="absolute right-4 top-4 p-2 rounded-lg bg-white/10 hover:bg-white/20 transition-colors opacity-0 group-hover:opacity-100"
                      >
                        {copied ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
                      </button>
                      <pre className="bg-[#0D0D0D] border border-white/10 rounded-2xl p-6 overflow-x-auto font-mono text-sm leading-relaxed text-indigo-300 shadow-2xl">
                        <code>
                          {`# Clone and install
git clone <repo-url> && cd aries-app
npm install

# Configure environment
cp .env.example .env
# Edit .env with your N8N_BASE_URL and N8N_API_KEY

# Start development server
npm run dev --turbopack`}
                        </code>
                      </pre>
                    </div>
                  </div>
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
                  <h2 className="text-3xl font-bold tracking-tight">Architecture</h2>
                </div>

                <div className="prose prose-invert prose-p:text-white/70 prose-p:leading-relaxed prose-p:text-lg max-w-none">
                  <p>
                    Aries follows a layered architecture with clear boundaries, ensuring scalability and maintainability across both frontend components and backend orchestration.
                  </p>
                  <p className="mt-4">
                    The direct architecture ensures that the execution boundary is respected between the Next.js app and the OpenClaw gateway.
                  </p>
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
