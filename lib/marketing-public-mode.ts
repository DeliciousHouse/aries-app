export function isMarketingPublicMode(): boolean {
  const raw = process.env.MARKETING_STATUS_PUBLIC?.trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

function trimOrNull(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || null;
}

export function normalizeMarketingWebsiteUrl(value: string | null | undefined): string | null {
  const raw = trimOrNull(value);
  if (!raw) {
    return null;
  }

  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;

  try {
    const parsed = new URL(candidate);
    parsed.hash = '';
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    if (!parsed.pathname) {
      parsed.pathname = '/';
    }
    if (parsed.pathname !== '/') {
      parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    }
    if ((parsed.protocol === 'https:' && parsed.port === '443') || (parsed.protocol === 'http:' && parsed.port === '80')) {
      parsed.port = '';
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

// Compatibility exports for older generated artifacts only. The live customer onboarding
// path no longer uses website-derived public tenant identity.
export function derivePublicMarketingTenantId(websiteUrl: string | null | undefined): string | null {
  const normalized = normalizeMarketingWebsiteUrl(websiteUrl);
  if (!normalized) {
    return null;
  }

  try {
    const hostname = new URL(normalized).hostname.replace(/^www\./, '');
    const slug = hostname
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return slug ? `public_${slug}` : 'public_campaign';
  } catch {
    return 'public_campaign';
  }
}

export function publicTenantSlug(tenantId: string): string {
  const normalized = tenantId.trim().toLowerCase();
  return normalized.replace(/^public_/, '') || normalized;
}
