import MarketingLayout from '@/frontend/marketing/MarketingLayout';

const ROUTE_GROUPS: Array<{ title: string; routes: Array<{ href: string; label: string }> }> = [
  {
    title: 'Public',
    routes: [
      { href: '/', label: 'Home' },
      { href: '/features', label: 'Features' },
      { href: '/documentation', label: 'Documentation' },
      { href: '/api-docs', label: 'API docs' },
      { href: '/contact', label: 'Contact' },
    ],
  },
  {
    title: 'Campaign',
    routes: [
      { href: '/marketing/new-job', label: 'New campaign' },
      { href: '/marketing/job-status', label: 'Campaign status' },
      { href: '/marketing/job-approve', label: 'Campaign approval' },
      { href: '/onboarding/pipeline-intake', label: 'Brand and competitor research intake' },
    ],
  },
  {
    title: 'Operator',
    routes: [
      { href: '/dashboard', label: 'Dashboard' },
      { href: '/posts', label: 'Posts' },
      { href: '/calendar', label: 'Calendar' },
      { href: '/platforms', label: 'Platforms' },
      { href: '/settings', label: 'Settings' },
    ],
  },
  {
    title: 'Legal',
    routes: [
      { href: '/terms', label: 'Terms of Service' },
      { href: '/privacy', label: 'Privacy Policy' },
    ],
  },
] as const;

export default function SiteMapPage() {
  return (
    <MarketingLayout>
      <section className="container mx-auto px-6 pt-32 pb-20">
        <div className="max-w-5xl space-y-8">
          <div className="glass rounded-[2.5rem] p-8 md:p-10">
            <p className="text-xs uppercase tracking-[0.3em] text-primary mb-3">Navigation</p>
            <h1 className="text-4xl font-bold mb-3">Sitemap</h1>
            <p className="text-white/60">Browse all primary Aries routes by workflow area.</p>
          </div>
          <div className="grid md:grid-cols-2 gap-6">
            {ROUTE_GROUPS.map((group) => (
              <section key={group.title} className="glass rounded-[2rem] p-6">
                <h2 className="text-2xl font-semibold mb-4">{group.title}</h2>
                <ul className="space-y-3">
                  {group.routes.map((route) => (
                    <li key={route.href}>
                      <a href={route.href} className="text-white/75 hover:text-white transition-colors">
                        {route.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
      </section>
    </MarketingLayout>
  );
}
