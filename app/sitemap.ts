import type { MetadataRoute } from 'next';

function siteUrl(): string {
  return (
    process.env.APP_BASE_URL ||
    process.env.NEXTAUTH_URL ||
    process.env.AUTH_URL ||
    'https://aries.sugarandleather.com'
  ).replace(/\/+$/, '');
}

const PUBLIC_ROUTES = [
  '/',
  '/features',
  '/documentation',
  '/api-docs',
  '/contact',
  '/onboarding/start',
  '/privacy',
  '/terms',
  '/sitemap',
  '/social-content/new',
  '/social-content/status',
  '/social-content/review',
];

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = siteUrl();
  const now = new Date();

  return PUBLIC_ROUTES.map((route) => ({
    url: `${baseUrl}${route}`,
    lastModified: now,
    changeFrequency: route === '/' ? 'weekly' : 'monthly',
    priority: route === '/' ? 1 : 0.7,
  }));
}
