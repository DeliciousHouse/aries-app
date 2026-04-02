import type { ReactNode } from 'react';

import Link from 'next/link';
import { ArrowRight, Menu } from 'lucide-react';

import { AriesMark, AriesWordmark } from '../ui';

export interface DonorMarketingShellProps {
  children: ReactNode;
}

const NAV_ITEMS = [
  { name: 'How it works', href: '/#how-it-works' },
  { name: 'Safety', href: '/#safety' },
  { name: 'Results', href: '/#results' },
  { name: 'Start', href: '/onboarding/start' },
] as const;

function normalizeForActive(href: string) {
  return href.replace(/#.*$/, '') || '/';
}

export function DonorNavbar() {
  return (
    <nav className="sticky top-0 z-50 border-b border-white/10 bg-black/80 px-6 py-4 backdrop-blur-xl">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-6">
        <Link href="/" className="flex items-center gap-3">
          <AriesMark sizeClassName="h-10 w-10" sizes="40px" priority />
          <span className="text-lg font-bold tracking-tight text-white">Aries AI</span>
          <span className="sr-only">Aries AI</span>
        </Link>

        <div className="hidden items-center gap-8 md:flex">
          {NAV_ITEMS.map((link) => (
            <Link
              key={link.name}
              href={link.href}
              className={
                normalizeForActive(link.href) === '/'
                  ? 'text-sm font-medium text-white/80 transition-colors hover:text-white'
                  : 'text-sm font-medium text-white/70 transition-colors hover:text-white'
              }
            >
              {link.name}
            </Link>
          ))}
        </div>

        <div className="hidden items-center gap-4 md:flex">
          <Link
            href="/login"
            className="rounded-full border border-white/12 bg-white/5 px-5 py-2 text-sm font-medium text-white/85 transition-colors hover:bg-white/10"
          >
            Log in
          </Link>
          <Link
            href="/onboarding/start"
            className="flex items-center gap-2 rounded-full bg-gradient-to-r from-primary to-secondary px-5 py-2 text-sm font-medium text-white shadow-lg shadow-primary/20 transition-opacity hover:opacity-90"
          >
            Start with your business <ArrowRight className="h-4 w-4" />
          </Link>
        </div>

        <details className="relative md:hidden">
          <summary
            className="flex h-11 w-11 list-none items-center justify-center rounded-full border border-white/10 bg-white/5 text-white marker:hidden [&::-webkit-details-marker]:hidden"
            aria-label="Toggle navigation"
          >
            <Menu className="h-5 w-5" />
          </summary>

          <div className="absolute right-0 top-full mt-3 w-[min(20rem,calc(100vw-3rem))] rounded-[1.75rem] border border-white/10 bg-black/95 p-5 shadow-2xl shadow-black/40">
            <div className="flex flex-col gap-3">
              {NAV_ITEMS.map((link) => (
                <Link key={link.name} href={link.href} className="rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3 text-sm font-medium text-white/80 transition-colors hover:text-white">
                  {link.name}
                </Link>
              ))}
            </div>

            <div className="mt-4 grid gap-3 border-t border-white/10 pt-4">
              <Link
                href="/login"
                className="rounded-2xl border border-white/12 bg-white/5 px-4 py-3 text-center text-sm font-medium text-white"
              >
                Log in
              </Link>
              <Link
                href="/onboarding/start"
                className="rounded-2xl bg-gradient-to-r from-primary to-secondary px-4 py-3 text-center text-sm font-medium text-white"
              >
                Start with your business
              </Link>
            </div>
          </div>
        </details>
      </div>
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
              <li><a href="/onboarding/start" className="hover:text-white transition-colors">Set up your business</a></li>
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

export function DonorMarketingShell({ children }: DonorMarketingShellProps) {
  return (
    <div className="relative min-h-screen overflow-x-clip bg-background selection:bg-primary/30">
      <div
        className="pointer-events-none absolute inset-0 z-0 opacity-[0.03]"
        style={{
          backgroundImage:
            'linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)',
          backgroundSize: '40px 40px',
        }}
      />
      <div
        className="pointer-events-none absolute inset-x-0 top-0 z-0 h-[34rem]"
        style={{
          background:
            'radial-gradient(circle at 20% 20%, rgba(124, 58, 237, 0.22), transparent 40%), radial-gradient(circle at 80% 0%, rgba(168, 85, 247, 0.16), transparent 35%), radial-gradient(circle at 50% 30%, rgba(192, 132, 252, 0.08), transparent 50%)',
        }}
      />
      <DonorNavbar />
      <main className="relative z-10">{children}</main>
      <DonorFooter />
    </div>
  );
}
