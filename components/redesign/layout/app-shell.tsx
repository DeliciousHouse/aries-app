import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';

import { auth } from '@/auth';
import { getRouteById, getSectionRoutes, type AppRouteId } from '@/frontend/app-shell/routes';

export interface RedesignAppShellProps {
  children: ReactNode;
  currentRouteId?: AppRouteId;
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
}

const ICONS: Record<AppRouteId, string> = {
  dashboard: '◈',
  posts: '✦',
  calendar: '◷',
  platforms: '◎',
  settings: '⚙',
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
    <div className="rd-app-shell">
      <aside className="rd-app-sidebar">
        <a href="/" className="rd-brand" aria-label="Back to Aries AI site">
          <span className="rd-brand__mark" aria-hidden="true">A</span>
          <span>Aries Operator</span>
        </a>

        <p className="rd-app-sidebar__label">Control Plane</p>
        <nav className="rd-app-sidebar__nav" aria-label="Application navigation">
          {getSectionRoutes('operator').map((route) => (
            <a
              key={route.id}
              href={route.href}
              className="rd-app-link"
              aria-current={currentRouteId === route.id ? 'page' : undefined}
            >
              <span aria-hidden="true">{ICONS[route.id]}</span>
              <span>{route.title}</span>
            </a>
          ))}
        </nav>
      </aside>

      <main className="rd-app-main">
        <header className="rd-page-header">
          <div>
            <p className="rd-hero__eyebrow">Aries control plane</p>
            <h1 className="rd-page-header__title">{title ?? currentRoute?.title ?? 'Operator Console'}</h1>
            <p className="rd-page-header__description">
              {subtitle ?? currentRoute?.description ?? 'Operate OpenClaw-backed workflows and platform connections from one place.'}
            </p>
          </div>
          {actions ? <div className="rd-inline-actions">{actions}</div> : null}
        </header>
        {children}
      </main>
    </div>
  );
}
