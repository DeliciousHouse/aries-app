import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { resolveDataPath } from '@/lib/runtime-paths';

export type TenantBrandLink = {
  platform: string;
  url: string;
};

export type TenantBrandColors = {
  primary: string | null;
  secondary: string | null;
  accent: string | null;
  palette: string[];
};

export type TenantBrandKit = {
  tenant_id: string;
  source_url: string;
  canonical_url: string | null;
  brand_name: string;
  logo_urls: string[];
  colors: TenantBrandColors;
  font_families: string[];
  external_links: TenantBrandLink[];
  extracted_at: string;
};

const SOCIAL_HOSTS: Array<[platform: string, hostname: string]> = [
  ['instagram', 'instagram.com'],
  ['facebook', 'facebook.com'],
  ['x', 'x.com'],
  ['x', 'twitter.com'],
  ['tiktok', 'tiktok.com'],
  ['youtube', 'youtube.com'],
  ['linkedin', 'linkedin.com'],
];
const TENANT_BRAND_KIT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function nowIso(): string {
  return new Date().toISOString();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function normalizeColor(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  return /^#[0-9a-f]{3,8}$/.test(trimmed) ? trimmed : null;
}

function websiteHostname(url: string): string {
  try {
    return new URL(url).hostname.trim().toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

function hostnameRoot(hostname: string): string {
  const parts = hostname.replace(/^www\./, '').split('.').filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join('.') : hostname;
}

function inferBrandName(url: string): string {
  const hostname = websiteHostname(url).replace(/^www\./, '');
  const root = hostname.split('.')[0] || hostname;
  return root
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function resolveAbsoluteUrl(baseUrl: string, candidate: string): string | null {
  const trimmed = candidate.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return null;
  }
}

function extractMetaContent(html: string, attribute: string, key: string): string | null {
  const matches = html.matchAll(/<meta\b([^>]*)>/gi);
  for (const match of matches) {
    const attributes = parseTagAttributes(match[1] || '');
    if ((attributes[attribute] || '').toLowerCase() === key.toLowerCase()) {
      return decodeHtmlEntities((attributes.content || '').trim()) || null;
    }
  }
  return null;
}

function extractTitle(html: string): string | null {
  const title = html.match(/<title>([^<]+)<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim() || null;
  return title ? decodeHtmlEntities(title) : null;
}

function parseTagAttributes(attributesSource: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const matches = attributesSource.matchAll(/([a-zA-Z_:-]+)\s*=\s*["']([^"']*)["']/g);
  for (const match of matches) {
    attributes[match[1].toLowerCase()] = decodeHtmlEntities(match[2]);
  }
  return attributes;
}

function extractLinkCandidates(html: string, relNeedle: string): string[] {
  const matches = html.matchAll(/<link\b([^>]*)>/gi);
  const urls: string[] = [];
  for (const match of matches) {
    const attributes = parseTagAttributes(match[1] || '');
    const rel = (attributes.rel || '').toLowerCase();
    if (rel.includes(relNeedle)) {
      urls.push(attributes.href || '');
    }
  }
  return urls.filter(Boolean);
}

function extractImageCandidates(html: string): string[] {
  const matches = html.matchAll(/<img\b([^>]*)>/gi);
  const urls: string[] = [];
  for (const match of matches) {
    const attributes = parseTagAttributes(match[1] || '');
    if (attributes.src) {
      urls.push(attributes.src);
    }
  }
  return urls;
}

function extractStylesheetUrls(html: string, baseUrl: string): string[] {
  return extractLinkCandidates(html, 'stylesheet')
    .map((candidate) => resolveAbsoluteUrl(baseUrl, candidate))
    .filter((candidate): candidate is string => !!candidate);
}

function extractInlineCss(html: string): string[] {
  return Array.from(
    html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi),
    (match) => match[1]?.trim() || ''
  ).filter(Boolean);
}

function extractFontFamilies(cssBlocks: string[]): string[] {
  const families: string[] = [];

  for (const css of cssBlocks) {
    const matches = css.matchAll(/font-family\s*:\s*([^;}{]+)[;}]?/gi);
    for (const match of matches) {
      const rawFamilies = match[1].split(',').map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''));
      for (const family of rawFamilies) {
        if (!family) continue;
        const normalized = family.toLowerCase();
        if (['serif', 'sans-serif', 'monospace', 'system-ui', 'cursive', 'fantasy'].includes(normalized)) {
          continue;
        }
        families.push(family);
      }
    }
  }

  return unique(families);
}

function extractBrandColors(html: string, cssBlocks: string[]): TenantBrandColors {
  const themeColor = normalizeColor(extractMetaContent(html, 'name', 'theme-color') || '');
  const palette: string[] = [];

  if (themeColor) {
    palette.push(themeColor);
  }

  const customPropertyOrder = ['--brand-primary', '--brand-secondary', '--brand-accent'];
  for (const css of cssBlocks) {
    for (const property of customPropertyOrder) {
      const match = css.match(new RegExp(`${property}\\s*:\\s*(#[0-9a-fA-F]{3,8})`, 'i'));
      const color = normalizeColor(match?.[1] || '');
      if (color) {
        palette.push(color);
      }
    }
  }

  for (const css of cssBlocks) {
    for (const match of css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
      const color = normalizeColor(match[0]);
      if (color) {
        palette.push(color);
      }
    }
  }

  const dedupedPalette = unique(palette);
  return {
    primary: dedupedPalette[0] ?? null,
    secondary: dedupedPalette[1] ?? null,
    accent: dedupedPalette[2] ?? null,
    palette: dedupedPalette,
  };
}

function extractExternalLinks(html: string, baseUrl: string): TenantBrandLink[] {
  const matches = html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>/gi);
  const discovered: TenantBrandLink[] = [];
  const sourceHost = websiteHostname(baseUrl);
  const sourceRoot = hostnameRoot(sourceHost);

  for (const match of matches) {
    const absolute = resolveAbsoluteUrl(baseUrl, match[1]);
    if (!absolute) {
      continue;
    }

    let hostname = '';
    try {
      hostname = new URL(absolute).hostname.toLowerCase();
    } catch {
      continue;
    }

    const platform = SOCIAL_HOSTS.find(([, expectedHost]) => hostname.endsWith(expectedHost))?.[0];
    if (platform) {
      discovered.push({ platform, url: absolute });
      continue;
    }

    if (hostname && hostname !== sourceHost && hostnameRoot(hostname) === sourceRoot) {
      discovered.push({ platform: hostname, url: absolute });
    }
  }

  return unique(discovered.map((entry) => JSON.stringify(entry))).map((entry) => JSON.parse(entry));
}

function dedupeLogoUrls(urls: Array<string | null>): string[] {
  return unique(urls.filter((entry): entry is string => !!entry));
}

async function fetchText(url: string, fetchImpl: typeof fetch): Promise<string | null> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    return null;
  }
  return response.text();
}

function brandKitFallback(tenantId: string, brandUrl: string): TenantBrandKit {
  return {
    tenant_id: tenantId,
    source_url: brandUrl,
    canonical_url: brandUrl,
    brand_name: inferBrandName(brandUrl),
    logo_urls: [],
    colors: {
      primary: null,
      secondary: null,
      accent: null,
      palette: [],
    },
    font_families: [],
    external_links: [],
    extracted_at: nowIso(),
  };
}

function assertTenantBrandKit(brandKit: TenantBrandKit): void {
  if (!brandKit.brand_name?.trim()) {
    throw new Error('invalid_tenant_brand_kit:brand_name_required');
  }
  if (!brandKit.source_url?.trim()) {
    throw new Error('invalid_tenant_brand_kit:source_url_required');
  }
  if (!Number.isFinite(Date.parse(brandKit.extracted_at))) {
    throw new Error('invalid_tenant_brand_kit:extracted_at_invalid');
  }
}

export async function extractBrandKitFromWebsite(input: {
  tenantId: string;
  brandUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<TenantBrandKit> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const fallback = brandKitFallback(input.tenantId, input.brandUrl);

  try {
    const html = await fetchText(input.brandUrl, fetchImpl);
    if (!html) {
      return fallback;
    }

    const stylesheetUrls = extractStylesheetUrls(html, input.brandUrl);
    const stylesheetTexts = (
      await Promise.all(stylesheetUrls.map((url) => fetchText(url, fetchImpl)))
    ).filter((entry): entry is string => !!entry);
    const cssBlocks = [...extractInlineCss(html), ...stylesheetTexts];
    const title = extractTitle(html);
    const ogSiteName = extractMetaContent(html, 'property', 'og:site_name');
    const ogImage = extractMetaContent(html, 'property', 'og:image');
    return {
      tenant_id: input.tenantId,
      source_url: input.brandUrl,
      canonical_url: input.brandUrl,
      brand_name: ogSiteName || title || fallback.brand_name,
      logo_urls: dedupeLogoUrls([
        ...extractLinkCandidates(html, 'icon').map((candidate) => resolveAbsoluteUrl(input.brandUrl, candidate)),
        resolveAbsoluteUrl(input.brandUrl, ogImage || ''),
        ...extractImageCandidates(html)
          .map((candidate) => resolveAbsoluteUrl(input.brandUrl, candidate))
          .filter((candidate) => candidate && /logo|mark|wordmark|brand/i.test(candidate)),
      ]),
      colors: extractBrandColors(html, cssBlocks),
      font_families: extractFontFamilies(cssBlocks),
      external_links: extractExternalLinks(html, input.brandUrl),
      extracted_at: nowIso(),
    };
  } catch {
    return fallback;
  }
}

export function tenantBrandKitPath(tenantId: string): string {
  return resolveDataPath('generated', 'validated', tenantId, 'brand-kit.json');
}

export function loadTenantBrandKit(tenantId: string): TenantBrandKit | null {
  const filePath = tenantBrandKitPath(tenantId);
  if (!existsSync(filePath)) {
    return null;
  }

  const brandKit = JSON.parse(readFileSync(filePath, 'utf8')) as TenantBrandKit;
  assertTenantBrandKit(brandKit);
  return brandKit;
}

function isFreshBrandKit(brandKit: TenantBrandKit, brandUrl: string): boolean {
  const extractedAt = Date.parse(brandKit.extracted_at);
  if (!Number.isFinite(extractedAt)) {
    return false;
  }

  if (brandKit.source_url !== brandUrl) {
    return false;
  }

  const hasExtractedSignals =
    brandKit.logo_urls.length > 0 ||
    brandKit.font_families.length > 0 ||
    brandKit.external_links.length > 0 ||
    brandKit.colors.palette.length > 0;
  if (!hasExtractedSignals) {
    return false;
  }

  return Date.now() - extractedAt <= TENANT_BRAND_KIT_TTL_MS;
}

export function saveTenantBrandKit(tenantId: string, brandKit: TenantBrandKit): string {
  assertTenantBrandKit(brandKit);
  const filePath = tenantBrandKitPath(tenantId);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(brandKit, null, 2));
  return filePath;
}

export async function extractAndSaveTenantBrandKit(input: {
  tenantId: string;
  brandUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<{ brandKit: TenantBrandKit; filePath: string }> {
  const existing = loadTenantBrandKit(input.tenantId);
  if (existing && isFreshBrandKit(existing, input.brandUrl)) {
    return {
      brandKit: existing,
      filePath: tenantBrandKitPath(input.tenantId),
    };
  }

  const brandKit = await extractBrandKitFromWebsite(input);
  const filePath = saveTenantBrandKit(input.tenantId, brandKit);
  return { brandKit, filePath };
}
