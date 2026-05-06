/** @type {import('next').NextConfig} */
const nextConfig = {
  turbopack: {
    root: process.cwd(),
  },
  images: {
    remotePatterns: buildRemotePatterns(),
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
