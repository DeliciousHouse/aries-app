import type { MetadataRoute } from 'next';

function siteUrl(): string {
  return (
    process.env.APP_BASE_URL ||
    process.env.NEXTAUTH_URL ||
    process.env.AUTH_URL ||
    'https://aries.sugarandleather.com'
  ).replace(/\/+$/, '');
}

export default function robots(): MetadataRoute.Robots {
  const baseUrl = siteUrl();

  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/api/', '/dashboard/', '/review/', '/settings/'],
    },
    sitemap: `${baseUrl}/sitemap.xml`,
  };
}
