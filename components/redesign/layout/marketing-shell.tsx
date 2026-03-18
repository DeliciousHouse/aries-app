import type { ReactNode } from 'react';

import { ButtonLink } from '../primitives/button';

export interface MarketingShellProps {
  children: ReactNode;
  currentPath?: string;
}

const NAV_ITEMS = [
  { label: 'Home', href: '/' },
  { label: 'Features', href: '/features' },
  { label: 'Documentation', href: '/documentation' },
  { label: 'API', href: '/api-docs' },
  { label: 'Contact', href: '/contact' },
];

export function MarketingShell({
  children,
  currentPath = '/',
}: MarketingShellProps): JSX.Element {
  return (
    <div className="rd-marketing-shell">
      <nav className="rd-public-nav" aria-label="Primary navigation">
        <div className="rd-container rd-public-nav__inner">
          <a href="/" className="rd-brand" aria-label="Aries AI home">
            <span className="rd-brand__mark" aria-hidden="true">A</span>
            <span>Aries AI</span>
          </a>

          <div className="rd-public-nav__links">
            {NAV_ITEMS.map((item) => (
              <a
                key={item.href}
                href={item.href}
                className="rd-nav-link"
                aria-current={currentPath === item.href ? 'page' : undefined}
              >
                {item.label}
              </a>
            ))}
            <ButtonLink href="/login" variant="primary">
              Start Automating
            </ButtonLink>
          </div>
        </div>
      </nav>

      <main>{children}</main>

      <footer className="rd-footer">
        <div className="rd-container rd-footer__inner">
          <p>© {new Date().getFullYear()} Aries AI. Browser → Aries API → OpenClaw Gateway → Lobster workflows.</p>
          <div className="rd-inline-actions">
            <a className="rd-nav-link" href="/documentation">Documentation</a>
            <a className="rd-nav-link" href="/api-docs">API</a>
            <a className="rd-nav-link" href="/contact">Contact</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
