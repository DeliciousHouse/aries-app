import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { BarChart3, CalendarDays, CheckCheck, Home, LineChart, Settings2 } from 'lucide-react';

import { auth } from '@/auth';
import { AriesMark } from '@/frontend/donor/ui';
import { getRouteById, getSectionRoutes, type AppRouteId } from '@/frontend/app-shell/routes';
import { ReviewBadge } from '@/frontend/aries-v1/components';
import { ARIES_REVIEW_ITEMS } from '@/frontend/aries-v1/data';

export interface RedesignAppShellProps {
  children: ReactNode;
  currentRouteId?: AppRouteId;
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
}

const ICONS: Record<AppRouteId, typeof BarChart3> = {
  home: Home,
  campaigns: BarChart3,
  calendar: CalendarDays,
  results: LineChart,
  review: CheckCheck,
  settings: Settings2,
};

export default async function RedesignAppShell({
  children,
  currentRouteId,
  title,
  subtitle,
  actions,
}: RedesignAppShellProps): Promise<JSX.Element> {
  const session = await auth();
  if (!session?.user) {
    redirect('/login');
  }

  const currentRoute = currentRouteId ? getRouteById(currentRouteId) : null;
  const reviewCount = ARIES_REVIEW_ITEMS.length;

  return (
    <div className="min-h-screen bg-[#0d1218] text-white selection:bg-white/20">
      <div className="fixed inset-0 bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.08),transparent_24%),radial-gradient(circle_at_80%_10%,rgba(220,181,143,0.14),transparent_18%),linear-gradient(180deg,#111821_0%,#0d1218_100%)]" />

      <div className="relative z-10 min-h-screen">
        <header className="sticky top-0 z-30 border-b border-white/8 bg-[#0d1218]/85 backdrop-blur-xl">
          <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-4 lg:px-10">
            <div className="flex items-center gap-6">
              <Link href="/dashboard" className="flex items-center gap-3">
                <AriesMark sizeClassName="h-11 w-11" />
                <div>
                  <p className="text-sm font-semibold uppercase tracking-[0.18em] text-white/55">Aries AI</p>
                  <p className="text-xs text-white/40">Marketing operating system</p>
                </div>
              </Link>

              <nav aria-label="Primary navigation" className="hidden items-center gap-2 md:flex">
                {getSectionRoutes('primary').map((route) => {
                  const Icon = ICONS[route.id];
                  const isActive = currentRouteId === route.id;
                  return (
                    <Link
                      key={route.id}
                      href={route.href}
                      aria-current={isActive ? 'page' : undefined}
                      className={`inline-flex items-center gap-2 rounded-full border px-4 py-2.5 text-sm font-medium transition ${
                        isActive
                          ? 'border-white/20 bg-white/[0.08] text-white'
                          : 'border-transparent bg-transparent text-white/55 hover:border-white/10 hover:bg-white/[0.04] hover:text-white'
                      }`}
                    >
                      <Icon className="h-4 w-4" />
                      {route.title}
                    </Link>
                  );
                })}
              </nav>
            </div>

            <div className="flex items-center gap-3">
              <ReviewBadge count={reviewCount} href="/review" />
              <details className="group relative">
                <summary className="flex cursor-pointer list-none items-center gap-3 rounded-full border border-white/10 bg-white/[0.04] px-3 py-2.5 text-sm font-medium text-white/75 transition hover:border-white/16 hover:text-white">
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-white/[0.08] text-xs font-semibold text-white">
                    {(session.user.name || session.user.email || 'A').slice(0, 1).toUpperCase()}
                  </span>
                  <span className="hidden md:block">{session.user.name || 'Account'}</span>
                </summary>
                <div className="absolute right-0 top-[calc(100%+0.75rem)] w-72 rounded-[1.6rem] border border-white/10 bg-[#111821]/95 p-4 shadow-[0_28px_100px_rgba(0,0,0,0.4)] backdrop-blur-xl">
                  <p className="text-sm font-semibold text-white">{session.user.name || 'Aries account'}</p>
                  <p className="mt-1 text-sm text-white/50">{session.user.email || 'Signed in'}</p>
                  <div className="mt-4 space-y-2">
                    <Link href="/settings" className="block rounded-[1rem] px-3 py-2 text-sm text-white/70 transition hover:bg-white/[0.05] hover:text-white">
                      Settings
                    </Link>
                    <Link href="/review" className="block rounded-[1rem] px-3 py-2 text-sm text-white/70 transition hover:bg-white/[0.05] hover:text-white">
                      Review queue
                    </Link>
                    <Link href="/terms" className="block rounded-[1rem] px-3 py-2 text-sm text-white/70 transition hover:bg-white/[0.05] hover:text-white">
                      Terms
                    </Link>
                    <Link href="/privacy" className="block rounded-[1rem] px-3 py-2 text-sm text-white/70 transition hover:bg-white/[0.05] hover:text-white">
                      Privacy
                    </Link>
                  </div>
                </div>
              </details>
            </div>
          </div>
        </header>

        <main className="px-6 py-8 lg:px-10">
          <div className="mx-auto max-w-7xl space-y-6">
            <section className="rounded-[2.2rem] border border-white/10 bg-white/[0.04] px-6 py-6 shadow-[0_24px_80px_rgba(0,0,0,0.24)] backdrop-blur-xl md:px-8">
              <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
                <div className="max-w-3xl space-y-3">
                  <p className="text-sm font-semibold uppercase tracking-[0.24em] text-[#dcb58f]">
                    {currentRouteId === 'review' ? 'Review' : 'Workspace'}
                  </p>
                  <h1 className="text-4xl font-semibold tracking-[-0.03em] text-white">
                    {title ?? currentRoute?.title ?? 'Aries'}
                  </h1>
                  <p className="text-base leading-7 text-white/60">
                    {subtitle ?? currentRoute?.description ?? 'A calmer way to plan, approve, launch, and improve marketing.'}
                  </p>
                </div>
                {actions ? <div className="flex flex-wrap gap-3">{actions}</div> : null}
              </div>
            </section>

            {children}

            <footer className="flex flex-col gap-3 rounded-[1.8rem] border border-white/8 bg-black/12 px-5 py-5 text-sm text-white/50 md:flex-row md:items-center md:justify-between">
              <span>Aries keeps the complex work behind the scenes so the business can move with confidence.</span>
              <div className="flex flex-wrap gap-4">
                <Link href="/terms" className="transition hover:text-white">
                  Terms
                </Link>
                <Link href="/privacy" className="transition hover:text-white">
                  Privacy
                </Link>
                <Link href="/documentation" className="transition hover:text-white">
                  Documentation
                </Link>
              </div>
            </footer>
          </div>
        </main>
      </div>
    </div>
  );
}
