import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { APP_ROUTES, type AppRouteId, getRouteById, getSectionRoutes } from './routes';

export interface AppShellLayoutProps {
  children: ReactNode;
  currentRouteId?: AppRouteId;
  title?: string;
  subtitle?: string;
}

const ICONS: Record<AppRouteId, string> = {
  dashboard: '📊',
  posts: '✍️',
  calendar: '📅',
  platforms: '🔌',
  settings: '⚙️',
};

export default async function AppShellLayout({
  children,
  currentRouteId,
  title,
  subtitle,
}: AppShellLayoutProps): Promise<JSX.Element> {
  const session = await auth();
  if (!session?.user) {
    redirect('/login');
  }

  const currentRoute = currentRouteId ? getRouteById(currentRouteId) : null;

  return (
    <div className="app-shell-bg">
      <div className="app-shell">
        <aside className="app-sidebar" role="navigation" aria-label="App navigation">
          <div className="sidebar-brand">
            <img src="/aries.webp" alt="" width={28} height={28} />
            <span>Aries AI</span>
          </div>

          <div className="sidebar-label">Operator</div>
          {getSectionRoutes('operator').map((route) => (
            <a
              key={route.id}
              href={route.href}
              className="sidebar-link"
              aria-current={currentRouteId === route.id ? 'page' : undefined}
            >
              <span className="sidebar-icon" aria-hidden="true">{ICONS[route.id]}</span>
              {route.title}
            </a>
          ))}

          <div style={{ flex: 1 }} />

          <a href="/" className="sidebar-link" style={{ marginTop: 'auto' }}>
            <span className="sidebar-icon" aria-hidden="true">←</span>
            Back to Site
          </a>
        </aside>

        <main className="app-main">
          <header className="app-page-header">
            <h1 className="app-page-title">{title ?? currentRoute?.title ?? 'Workflow Console'}</h1>
            <p className="app-page-desc">
              {subtitle ?? currentRoute?.description ?? 'Repo-managed workflow control plane for multi-platform publishing.'}
            </p>
          </header>
          <div>{children}</div>
        </main>
      </div>
    </div>
  );
}
