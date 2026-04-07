'use client';

import type { CSSProperties, ReactNode } from 'react';
import { useEffect, useState } from 'react';

import { usePathname } from 'next/navigation';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowRight, Menu, X } from 'lucide-react';

import { cn } from '../lib/utils';
import { AriesMark, AriesWordmark } from '../ui';

export interface DonorMarketingShellProps {
  children: ReactNode;
  heroMode?: boolean;
}

const NAV_ITEMS = [
  { name: 'How it works', href: '/#how-it-works' },
  { name: 'Safety', href: '/#safety' },
  { name: 'Results', href: '/#results' },
  { name: 'Start', href: '/onboarding/pipeline-intake' },
] as const;

function normalizeForActive(href: string) {
  return href.replace(/#.*$/, '') || '/';
}

export function DonorNavbar({ heroMode = false }: { heroMode?: boolean }) {
  const pathname = usePathname();
  const [isScrolled, setIsScrolled] = useState(false);
  const [headerOpacity, setHeaderOpacity] = useState(1);
  const [showIcon, setShowIcon] = useState(true);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [scrollProgress, setScrollProgress] = useState(0);
  const isHome = pathname === '/';
  const headerOverlayStyle: CSSProperties = {
    opacity: headerOpacity,
    pointerEvents: headerOpacity === 0 ? 'none' : 'auto',
  };

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 20);

      const heroHeight = window.innerHeight * 2.5;
      const progress = heroHeight > 0 ? window.scrollY / heroHeight : 0;
      setScrollProgress(progress);

      if (heroMode && isHome) {
        setShowIcon(progress > 0.95);

        if (progress < 0.1) {
          setHeaderOpacity(1);
        } else if (progress <= 0.15) {
          setHeaderOpacity(1 - (progress - 0.1) / 0.05);
        } else if (progress < 0.5) {
          setHeaderOpacity(0);
        } else if (progress <= 0.95) {
          setHeaderOpacity((progress - 0.5) / 0.45);
        } else {
          setHeaderOpacity(1);
        }
      } else {
        setShowIcon(true);
        setHeaderOpacity(1);
      }
    };

    handleScroll();
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, [heroMode, isHome]);

  return (
    <nav
      className={cn(
        'fixed top-0 left-0 right-0 z-50 transition-all duration-300 px-6',
        isScrolled && (!heroMode || !isHome || scrollProgress > 0.95)
          ? 'bg-black/50 backdrop-blur-md border-b border-white/10 py-3'
          : 'bg-transparent py-4',
      )}
    >
      <div className="max-w-7xl mx-auto flex items-center justify-between gap-6">
        <a href="/" className="flex items-center gap-2">
          <AriesMark className={cn('transition-opacity duration-300', showIcon ? 'opacity-100' : 'opacity-0')} />
          <span className="text-xl font-bold tracking-tight text-white" style={{ opacity: headerOpacity }}>
            Aries AI
          </span>
          <span className="sr-only">Aries AI</span>
        </a>

        <div className="hidden md:flex items-center gap-8" style={headerOverlayStyle}>
          {NAV_ITEMS.map((link) => (
            <a
              key={link.name}
              href={link.href}
              className={cn(
                'text-sm font-medium transition-colors',
                normalizeForActive(link.href) === pathname ? 'text-white' : 'text-white/70 hover:text-white',
              )}
            >
              {link.name}
            </a>
          ))}
        </div>

        <div className="hidden md:flex items-center gap-4" style={headerOverlayStyle}>
          <a
            href="/login"
            className="px-5 py-2 rounded-full border border-white/12 bg-white/5 text-sm font-medium text-white/85 transition-all hover:bg-white/10"
          >
            Log in
          </a>
          <a
            href="/onboarding/pipeline-intake"
            className="px-5 py-2 rounded-full bg-gradient-to-r from-primary to-secondary hover:opacity-90 text-sm font-medium transition-all shadow-lg shadow-primary/20 flex items-center gap-2 text-white"
          >
            Start with your business <ArrowRight className="w-4 h-4" />
          </a>
        </div>

        <button
          type="button"
          className="md:hidden text-white"
          onClick={() => setIsMobileMenuOpen((value) => !value)}
          style={headerOverlayStyle}
          aria-label={isMobileMenuOpen ? 'Close menu' : 'Open menu'}
        >
          {isMobileMenuOpen ? <X /> : <Menu />}
        </button>
      </div>

      <AnimatePresence>
        {isMobileMenuOpen && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="absolute top-full left-0 right-0 bg-black/95 backdrop-blur-xl border-b border-white/10 p-6 flex flex-col gap-6 md:hidden"
          >
            {NAV_ITEMS.map((link) => (
              <a
                key={link.name}
                href={link.href}
                className="text-lg font-medium text-white/70 hover:text-white"
                onClick={() => setIsMobileMenuOpen(false)}
              >
                {link.name}
              </a>
            ))}
            <div className="flex flex-col gap-4 pt-4 border-t border-white/10">
              <a
                href="/login"
                className="w-full py-3 flex justify-center rounded-xl border border-white/12 bg-white/5 font-medium text-white"
                onClick={() => setIsMobileMenuOpen(false)}
              >
                Log in
              </a>
              <a
                href="/onboarding/pipeline-intake"
                className="w-full py-3 flex justify-center rounded-xl bg-gradient-to-r from-primary to-secondary font-medium text-white"
                onClick={() => setIsMobileMenuOpen(false)}
              >
                Start with your business
              </a>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </nav>
  );
}

export function DonorFooter() {
  return (
    <footer className="pt-24 pb-12 border-t border-white/5 bg-black">
      <div className="container mx-auto px-6">
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-12 mb-16">
          <div className="col-span-2">
            <AriesWordmark className="mb-6" />
            <p className="text-white/50 max-w-xs mb-8 leading-relaxed">
              A calm marketing workspace where small businesses plan campaigns, approve creative, launch safely, and see what worked.
            </p>
            <div className="flex gap-4 text-sm text-white/60">
              <a href="/#how-it-works" className="hover:text-white transition-colors">How it works</a>
              <a href="/#safety" className="hover:text-white transition-colors">Safety</a>
              <a href="/#results" className="hover:text-white transition-colors">Results</a>
            </div>
          </div>

          <div className="hidden lg:block"></div>

          <div>
            <h4 className="font-bold mb-6">Product</h4>
            <ul className="space-y-4 text-white/50 text-sm">
              <li><a href="/#how-it-works" className="hover:text-white transition-colors">How it works</a></li>
              <li><a href="/dashboard" className="hover:text-white transition-colors">Dashboard</a></li>
              <li><a href="/campaigns" className="hover:text-white transition-colors">Campaigns</a></li>
              <li><a href="/review" className="hover:text-white transition-colors">Review queue</a></li>
            </ul>
          </div>

          <div>
            <h4 className="font-bold mb-6">Get started</h4>
            <ul className="space-y-4 text-white/50 text-sm">
              <li><a href="/onboarding/pipeline-intake" className="hover:text-white transition-colors">Set up your business</a></li>
              <li><a href="/login" className="hover:text-white transition-colors">Sign in</a></li>
              <li><a href="/calendar" className="hover:text-white transition-colors">Calendar</a></li>
              <li><a href="/results" className="hover:text-white transition-colors">Results</a></li>
            </ul>
          </div>

          <div>
            <h4 className="font-bold mb-6">Channels</h4>
            <ul className="space-y-4 text-white/50 text-sm">
              <li>Meta</li>
              <li>Instagram</li>
              <li>LinkedIn</li>
              <li>Google Business</li>
            </ul>
          </div>
        </div>

        <div className="pt-8 border-t border-white/5 flex flex-col md:flex-row justify-center items-center gap-4 text-white/30 text-xs">
          <p>© 2026 Aries AI. Built for small businesses that want marketing results without marketing software overhead.</p>
          <div className="flex flex-wrap items-center justify-center gap-4">
            <a href="/terms" className="hover:text-white transition-colors">Terms</a>
            <a href="/privacy" className="hover:text-white transition-colors">Privacy</a>
            <a href="/sitemap" className="hover:text-white transition-colors">Sitemap</a>
          </div>
        </div>
      </div>
    </footer>
  );
}

export function DonorMarketingShell({ children, heroMode = false }: DonorMarketingShellProps) {
  return (
    <div className="relative min-h-screen bg-background selection:bg-primary/30">
      <div
        className="fixed inset-0 z-0 pointer-events-none opacity-[0.03]"
        style={{
          backgroundImage:
            'linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)',
          backgroundSize: '40px 40px',
        }}
      />
      <DonorNavbar heroMode={heroMode} />
      <main className="relative z-10">{children}</main>
      <DonorFooter />
    </div>
  );
}
