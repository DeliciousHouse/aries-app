import { normalizeMarketingWebsiteUrl } from './marketing-public-mode';

const META_HOST_SUFFIXES = ['facebook.com', 'fb.com', 'instagram.com'] as const;
const LOCAL_BLOCKLIST = ['localhost', '127.0.0.1', '0.0.0.0', '[::]', '[::1]'] as const;
const IPV4_HOST_PATTERN = /^(\d{1,3}\.){3}\d{1,3}$/;

export const COMPETITOR_URL_SOCIAL_ERROR =
  "competitor_url must be the competitor's website, not a Facebook or Ad Library URL";
export const COMPETITOR_URL_INVALID_ERROR = 'competitor_url must be a valid HTTPS website URL';

function trimString(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || null;
}

function hostnameFor(value: string | null | undefined): string {
  const normalized = normalizeMarketingWebsiteUrl(value);
  if (!normalized) {
    return '';
  }

  try {
    return new URL(normalized).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function isMetaLocatorHost(hostname: string | null | undefined): boolean {
  const normalized = trimString(hostname)?.toLowerCase() || '';
  if (!normalized) {
    return false;
  }
  return META_HOST_SUFFIXES.some((suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`));
}

export function isMetaLocatorUrl(value: string | null | undefined): boolean {
  const normalized = normalizeMarketingWebsiteUrl(value);
  if (!normalized) {
    return false;
  }

  try {
    const parsed = new URL(normalized);
    const hostname = parsed.hostname.toLowerCase();
    if (isMetaLocatorHost(hostname)) {
      return true;
    }
    return parsed.pathname.toLowerCase().includes('/ads/library');
  } catch {
    return false;
  }
}

export function normalizeMetaLocatorUrl(value: string | null | undefined): string | null {
  return normalizeMarketingWebsiteUrl(value);
}

export function normalizeMetaPageId(value: string | null | undefined): string | null {
  return trimString(value);
}

export function validateCanonicalCompetitorUrl(value: string | null | undefined): {
  normalized: string | null;
  error: string | null;
} {
  const raw = trimString(value);
  if (!raw) {
    return { normalized: null, error: null };
  }

  const normalized = normalizeMarketingWebsiteUrl(raw);
  if (!normalized) {
    return { normalized: null, error: COMPETITOR_URL_INVALID_ERROR };
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return { normalized: null, error: COMPETITOR_URL_INVALID_ERROR };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:') {
    return { normalized: null, error: COMPETITOR_URL_INVALID_ERROR };
  }
  if (LOCAL_BLOCKLIST.some((blocked) => hostname === blocked || hostname.endsWith(`.${blocked}`))) {
    return { normalized: null, error: COMPETITOR_URL_INVALID_ERROR };
  }
  if (IPV4_HOST_PATTERN.test(hostname)) {
    return { normalized: null, error: COMPETITOR_URL_INVALID_ERROR };
  }
  if (isMetaLocatorUrl(normalized)) {
    return { normalized: null, error: COMPETITOR_URL_SOCIAL_ERROR };
  }

  return { normalized, error: null };
}

export function normalizeCanonicalCompetitorUrl(value: string | null | undefined): string | null {
  return validateCanonicalCompetitorUrl(value).normalized;
}

export function sanitizeLegacyCompetitorUrl(value: string | null | undefined): string | null {
  return normalizeCanonicalCompetitorUrl(value);
}

export function competitorDomain(value: string | null | undefined): string {
  const hostname = hostnameFor(value);
  return hostname.replace(/^www\./, '');
}
