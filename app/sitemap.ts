import type { MetadataRoute } from 'next';

import { metadataSiteOrigin } from '@/lib/metadata-site-url';

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
  const baseUrl = metadataSiteOrigin();
  const now = new Date();

  return PUBLIC_ROUTES.map((route) => ({
    url: `${baseUrl}${route}`,
    lastModified: now,
    changeFrequency: route === '/' ? 'weekly' : 'monthly',
    priority: route === '/' ? 1 : 0.7,
  }));
}
