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
  Code
} from 'lucide-react';
// import Navbar from '../components/Navbar';
// import Footer from '../components/Footer';

const sections = [
  { id: 'overview', title: 'Overview', icon: BookOpen },
  { id: 'quick-start', title: 'Quick Start', icon: Terminal },
  { id: 'architecture', title: 'Architecture', icon: Layout },
  { id: 'n8n-workflows', title: 'n8n Workflows', icon: GitBranch },
  { id: 'integrations', title: 'Integrations', icon: Plug },
  { id: 'security', title: 'Security', icon: ShieldCheck },
];

const Docs = () => {
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
      {/* <Navbar /> */}

      {/* Background Glows */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
        <div className="absolute top-[-10%] left-[20%] w-[500px] h-[500px] bg-primary/10 rounded-full blur-[120px]" />
        <div className="absolute bottom-[20%] right-[-10%] w-[400px] h-[400px] bg-secondary/10 rounded-full blur-[120px]" />
      </div>

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
                <div className="mb-6 lg:hidden">
                  {/* Search placeholder for mobile */}
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40" />
                    <input
                      type="text"
                      placeholder="Search docs..."
                      className="w-full bg-white/5 border border-white/10 rounded-xl py-2 pl-10 pr-4 text-sm focus:outline-none focus:border-primary/50"
                    />
                  </div>
                </div>

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

                <div className="mt-12 p-8 rounded-[2rem] glass-reflection border border-white/10 relative overflow-hidden group">
                  <div className="absolute top-0 right-0 w-64 h-64 bg-primary/10 rounded-full blur-[80px] -mr-32 -mt-32 transition-all group-hover:bg-primary/20" />
                  <div className="relative z-10 flex flex-col md:flex-row gap-8 items-start md:items-center">
                    <div className="w-16 h-16 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center flex-shrink-0">
                      <Sparkles className="w-8 h-8 text-primary" />
                    </div>
                    <div>
                      <h4 className="text-xl font-bold mb-2">Workflow-First Strategy</h4>
                      <p className="text-white/60">Every action in Aries is a discrete, observable step in a robust automation pipeline.</p>
                    </div>
                  </div>
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
                      Prerequisites
                    </h3>
                    <ul className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {[
                        'Node.js 18+ and npm',
                        'A running n8n instance with API access',
                        'Platform OAuth credentials (Meta, LinkedIn, X, etc.)'
                      ].map((item, i) => (
                        <li key={i} className="flex items-center gap-3 p-4 rounded-xl bg-white/5 border border-white/10 text-white/80 font-medium">
                          <Check className="w-4 h-4 text-green-500" />
                          {item}
                        </li>
                      ))}
                    </ul>
                  </div>

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
npm run dev`}
                        </code>
                      </pre>
                    </div>
                  </div>

                  <div>
                    <h3 className="text-2xl font-bold mb-6 flex items-center gap-3">
                      <ChevronRight className="w-5 h-5 text-primary" />
                      First Steps
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      {[
                        { title: 'Verify Connection', desc: 'Check n8n connection in dashboard' },
                        { title: 'Connect Platforms', desc: 'Settings → Platforms → Link Socials' },
                        { title: 'Create First Job', desc: 'Create content on the Posts page' },
                        { title: 'Monitor Progress', desc: 'Track execution in the Dashboard' },
                      ].map((step, i) => (
                        <div key={i} className="p-6 rounded-2xl bg-white/5 border border-white/10 hover:border-primary/30 transition-all group">
                          <span className="inline-block px-2 py-1 rounded-md bg-primary/10 text-primary text-[10px] font-bold uppercase mb-4">Step 0{i + 1}</span>
                          <h4 className="text-lg font-bold mb-2 group-hover:text-primary transition-colors">{step.title}</h4>
                          <p className="text-sm text-white/50">{step.desc}</p>
                        </div>
                      ))}
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
                </div>

                <div className="mt-12 space-y-6">
                  {[
                    { label: 'Frontend Layer', desc: 'React components, app-shell layout, marketing pages' },
                    { label: 'API Layer', desc: 'Next.js route handlers that proxy to n8n workflows' },
                    { label: 'Backend Services', desc: 'Business logic for auth, integrations, marketing, and publishing' },
                    { label: 'n8n Workflows', desc: 'Orchestration engine for all async operations' },
                  ].map((layer, i) => (
                    <div key={i} className="flex gap-6 items-start p-6 rounded-2xl bg-white/5 border border-white/10 hover:bg-white/8 transition-colors">
                      <div className="text-primary mt-1 flex-shrink-0"><Code className="w-5 h-5" /></div>
                      <div>
                        <div className="font-bold text-lg mb-1">{layer.label}</div>
                        <div className="text-white/60 text-sm leading-relaxed">{layer.desc}</div>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="mt-10 p-6 rounded-2xl bg-primary/5 border border-primary/10 text-white/80 text-sm leading-relaxed italic">
                  Note: All frontend-to-backend communication goes through internal /api/* routes. The API layer proxies to n8n webhooks server-side, keeping credentials secure.
                </div>
              </section>

              {/* n8n Workflows Section */}
              <section
                id="n8n-workflows"
                ref={(el) => { sectionRefs.current['n8n-workflows'] = el; }}
                className="scroll-mt-24 pt-12 border-t border-white/5"
              >
                <div className="flex items-center gap-4 mb-8">
                  <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-primary/20 to-secondary/20 flex items-center justify-center border border-white/10">
                    <GitBranch className="w-6 h-6 text-primary" />
                  </div>
                  <h2 className="text-3xl font-bold tracking-tight">n8n Workflows</h2>
                </div>

                <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-white/10 border-b border-white/10">
                        <th className="px-6 py-4 text-sm font-bold uppercase tracking-wider text-white/60">Workflow</th>
                        <th className="px-6 py-4 text-sm font-bold uppercase tracking-wider text-white/60">Webhook Path</th>
                        <th className="px-6 py-4 text-sm font-bold uppercase tracking-wider text-white/60">Purpose</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {[
                        { name: 'tenant-provisioning', path: '/webhook/tenant-provisioning', purpose: 'New tenant onboarding & validation' },
                        { name: 'tenant-repair', path: '/webhook/tenant-repair', purpose: 'Fix broken tenant state' },
                        { name: 'marketing-research', path: '/webhook/marketing-research', purpose: 'AI-driven market research' },
                        { name: 'marketing-strategy', path: '/webhook/marketing-strategy', purpose: 'Content strategy generation' },
                        { name: 'marketing-production', path: '/webhook/marketing-production', purpose: 'Content asset production' },
                        { name: 'marketing-publish', path: '/webhook/marketing-publish', purpose: 'Cross-platform publishing' },
                        { name: 'marketing-approval-resume', path: '/webhook/marketing-approval-resume', purpose: 'Resume after human approval' },
                        { name: 'marketing-repair', path: '/webhook/marketing-repair', purpose: 'Auto-repair failed jobs' },
                        { name: 'publish-dispatch', path: '/webhook/aries/publish', purpose: 'Normalized publish dispatch' },
                        { name: 'connection-events', path: '/webhook/aries/connection-events', purpose: 'Connection lifecycle' },
                      ].map((wf, i) => (
                        <tr key={i} className="hover:bg-white/5 transition-colors">
                          <td className="px-6 py-4 font-mono text-primary text-xs">{wf.name}</td>
                          <td className="px-6 py-4 font-mono text-white/40 text-[11px]">{wf.path}</td>
                          <td className="px-6 py-4 text-sm text-white/70">{wf.purpose}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
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

                <div className="prose prose-invert prose-p:text-white/70 prose-p:max-w-none mb-10">
                  <p className="text-lg">
                    Aries supports 7 social platforms via a unified OAuth broker. Each platform adapter handles token refresh, permission validation, and content format adaptation.
                  </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {[
                    { name: 'Facebook', desc: 'Page publishing via Meta Graph API' },
                    { name: 'Instagram', desc: 'Business account content publishing' },
                    { name: 'LinkedIn', desc: 'Company page and member posting' },
                    { name: 'X (Twitter)', desc: 'Post scheduling and analytics' },
                    { name: 'YouTube', desc: 'Channel publishing workflows' },
                    { name: 'Reddit', desc: 'Community publishing automation' },
                    { name: 'TikTok', desc: 'Business video publishing' },
                  ].map((plat, i) => (
                    <div key={i} className="p-6 rounded-2xl bg-white/5 border border-white/10 hover:border-secondary/30 transition-all flex flex-col items-center text-center">
                      <div className="w-10 h-10 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center mb-4">
                        <Plug className="w-5 h-5 text-secondary" />
                      </div>
                      <h4 className="font-bold mb-2">{plat.name}</h4>
                      <p className="text-xs text-white/40 leading-relaxed">{plat.desc}</p>
                    </div>
                  ))}
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

                <div className="space-y-6">
                  {[
                    { title: 'Multi-tenant isolation', desc: 'Strict boundary enforcement between tenant data.' },
                    { title: 'Role-based access control', desc: 'RBAC support for tenant_admin, tenant_analyst, and tenant_viewer.' },
                    { title: 'Encrypted credential storage', desc: 'All platform tokens are encrypted at-rest with rotation support.' },
                    { title: 'Session hardening', desc: 'Secure cookies, CSRF protection, and automatic idle timeouts.' },
                    { title: 'Server-side Secret Management', desc: 'All n8n API keys stay server-side — never exposed to client code.' },
                  ].map((item, i) => (
                    <div key={i} className="flex gap-6 p-6 rounded-2xl bg-gradient-to-r from-green-500/5 to-transparent border border-green-500/10">
                      <div className="mt-1"><ShieldCheck className="w-5 h-5 text-green-500" /></div>
                      <div>
                        <div className="font-bold mb-1">{item.title}</div>
                        <p className="text-sm text-white/50">{item.desc}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          </div>
        </div>
      </main>

      {/* <Footer /> */}
    </div>
  );
};

// Helper function for class merging
function cn(...classes: any[]) {
  return classes.filter(Boolean).join(' ');
}

// Sparkles icon for consistency
const Sparkles = ({ className }: { className?: string }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
    <path d="M5 3v4" /><path d="M3 5h4" /><path d="M21 17v4" /><path d="M19 19h4" />
  </svg>
);

export default Docs;
