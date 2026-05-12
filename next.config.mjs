const SECURITY_HEADERS = [
  // Force HTTPS for one year incl. subdomains. Two-year preload-eligible value
  // is intentionally not used here yet — confirm subdomain HTTPS coverage first.
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
  // Block framing entirely; CSP frame-ancestors is the modern equivalent but
  // X-Frame-Options is still respected by older Safari/IE chains.
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Disable common high-risk APIs nobody on this app uses today.
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
  // Report-only first. Promote to enforced CSP once Next.js inline-bootstrap
  // and image domains are confirmed compatible.
  {
    key: 'Content-Security-Policy-Report-Only',
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self' data:",
      "connect-src 'self' https:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Suppress `x-powered-by: Next.js` info-disclosure header.
  poweredByHeader: false,
  turbopack: {
    root: process.cwd(),
  },
  images: {
    remotePatterns: buildRemotePatterns(),
  },
  async headers() {
    return [
      { source: '/:path*', headers: SECURITY_HEADERS },
    ];
  },
  async redirects() {
    return [
      // QA 2026-05-12 ISSUE-003: /platforms was an auth-gated stub that just
      // bounced to /dashboard/settings. Replace the page-level redirect with a
      // proper config-level 307 so the route is not in the auth-gate list.
      { source: '/platforms', destination: '/dashboard/settings', permanent: false },
      // QA 2026-05-12 ISSUE-010 (PRD-audit rename): "campaign" -> "social
      // content". Legacy URL still resolves for outstanding bookmarks/emails.
      // 308 permanent so caches and intermediaries adopt the new canonical.
      { source: '/dashboard/campaigns', destination: '/dashboard/social-content', permanent: true },
      { source: '/dashboard/campaigns/:path*', destination: '/dashboard/social-content/:path*', permanent: true },
    ];
  },
};

function buildRemotePatterns() {
  const patterns = [];

  // Always allow localhost for development
  patterns.push({ protocol: 'https', hostname: 'localhost' });
  patterns.push({ protocol: 'http', hostname: 'localhost' });

  // Extract hostname from HERMES_GATEWAY_URL
  if (process.env.HERMES_GATEWAY_URL) {
    try {
      const hermesUrl = new URL(process.env.HERMES_GATEWAY_URL);
      const hermesHostname = hermesUrl.hostname;
      if (hermesHostname) {
        patterns.push({ protocol: 'https', hostname: hermesHostname });
        patterns.push({ protocol: 'http', hostname: hermesHostname });
      }
    } catch (e) {
      // Invalid URL, skip
    }
  }

  // Extract hostname from APP_BASE_URL
  if (process.env.APP_BASE_URL) {
    try {
      const appUrl = new URL(process.env.APP_BASE_URL);
      const appHostname = appUrl.hostname;
      if (appHostname) {
        patterns.push({ protocol: 'https', hostname: appHostname });
        patterns.push({ protocol: 'http', hostname: appHostname });
      }
    } catch (e) {
      // Invalid URL, skip
    }
  }

  // Use IMAGES_CDN_HOST directly if set
  if (process.env.IMAGES_CDN_HOST) {
    patterns.push({ protocol: 'https', hostname: process.env.IMAGES_CDN_HOST });
    patterns.push({ protocol: 'http', hostname: process.env.IMAGES_CDN_HOST });
  }

  return patterns;
}

export default nextConfig;
