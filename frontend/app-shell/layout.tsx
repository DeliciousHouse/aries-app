import type { ReactNode } from 'react';

import { APP_ROUTES, type AppRouteId, getRouteById, getSectionRoutes } from './routes';

export interface AppShellLayoutProps {
  children: ReactNode;
  currentRouteId?: AppRouteId;
  title?: string;
  subtitle?: string;
}

function RouteLink({
  href,
  label,
  isActive
}: {
  href: string;
  label: string;
  isActive: boolean;
}): JSX.Element {
  return (
    <a
      href={href}
      aria-current={isActive ? 'page' : undefined}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        borderRadius: 999,
        border: `1px solid ${isActive ? '#0f172a' : '#d0d5dd'}`,
        color: isActive ? '#0f172a' : '#344054',
        background: isActive ? '#f8fafc' : '#ffffff',
        textDecoration: 'none',
        fontSize: 13,
        fontWeight: 600,
        padding: '6px 11px'
      }}
    >
      {label}
    </a>
  );
}

export default function AppShellLayout({
  children,
  currentRouteId,
  title,
  subtitle
}: AppShellLayoutProps): JSX.Element {
  const currentRoute = currentRouteId ? getRouteById(currentRouteId) : null;

  return (
    <main style={{ maxWidth: 1080, margin: '0 auto', display: 'grid', gap: 16 }}>
      <header
        style={{
          border: '1px solid #e4e7ec',
          borderRadius: 12,
          background: '#ffffff',
          padding: 16,
          display: 'grid',
          gap: 10
        }}
      >
        <div>
          <p style={{ margin: 0, fontSize: 12, color: '#475467' }}>ARIES App Shell</p>
          <h1 style={{ margin: '6px 0 0', fontSize: 24 }}>{title ?? currentRoute?.title ?? 'Workflow Console'}</h1>
          <p style={{ margin: '8px 0 0', color: '#667085' }}>
            {subtitle ?? currentRoute?.description ?? 'Shared navigation for onboarding and marketing flows.'}
          </p>
        </div>

        <nav aria-label="workflow navigation" style={{ display: 'grid', gap: 10 }}>
          <div style={{ display: 'grid', gap: 6 }}>
            <strong style={{ fontSize: 12, color: '#475467' }}>Onboarding</strong>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {getSectionRoutes('onboarding').map((route) => (
                <RouteLink
                  key={route.id}
                  href={route.href}
                  label={route.title}
                  isActive={currentRouteId === route.id}
                />
              ))}
            </div>
          </div>

          <div style={{ display: 'grid', gap: 6 }}>
            <strong style={{ fontSize: 12, color: '#475467' }}>Marketing</strong>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {getSectionRoutes('marketing').map((route) => (
                <RouteLink
                  key={route.id}
                  href={route.href}
                  label={route.title}
                  isActive={currentRouteId === route.id}
                />
              ))}
            </div>
          </div>
        </nav>
      </header>

      <section
        style={{
          border: '1px solid #e4e7ec',
          borderRadius: 12,
          background: '#ffffff',
          padding: 16
        }}
      >
        {children}
      </section>

      <footer style={{ fontSize: 12, color: '#667085', paddingBottom: 8 }}>
        {APP_ROUTES.length} routes available in shared shell navigation.
      </footer>
    </main>
  );
}
