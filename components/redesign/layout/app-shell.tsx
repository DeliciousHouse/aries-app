import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { BarChart3, CalendarDays, Compass, Settings2, Sparkles } from 'lucide-react';

import { auth } from '@/auth';
import { AriesMark } from '@/frontend/donor/ui';
import { getRouteById, getSectionRoutes, type AppRouteId } from '@/frontend/app-shell/routes';

export interface RedesignAppShellProps {
  children: ReactNode;
  currentRouteId?: AppRouteId;
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
}

const ICONS: Record<AppRouteId, typeof BarChart3> = {
  dashboard: BarChart3,
  posts: Sparkles,
  calendar: CalendarDays,
  platforms: Compass,
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

  return (
    <div className="min-h-screen bg-background text-white selection:bg-primary/30">
      <div
        className="fixed inset-0 pointer-events-none opacity-[0.03]"
        style={{
          backgroundImage:
            'linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)',
          backgroundSize: '40px 40px',
        }}
      />

      <div className="relative z-10 grid min-h-screen lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="border-r border-white/10 bg-black/35 backdrop-blur-xl p-6 lg:p-8 flex flex-col gap-8">
          <Link href="/" className="flex items-center gap-3">
            <AriesMark sizeClassName="w-11 h-11" />
            <div>
              <div className="text-lg font-bold tracking-tight">Aries AI</div>
              <div className="text-xs uppercase tracking-[0.25em] text-white/40">Control Plane</div>
            </div>
          </Link>

          <div className="glass rounded-[2rem] p-5">
            <p className="text-xs uppercase tracking-[0.25em] text-white/35 mb-3">Runtime boundary</p>
            <p className="text-sm text-white/65 leading-relaxed">
              Browser calls Aries routes only. OpenClaw and Lobster stay behind the server boundary.
            </p>
          </div>

          <div>
            <p className="text-xs uppercase tracking-[0.25em] text-white/35 mb-4">Operator navigation</p>
            <nav aria-label="Application navigation" className="space-y-2">
              {getSectionRoutes('operator').map((route) => {
                const Icon = ICONS[route.id];
                const isActive = currentRouteId === route.id;
                return (
                  <a
                    key={route.id}
                    href={route.href}
                    aria-current={isActive ? 'page' : undefined}
                    className={`flex items-center gap-3 rounded-2xl px-4 py-3 transition-all border ${
                      isActive
                        ? 'bg-gradient-to-r from-primary/20 to-secondary/15 border-primary/25 text-white shadow-lg shadow-primary/10'
                        : 'bg-white/5 border-transparent text-white/65 hover:text-white hover:bg-white/10'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    <span className="font-medium">{route.title}</span>
                  </a>
                );
              })}
            </nav>
          </div>

          <div className="mt-auto rounded-[2rem] border border-white/10 bg-white/5 p-5">
            <p className="text-xs uppercase tracking-[0.25em] text-white/35 mb-2">Signed in</p>
            <p className="font-semibold">{session.user.name || session.user.email || 'Operator'}</p>
            <p className="text-sm text-white/55 mt-1">
              {session.user.email || 'Authenticated Aries runtime session'}
            </p>
          </div>
        </aside>

        <main className="px-6 py-8 md:px-8 lg:px-10 xl:px-12">
          <div className="max-w-7xl mx-auto space-y-8">
            <header className="glass rounded-[2.5rem] p-8 md:p-10">
              <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
                <div className="max-w-3xl">
                  <p className="text-xs uppercase tracking-[0.3em] text-primary mb-3">Aries control plane</p>
                  <h1 className="text-4xl md:text-5xl font-bold leading-tight mb-3">
                    {title ?? currentRoute?.title ?? 'Operator Console'}
                  </h1>
                  <p className="text-lg text-white/60">
                    {subtitle ?? currentRoute?.description ?? 'Operate OpenClaw-backed workflows and platform connections from one place.'}
                  </p>
                </div>
                {actions ? <div className="flex flex-wrap gap-3">{actions}</div> : null}
              </div>
            </header>

            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
