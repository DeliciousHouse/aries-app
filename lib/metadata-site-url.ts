export function metadataSiteOrigin(): string {
  const configuredUrl = (
    process.env.APP_BASE_URL ||
    process.env.NEXTAUTH_URL ||
    process.env.AUTH_URL ||
    'https://aries.sugarandleather.com'
  ).replace(/\/+$/, '');

  try {
    return new URL(configuredUrl).origin;
  } catch {
    return configuredUrl;
  }
}
