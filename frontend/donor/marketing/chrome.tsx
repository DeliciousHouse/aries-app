'use client';

import type { ReactNode } from 'react';
import { useEffect, useId, useRef, useState } from 'react';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowRight, Menu, X } from 'lucide-react';

import { cn } from '../lib/utils';
import { AriesMark, AriesWordmark } from '../ui';

export interface DonorMarketingShellProps {
  children: ReactNode;
  heroMode?: boolean;
}

const NAV_ITEMS = [
  { name: 'Product', href: '/#product' },
  { name: 'How it Works', href: '/#how-it-works' },
  { name: 'Features', href: '/#features' },
  { name: 'Pricing', href: '/#pricing' },
  { name: 'Docs', href: '/documentation' },
] as const;

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function normalizeForActive(href: string) {
  return href.replace(/#.*$/, '') || '/';
}

function getFocusableElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) {
    return [];
  }

  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true',
  );
}

export function DonorNavbar({ heroMode = false }: { heroMode?: boolean }) {
  const pathname = usePathname();
  const [isScrolled, setIsScrolled] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const menuId = useId();
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuPanelRef = useRef<HTMLDivElement>(null);
  const isHome = pathname === '/';

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > (heroMode && isHome ? 18 : 8));
    };

    handleScroll();
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, [heroMode, isHome]);

  useEffect(() => {
    setIsMobileMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!isMobileMenuOpen) {
      return undefined;
    }

    const { body, documentElement } = document;
    const previousOverflow = body.style.overflow;
    const previousPaddingRight = body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - documentElement.clientWidth;

    body.style.overflow = 'hidden';
    if (scrollbarWidth > 0) {
      body.style.paddingRight = `${scrollbarWidth}px`;
    }

    const focusFrame = window.requestAnimationFrame(() => {
      getFocusableElements(menuPanelRef.current)[0]?.focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setIsMobileMenuOpen(false);
        menuButtonRef.current?.focus();
        return;
      }

      if (event.key !== 'Tab') {
        return;
      }

      const focusable = getFocusableElements(menuPanelRef.current);
      if (focusable.length === 0) {
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeElement = document.activeElement;

      if (event.shiftKey && activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', handleKeyDown);
      body.style.overflow = previousOverflow;
      body.style.paddingRight = previousPaddingRight;
    };
  }, [isMobileMenuOpen]);

  return (
    <nav className="fixed inset-x-0 top-0 z-50 px-4 py-4 sm:px-6" aria-label="Primary">
      <div
        className={cn(
          'mx-auto flex max-w-7xl items-center justify-between gap-4 rounded-full border px-4 py-3 transition-all duration-200 sm:px-6',
          isScrolled || !heroMode || !isHome
            ? 'border-white/12 bg-black/78 shadow-[0_18px_60px_rgba(0,0,0,0.38)] backdrop-blur-xl'
            : 'border-white/10 bg-black/30 backdrop-blur-md shadow-[0_12px_40px_rgba(0,0,0,0.2)]',
        )}
      >
        <Link href="/" className="flex items-center gap-3 rounded-full focus-visible:outline-offset-4">
          <AriesMark className="shadow-[0_14px_40px_rgba(124,58,237,0.22)]" />
          <div className="min-w-0">
            <span className="block text-base font-semibold tracking-tight text-white sm:text-lg">
              Aries AI
            </span>
            <span className="hidden text-[0.68rem] uppercase tracking-[0.28em] text-white/55 sm:block">
              Autonomous marketing runtime
            </span>
          </div>
        </Link>

        <div className="hidden items-center gap-7 md:flex">
          {NAV_ITEMS.map((link) => (
            <Link
              key={link.name}
              href={link.href}
              className={cn(
                'rounded-full px-1 py-2 text-sm font-medium transition-colors',
                normalizeForActive(link.href) === pathname ? 'text-white' : 'text-white/72 hover:text-white',
              )}
            >
              {link.name}
            </Link>
          ))}
        </div>

        <div className="hidden items-center gap-4 md:flex">
          <Link
            href="/login"
            className="inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-primary to-secondary px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-primary/20 transition-transform duration-200 hover:translate-y-[-1px]"
          >
            Start Automating <ArrowRight className="h-4 w-4" />
          </Link>
        </div>

        <button
          ref={menuButtonRef}
          type="button"
          className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-white/6 text-white transition-colors hover:bg-white/10 md:hidden"
          onClick={() => setIsMobileMenuOpen((value) => !value)}
          aria-expanded={isMobileMenuOpen}
          aria-controls={menuId}
          aria-haspopup="dialog"
          aria-label={isMobileMenuOpen ? 'Close navigation menu' : 'Open navigation menu'}
        >
          {isMobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {isMobileMenuOpen ? (
        <>
          <button
            type="button"
            className="fixed inset-0 z-40 bg-black/55 backdrop-blur-sm md:hidden"
            aria-label="Close navigation menu"
            onClick={() => {
              setIsMobileMenuOpen(false);
              menuButtonRef.current?.focus();
            }}
          />
          <div
            id={menuId}
            ref={menuPanelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Primary navigation"
            className="absolute left-4 right-4 top-full z-50 mt-3 rounded-[2rem] border border-white/10 bg-black/92 p-6 shadow-[0_26px_80px_rgba(0,0,0,0.48)] backdrop-blur-2xl md:hidden sm:left-6 sm:right-6"
          >
            <div className="mb-5 flex items-center gap-3 border-b border-white/10 pb-5">
              <AriesMark />
              <div>
                <p className="text-sm font-semibold text-white">Explore Aries AI</p>
                <p className="text-sm text-white/62">Jump to product details or open the operator console.</p>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              {NAV_ITEMS.map((link) => (
                <Link
                  key={link.name}
                  href={link.href}
                  className={cn(
                    'rounded-2xl border px-4 py-3 text-base font-medium transition-colors',
                    normalizeForActive(link.href) === pathname
                      ? 'border-primary/30 bg-primary/12 text-white'
                      : 'border-white/10 bg-white/5 text-white/78 hover:bg-white/9 hover:text-white',
                  )}
                  onClick={() => setIsMobileMenuOpen(false)}
                >
                  {link.name}
                </Link>
              ))}
            </div>

            <div className="mt-6 grid gap-3 border-t border-white/10 pt-5">
              <Link
                href="/login"
                className="inline-flex items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-primary to-secondary px-5 py-3.5 text-sm font-semibold text-white shadow-lg shadow-primary/20"
                onClick={() => setIsMobileMenuOpen(false)}
              >
                Start Automating <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="/documentation"
                className="inline-flex items-center justify-center rounded-2xl border border-white/10 bg-white/5 px-5 py-3.5 text-sm font-semibold text-white/82"
                onClick={() => setIsMobileMenuOpen(false)}
              >
                Review docs
              </Link>
            </div>
          </div>
        </>
      ) : null}
    </nav>
  );
}

export function DonorFooter() {
  return (
    <footer className="border-t border-white/6 bg-black/80 pb-12 pt-20">
      <div className="container mx-auto px-6">
        <div className="grid gap-12 md:grid-cols-2 lg:grid-cols-[1.6fr_repeat(3,minmax(0,1fr))]">
          <div className="max-w-sm">
            <AriesWordmark className="mb-5" />
            <p className="mb-7 text-sm leading-7 text-white/68">
              A premium browser-safe front door for the Aries operator experience, with approvals,
              campaign orchestration, and OpenClaw-powered execution behind the server boundary.
            </p>
            <div className="flex flex-wrap gap-3 text-sm text-white/74">
              <Link href="/documentation" className="rounded-full border border-white/10 px-4 py-2 transition-colors hover:bg-white/6">
                Docs
              </Link>
              <Link href="/api-docs" className="rounded-full border border-white/10 px-4 py-2 transition-colors hover:bg-white/6">
                API
              </Link>
              <Link href="/contact" className="rounded-full border border-white/10 px-4 py-2 transition-colors hover:bg-white/6">
                Contact
              </Link>
            </div>
          </div>

          <div>
            <p className="mb-5 text-sm font-semibold uppercase tracking-[0.22em] text-white/52">Product</p>
            <ul className="space-y-3 text-sm text-white/72">
              <li><Link href="/#features" className="transition-colors hover:text-white">Features</Link></li>
              <li><Link href="/platforms" className="transition-colors hover:text-white">Platforms</Link></li>
              <li><Link href="/dashboard" className="transition-colors hover:text-white">Dashboard</Link></li>
              <li><Link href="/marketing/new-job" className="transition-colors hover:text-white">Campaigns</Link></li>
            </ul>
          </div>

          <div>
            <p className="mb-5 text-sm font-semibold uppercase tracking-[0.22em] text-white/52">Runtime</p>
            <ul className="space-y-3 text-sm text-white/72">
              <li><Link href="/documentation" className="transition-colors hover:text-white">Documentation</Link></li>
              <li><Link href="/api-docs" className="transition-colors hover:text-white">Internal APIs</Link></li>
              <li><Link href="/onboarding/start" className="transition-colors hover:text-white">Onboarding</Link></li>
              <li><Link href="/oauth/connect/facebook" className="transition-colors hover:text-white">OAuth Flow</Link></li>
            </ul>
          </div>

          <div>
            <p className="mb-5 text-sm font-semibold uppercase tracking-[0.22em] text-white/52">Channels</p>
            <ul className="space-y-3 text-sm text-white/72">
              <li>Meta</li>
              <li>LinkedIn</li>
              <li>X</li>
              <li>TikTok</li>
            </ul>
          </div>
        </div>

        <div className="mt-14 flex flex-col gap-4 border-t border-white/6 pt-8 text-sm text-white/58 md:flex-row md:items-center md:justify-between">
          <p>© 2026 Aries AI Inc. All rights reserved.</p>
          <div className="flex flex-wrap gap-5">
            <Link href="/documentation" className="transition-colors hover:text-white">Runtime docs</Link>
            <Link href="/api-docs" className="transition-colors hover:text-white">API surface</Link>
            <Link href="/contact" className="transition-colors hover:text-white">Contact</Link>
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
        className="fixed inset-0 z-0 pointer-events-none opacity-[0.025]"
        style={{
          backgroundImage:
            'linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)',
          backgroundSize: '40px 40px',
        }}
      />
      <div className="pointer-events-none fixed inset-x-0 top-0 z-0 h-[36rem] bg-[radial-gradient(circle_at_top,rgba(124,58,237,0.18),transparent_58%)]" />
      <DonorNavbar heroMode={heroMode} />
      <main className="relative z-10">{children}</main>
      <DonorFooter />
    </div>
  );
}
