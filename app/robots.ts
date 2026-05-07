import type { MetadataRoute } from 'next';

import { metadataSiteOrigin } from '@/lib/metadata-site-url';

export default function robots(): MetadataRoute.Robots {
  const baseUrl = metadataSiteOrigin();

  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/api', '/dashboard', '/review', '/settings'],
    },
    sitemap: `${baseUrl}/sitemap.xml`,
  };
}
