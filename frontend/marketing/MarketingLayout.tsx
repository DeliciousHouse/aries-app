import type { ReactNode } from 'react';

export interface MarketingLayoutProps {
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

export default function MarketingLayout({ children, currentPath = '/' }: MarketingLayoutProps) {
  return (
    <div className="marketing-bg">
      <nav className="nav-public" role="navigation" aria-label="Main navigation">
        <div className="container">
          <a href="/" className="nav-logo" aria-label="Aries AI Home">
            <img src="/aries-logo.png" alt="" width={36} height={36} />
            <span>Aries AI</span>
          </a>
          <ul className="nav-links">
            {NAV_ITEMS.map((item) => (
              <li key={item.href}>
                <a
                  href={item.href}
                  className="nav-link"
                  aria-current={currentPath === item.href ? 'page' : undefined}
                >
                  {item.label}
                </a>
              </li>
            ))}
            <li>
              <a href="/dashboard" className="btn btn-primary btn-sm">Get Started</a>
            </li>
          </ul>
        </div>
      </nav>

      <main>{children}</main>

      <footer className="footer-public">
        <div className="container footer-inner">
          <span>© {new Date().getFullYear()} Aries AI. All rights reserved.</span>
          <ul className="footer-links">
            <li><a href="/features">Features</a></li>
            <li><a href="/documentation">Documentation</a></li>
            <li><a href="/api-docs">API</a></li>
            <li><a href="/contact">Contact</a></li>
          </ul>
        </div>
      </footer>
    </div>
  );
}
