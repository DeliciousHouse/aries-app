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
  brand_voice_summary: string | null;
  offer_summary: string | null;
};

export type BrandKitSignalsInput = {
  logo_urls?: string[] | null;
  colors?: Partial<TenantBrandColors> | null;
  font_families?: string[] | null;
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
const GENERIC_FONT_NAMES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'system-ui',
  'ui-sans-serif',
  'ui-serif',
  'ui-monospace',
  'cursive',
  'fantasy',
  'emoji',
  'math',
  'fangsong',
  'inherit',
  'initial',
  'unset',
  '-apple-system',
  'blinkmacsystemfont',
  'segoe ui',
  'helvetica',
  'helvetica neue',
  'arial',
  'sans',
  'system',
]);
const OFFER_KEYWORDS = [
  'coaching',
  'program',
  'membership',
  'course',
  'shop',
  'book',
  'apply',
  'join',
  'subscribe',
  'buy',
  'schedule',
  'consult',
  'free',
  'sale',
  'offer',
  'service',
];
const CTA_KEYWORDS = [
  'book',
  'apply',
  'join',
  'shop',
  'start',
  'schedule',
  'learn',
  'watch',
  'discover',
  'browse',
  'contact',
];
const PREVIEW_ATTRIBUTE_PATTERN = /\b(?:class|className|style|id|href|src|data-[\w-]+)\s*=\s*["'][^"']*["']/gi;
const PREVIEW_UTILITY_TOKEN_PATTERN =
  /\b(?:bg|text|font|tracking|max-w|min-w|min-h|max-h|from|via|to|px|py|pt|pr|pb|pl|mx|my|mt|mr|mb|ml|grid|flex|gap|items|justify|rounded|shadow|ring|border|leading|sm:|md:|lg:|xl:|2xl:|hover:|focus:|before:|after:|group-hover:)[^\s,;)]*/gi;
const PREVIEW_CSS_REMNANT_PATTERN = /(?:^|\s)(?:[#.][a-z0-9_-]+|::?[a-z-]+|@media|var\(--[^)]+\)|theme\([^)]+\)|calc\([^)]+\))/gi;

function includesKeywordPhrase(value: string, keywords: string[]): boolean {
  const normalized = value.toLowerCase();
  return keywords.some((keyword) => new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(normalized));
}

function nowIso(): string {
  return new Date().toISOString();
}

// Named entity table — covers the common set found across modern marketing
// sites (Nike, Adidas, Stripe, Shopify, etc.). Keep this list curated; do not
// expand to the full HTML5 named-entity spec without a benchmark — the table
// lookup is on the hot path for every brand-kit extraction.
const NAMED_ENTITY_TABLE: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  hellip: '\u2026',
  mdash: '\u2014',
  ndash: '\u2013',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  bull: '\u2022',
  middot: '\u00b7',
  laquo: '\u00ab',
  raquo: '\u00bb',
};

// Decode HTML entities — handles named (&amp;), decimal (&#39;), and hex
// (&#x27;) forms in a single pass. Crucially, this MUST run before any other
// regex that could split a `&#xNN;` token into `& xNN;` (which is exactly the
// `& x27;` artifact users were seeing in brand voice / revision notes).
function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+[0-9]?);/gi, (match, body) => {
    const lower = body.toLowerCase();
    if (lower.startsWith('#x')) {
      const code = parseInt(lower.slice(2), 16);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try { return String.fromCodePoint(code); } catch { return match; }
      }
      return match;
    }
    if (lower.startsWith('#')) {
      const code = parseInt(lower.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try { return String.fromCodePoint(code); } catch { return match; }
      }
      return match;
    }
    const named = NAMED_ENTITY_TABLE[lower];
    return named !== undefined ? named : match;
  });
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function normalizeWhitespace(value: string): string {
  // ISSUE-004: when inline tags like `<em>` are stripped upstream, the tag
  // boundary is replaced with a space so adjacent words don't fuse. The
  // resulting text can contain space-before-punctuation artifacts such as
  // `innovative products , experiences` (orphan ` , `) or `wait .` (space
  // before period). After collapsing whitespace, drop a single whitespace
  // run that sits directly before sentence punctuation, then collapse
  // accidental repeated commas. URLs and ellipses are unaffected because
  // they have no space immediately before the punctuation.
  return decodeHtmlEntities(value)
    .replace(/\s+/g, ' ')
    .replace(/ ([,.;:!?])/g, '$1')
    .replace(/,(\s*,)+/g, ',')
    .trim();
}

// Decode entities FIRST, then strip nested tags (including framework markers
// like Angular's `_ngcontent-*` and raw `style="..."` / `class="..."` attribute
// remnants). The order matters: if we tag-stripped before decoding, entity-
// encoded markup like `&lt;span&gt;...` would survive the tag pass and then
// become literal `<span>` text after decode, re-introducing the raw-HTML leak
// this helper exists to prevent. Applied wherever we pull visible text out of
// a tag's inner HTML — titles, h1s, image alts.
function stripHtmlTags(value: string): string {
  // Closing tags use `<\/name\b[^>]*>` instead of `<\/name>` so HTML variants
  // that include trailing whitespace or attributes on the close tag (e.g.
  // `</script >`, `</style foo>`) are still recognized. The narrow
  // `<\/name>` form leaves the script/style body intact as literal text,
  // which is what CodeQL's "Bad HTML filtering regexp" rule flags.
  return decodeHtmlEntities(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\b[^>]*>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeColor(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed === 'transparent') {
    return null;
  }
  if (/^#[0-9a-f]{3}$/.test(trimmed)) {
    return `#${trimmed.slice(1).split('').map((digit) => digit.repeat(2)).join('')}`;
  }
  if (!/^#[0-9a-f]{6}$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function hexChannels(value: string): [number, number, number] | null {
  const normalized = normalizeColor(value);
  if (!normalized) {
    return null;
  }
  return [
    Number.parseInt(normalized.slice(1, 3), 16),
    Number.parseInt(normalized.slice(3, 5), 16),
    Number.parseInt(normalized.slice(5, 7), 16),
  ];
}

function colorSpread(value: string): number {
  const channels = hexChannels(value);
  if (!channels) {
    return 0;
  }
  return Math.max(...channels) - Math.min(...channels);
}

function isNeutralColor(value: string): boolean {
  return colorSpread(value) < 16;
}

function colorHueBucket(value: string): number | null {
  const channels = hexChannels(value);
  if (!channels || isNeutralColor(value)) {
    return null;
  }

  const [red, green, blue] = channels;
  if (red >= green && red >= blue) {
    return green >= blue ? 0 : 5;
  }
  if (green >= red && green >= blue) {
    return blue >= red ? 2 : 1;
  }
  return red >= green ? 4 : 3;
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

function domainTokens(url: string): string[] {
  const hostname = websiteHostname(url).replace(/^www\./, '');
  const root = hostname.split('.')[0] || hostname;
  return root
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map((token) => token.toLowerCase());
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

function parseTagAttributes(attributesSource: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const matches = attributesSource.matchAll(/([a-zA-Z_:-]+)\s*=\s*["']([^"']*)["']/g);
  for (const match of matches) {
    attributes[match[1].toLowerCase()] = decodeHtmlEntities(match[2]);
  }
  return attributes;
}

function extractMetaContent(html: string, attribute: string, key: string): string | null {
  const matches = html.matchAll(/<meta\b([^>]*)>/gi);
  for (const match of matches) {
    const attributes = parseTagAttributes(match[1] || '');
    if ((attributes[attribute] || '').toLowerCase() === key.toLowerCase()) {
      const content = normalizeWhitespace(attributes.content || '');
      return content || null;
    }
  }
  return null;
}

function extractTitle(html: string): string | null {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
  return stripHtmlTags(title) || null;
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

function extractCanonicalUrl(html: string, baseUrl: string): string | null {
  const raw = extractLinkCandidates(html, 'canonical')[0] || '';
  return raw ? resolveAbsoluteUrl(baseUrl, raw) : null;
}

function extractImageCandidates(html: string): Array<{ url: string; alt: string }> {
  const matches = html.matchAll(/<img\b([^>]*)>/gi);
  const urls: Array<{ url: string; alt: string }> = [];
  for (const match of matches) {
    const attributes = parseTagAttributes(match[1] || '');
    if (attributes.src) {
      urls.push({
        url: attributes.src,
        alt: normalizeWhitespace(attributes.alt || ''),
      });
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
    html.matchAll(/<style[^>]*>([\s\S]*?)<\/style\b[^>]*>/gi),
    (match) => match[1]?.trim() || '',
  ).filter(Boolean);
}

function extractTextByTag(html: string, tagName: string): string[] {
  return Array.from(
    html.matchAll(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'gi')),
    (match) => stripHtmlTags(match[1] || ''),
  ).filter(Boolean);
}

function htmlToText(html: string): string {
  return normalizeWhitespace(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, ' ')
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\b[^>]*>/gi, ' ')
      .replace(/<svg\b[^>]*>[\s\S]*?<\/svg\b[^>]*>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  );
}

function cleanSentenceCandidate(value: string | null | undefined, maxLength = 220): string | null {
  const normalized = normalizeWhitespace(
    (value || '')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, ' ')
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\b[^>]*>/gi, ' ')
      .replace(/<svg\b[^>]*>[\s\S]*?<\/svg\b[^>]*>/gi, ' ')
      .replace(PREVIEW_ATTRIBUTE_PATTERN, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(PREVIEW_UTILITY_TOKEN_PATTERN, ' ')
      .replace(PREVIEW_CSS_REMNANT_PATTERN, ' ')
      .replace(/[`*_#>{}[\]|]/g, ' '),
  );
  if (!normalized) {
    return null;
  }
  if (
    /(?:<|>|class=|classname=|bg-clip-text|bg-gradient|tracking-\[|from-\[#|via-\[#|to-\[#|var\(--|@media)/i.test(normalized)
  ) {
    return null;
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength).trimEnd()}...`;
}

export function sanitizeBrandKitSummaryText(value: string | null | undefined, maxLength = 220): string | null {
  return cleanSentenceCandidate(value, maxLength);
}

function normalizeFontFamilyCandidate(value: string): string | null {
  const cleaned = value
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/[);]+$/g, '')
    .trim();
  if (!cleaned) {
    return null;
  }
  const normalized = cleaned.toLowerCase();
  if (
    GENERIC_FONT_NAMES.has(normalized) ||
    normalized.startsWith('var(') ||
    normalized.startsWith('--') ||
    normalized.includes('var(--') ||
    normalized.includes('!important') ||
    normalized.includes('system') ||
    normalized.includes('fallback') ||
    normalized.includes('emoji') ||
    normalized.includes('symbol') ||
    normalized.includes('mono') ||
    normalized.includes('courier') ||
    normalized.includes('consolas') ||
    normalized.includes('menlo') ||
    normalized.includes('monaco') ||
    normalized.includes('sfmono') ||
    normalized.includes('liberation mono')
  ) {
    return null;
  }
  return cleaned;
}

function extractFontFamilies(cssBlocks: string[]): string[] {
  const families: string[] = [];

  for (const css of cssBlocks) {
    const matches = css.matchAll(/font-family\s*:\s*([^;}{]+)[;}]?/gi);
    for (const match of matches) {
      const rawFamilies = match[1].split(',');
      for (const rawFamily of rawFamilies) {
        const family = normalizeFontFamilyCandidate(rawFamily);
        if (family) {
          families.push(family);
        }
      }
    }
  }

  return unique(families);
}

function weightedHtmlColors(html: string): Array<[string, number]> {
  const counts = new Map<string, number>();
  const patterns: Array<[RegExp, number]> = [
    [/from-\[#([0-9a-fA-F]{6,8})\]/g, 6],
    [/via-\[#([0-9a-fA-F]{6,8})\]/g, 4],
    [/to-\[#([0-9a-fA-F]{6,8})\]/g, 5],
    [/(?:bg|text|border)-\[#([0-9a-fA-F]{6,8})\]/g, 2],
    [/style=["'][^"']*#[0-9a-fA-F]{3,8}[^"']*["']/gi, 2],
  ];

  for (const [pattern, weight] of patterns) {
    for (const match of html.matchAll(pattern)) {
      const raw = typeof match[1] === 'string'
        ? match[1]
        : (match[0].match(/#[0-9a-fA-F]{3,8}/)?.[0] || '');
      const color = normalizeColor(raw.startsWith('#') ? raw : `#${raw}`);
      if (!color) {
        continue;
      }
      counts.set(color, (counts.get(color) || 0) + weight);
    }
  }

  const entries = [...counts.entries()].sort((left, right) => right[1] - left[1]);
  const colorful = entries.filter(([color]) => !isNeutralColor(color));
  return (colorful.length > 0 ? colorful : entries).slice(0, 6);
}

function extractBrandColors(html: string, cssBlocks: string[]): TenantBrandColors {
  const palette: string[] = [];
  const htmlColors = weightedHtmlColors(html).map(([color]) => color);

  if (htmlColors.length > 0) {
    palette.push(...htmlColors);
  }

  const themeColor = normalizeColor(extractMetaContent(html, 'name', 'theme-color') || '');

  if (themeColor && palette.length === 0) {
    palette.push(themeColor);
  }

  for (const css of cssBlocks) {
    for (const match of css.matchAll(/--(?:(?:brand|color-brand)[\w-]*|primary|secondary|accent)\s*:\s*([^;}{]+)/gi)) {
      const color = normalizeColor(match[1] || '');
      if (color) {
        palette.push(color);
      }
    }
  }

  if (palette.length === 0) {
    for (const css of cssBlocks) {
      for (const match of css.matchAll(/#[0-9a-fA-F]{3,6}\b/g)) {
        const color = normalizeColor(match[0]);
        if (color) {
          palette.push(color);
        }
        if (unique(palette).length >= 6) {
          break;
        }
      }
      if (unique(palette).length >= 6) {
        break;
      }
    }
  }

  const dedupedPalette = unique(palette).slice(0, 6);
  const colorfulPalette = dedupedPalette.filter((value) => !isNeutralColor(value));
  const prioritizedPalette = colorfulPalette.length >= 2
    ? [...colorfulPalette, ...dedupedPalette.filter((value) => isNeutralColor(value))]
    : dedupedPalette;

  return {
    primary: prioritizedPalette[0] ?? null,
    secondary: prioritizedPalette[1] ?? null,
    accent: prioritizedPalette[2] ?? null,
    palette: prioritizedPalette,
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

  return dedupeBrandLinks(discovered);
}

// Dedupe by hostname+pathname (ignoring query/fragment). Preserves first-seen
// order. When duplicates collide, keeps the shortest URL string. See
// ISSUE-008: visible brand links must not list the same hostname+path multiple
// times when only query strings or fragments differ.
function dedupeBrandLinks(links: TenantBrandLink[]): TenantBrandLink[] {
  const order: string[] = [];
  const byKey = new Map<string, TenantBrandLink>();

  for (const link of links) {
    let key: string;
    try {
      const parsed = new URL(link.url);
      key = `${link.platform}|${parsed.hostname.toLowerCase()}${parsed.pathname || '/'}`;
    } catch {
      key = `${link.platform}|${link.url}`;
    }

    const existing = byKey.get(key);
    if (!existing) {
      order.push(key);
      byKey.set(key, link);
      continue;
    }

    if (link.url.length < existing.url.length) {
      byKey.set(key, link);
    }
  }

  return order.map((key) => byKey.get(key)!).filter(Boolean);
}

function brandNameScore(candidate: string, url: string): number {
  const normalized = normalizeWhitespace(candidate);
  if (!normalized) {
    return -1;
  }

  const tokens = domainTokens(url);
  const normalizedTokens = normalized.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const overlap = normalizedTokens.filter((token) => tokens.some((domainToken) => domainToken.includes(token) || token.includes(domainToken))).length;
  const separatorPenalty = /[|•]/.test(normalized) ? 3 : 0;
  const lengthPenalty = normalized.length > 60 ? 2 : 0;
  return overlap * 10 - separatorPenalty - lengthPenalty;
}

function cleanBrandNameCandidate(candidate: string, url: string): string | null {
  // Defense in depth: if a candidate arrives with nested HTML (because an
  // upstream extractor returned raw inner HTML instead of visible text),
  // strip it here before scoring. Otherwise brand_name can persist as a
  // literal `<span ...>Welcome to </span><span ...>N</span>...` blob and
  // leak into the brand identity preview / font preview cards.
  const normalized = stripHtmlTags(candidate);
  if (!normalized) {
    return null;
  }

  const segments = normalized
    .split(/\s+[|•-]\s+/)
    .map((segment) => normalizeWhitespace(segment))
    .filter(Boolean);

  if (segments.length === 0) {
    return null;
  }

  const best = segments
    .map((segment) => ({ segment, score: brandNameScore(segment, url) }))
    .sort((left, right) => right.score - left.score || left.segment.length - right.segment.length)[0];

  return best?.segment || normalized;
}

function chooseBrandName(candidates: Array<string | null | undefined>, url: string): string | null {
  const cleaned = candidates
    .map((candidate) => cleanBrandNameCandidate(candidate || '', url))
    .filter((candidate): candidate is string => !!candidate);
  if (cleaned.length === 0) {
    return null;
  }

  return cleaned
    .map((candidate) => ({ candidate, score: brandNameScore(candidate, url) }))
    .sort((left, right) => right.score - left.score || left.candidate.length - right.candidate.length)[0]
    ?.candidate || null;
}

const THIRD_PARTY_LOGO_HOSTS: string[] = [
  'vercel.com',
  'vercel.app',
  'assets.vercel.com',
  'cdn.vercel-insights.com',
  'nextjs.org',
  'netlify.com',
  'app.netlify.com',
  'cloudflare.com',
  'gstatic.com',
  'google.com',
  'googletagmanager.com',
  'facebook.com',
  'fbcdn.net',
  'twitter.com',
  'linkedin.com',
  'licdn.com',
];

const THIRD_PARTY_LOGO_PATTERNS: RegExp[] = [
  /vercel-logotype/i,
  /powered-by-vercel/i,
  /next-logo/i,
  /netlify-.*-badge/i,
  /cf-logo/i,
];

export function isLikelyFirstPartyLogo(candidateUrl: string, brandUrl: string): boolean {
  const trimmed = candidateUrl.trim();
  if (!trimmed) {
    return false;
  }

  // Detect URL scheme. Relative URLs (no scheme) are first-party by definition.
  // Non-http(s) schemes (javascript:, data:, mailto:, file:, tel:, etc.) must
  // be rejected outright — we never want to surface those as brand logos.
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
  if (!schemeMatch) {
    return true;
  }
  const scheme = schemeMatch[1].toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') {
    return false;
  }

  let candidateHostname: string;
  let candidatePath: string;
  try {
    const parsed = new URL(trimmed);
    candidateHostname = parsed.hostname.toLowerCase();
    candidatePath = parsed.pathname + parsed.search;
  } catch {
    return false;
  }

  let brandHostname: string;
  try {
    brandHostname = new URL(brandUrl).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    brandHostname = '';
  }

  const normalizedCandidateHost = candidateHostname.replace(/^www\./, '');

  if (
    brandHostname &&
    (normalizedCandidateHost === brandHostname || normalizedCandidateHost.endsWith(`.${brandHostname}`))
  ) {
    return true;
  }

  for (const pattern of THIRD_PARTY_LOGO_PATTERNS) {
    if (pattern.test(candidatePath)) {
      return false;
    }
  }

  for (const blockedHost of THIRD_PARTY_LOGO_HOSTS) {
    if (normalizedCandidateHost === blockedHost || normalizedCandidateHost.endsWith(`.${blockedHost}`)) {
      return false;
    }
  }

  return true;
}

type LogoCandidate = {
  url: string;
  score: number;
};

function scoreLogoCandidate(input: {
  url: string;
  alt?: string;
  rel?: string;
  className?: string;
  source: 'img' | 'link' | 'og' | 'svg';
}): number {
  const lowerUrl = input.url.toLowerCase();
  const alt = normalizeWhitespace(input.alt || '').toLowerCase();
  const className = (input.className || '').toLowerCase();
  const LOGO_SIGNAL_RE = /logo|wordmark|logotype|lockup|brandlogo|brand-logo|brandmark|logo-mark|logo mark/;
  const explicitLogoSignal =
    LOGO_SIGNAL_RE.test(lowerUrl) ||
    LOGO_SIGNAL_RE.test(alt) ||
    /\blogo\b|\bbrand\b|wordmark|logotype|lockup|brandmark/.test(className);
  let score = 0;

  if (input.source === 'img') score += 20;
  if (input.source === 'svg') score += 30;
  if (input.source === 'og') score += 8;
  if (input.source === 'link') score -= 20;
  if (input.source === 'img' && !explicitLogoSignal) score -= 40;
  if (input.source === 'og' && !explicitLogoSignal) score -= 20;
  if (explicitLogoSignal) {
    score += 80;
  }
  if (/social-card|socialcard|og-image|open-graph|hero|team|testimonial|avatar|profile|founder|portrait|headshot/.test(lowerUrl)) {
    score -= 80;
  }
  if (/favicon|apple-touch-icon|mask-icon|mstile|android-chrome|icon-16|icon-32|icon-48/.test(lowerUrl)) {
    score -= 100;
  }
  if (!explicitLogoSignal && /icon/.test(input.rel || '')) {
    score -= 40;
  }
  if (/\.(svg|png|webp|jpg|jpeg)$/i.test(lowerUrl)) {
    score += 6;
  }

  return score;
}

// Extract inline <svg> blocks from <nav>/<header> containers when the <svg>
// tag itself carries a logo/brand class or aria-label. Returns each as a
// `data:image/svg+xml;utf8,...` URL so the frontend can render it via an
// <img> tag without a separate network fetch. This is how sites like Nike
// ship their header wordmark — an inline SVG with class="logo" — so without
// this path we would never surface a logo candidate for them.
function extractHeaderNavSvgLogos(html: string): string[] {
  const results: string[] = [];
  const containerRegex = /<(nav|header)\b[^>]*>([\s\S]*?)<\/\1\b[^>]*>/gi;
  for (const containerMatch of html.matchAll(containerRegex)) {
    const inner = containerMatch[2] || '';
    const svgRegex = /<svg\b([^>]*)>([\s\S]*?)<\/svg\b[^>]*>/gi;
    for (const svgMatch of inner.matchAll(svgRegex)) {
      const attrs = parseTagAttributes(svgMatch[1] || '');
      const className = (attrs.class || '').toLowerCase();
      const ariaLabel = (attrs['aria-label'] || '').toLowerCase();
      const role = (attrs.role || '').toLowerCase();
      const hasLogoClass = /\blogo\b|\bbrand\b|wordmark|logotype|lockup|brandmark/.test(className);
      const hasLogoAria = /logo|brand|wordmark/.test(ariaLabel);
      if (!hasLogoClass && !hasLogoAria && role !== 'img') {
        continue;
      }
      const rawSvg = `<svg${svgMatch[1]}>${svgMatch[2]}</svg>`;
      results.push(`data:image/svg+xml;utf8,${encodeURIComponent(rawSvg)}`);
    }
  }
  return results;
}

function extractLogoUrls(html: string, baseUrl: string): string[] {
  const candidates: LogoCandidate[] = [];
  const ogImage = extractMetaContent(html, 'property', 'og:image');
  const ogImageUrl = resolveAbsoluteUrl(baseUrl, ogImage || '');
  if (ogImageUrl && isLikelyFirstPartyLogo(ogImageUrl, baseUrl)) {
    candidates.push({
      url: ogImageUrl,
      score: scoreLogoCandidate({ url: ogImageUrl, source: 'og' }),
    });
  }

  for (const match of html.matchAll(/<link\b([^>]*)>/gi)) {
    const attributes = parseTagAttributes(match[1] || '');
    const rel = (attributes.rel || '').toLowerCase();
    if (!/\b(icon|shortcut icon|apple-touch-icon|mask-icon|fluid-icon)\b/.test(rel)) {
      continue;
    }
    const href = resolveAbsoluteUrl(baseUrl, attributes.href || '');
    if (!href) {
      continue;
    }
    if (!isLikelyFirstPartyLogo(href, baseUrl)) {
      continue;
    }
    candidates.push({
      url: href,
      score: scoreLogoCandidate({ url: href, rel: attributes.rel, source: 'link' }),
    });
  }

  for (const match of html.matchAll(/<img\b([^>]*)>/gi)) {
    const attributes = parseTagAttributes(match[1] || '');
    if (!attributes.src) {
      continue;
    }
    const href = resolveAbsoluteUrl(baseUrl, attributes.src);
    if (!href) {
      continue;
    }
    if (!isLikelyFirstPartyLogo(href, baseUrl)) {
      continue;
    }
    candidates.push({
      url: href,
      score: scoreLogoCandidate({
        url: href,
        alt: attributes.alt,
        className: attributes.class,
        source: 'img',
      }),
    });
  }

  for (const svgDataUrl of extractHeaderNavSvgLogos(html)) {
    candidates.push({
      url: svgDataUrl,
      score: scoreLogoCandidate({ url: 'logo-svg', className: 'logo', source: 'svg' }),
    });
  }

  const sorted = candidates.sort((left, right) => right.score - left.score);
  const explicit = sorted.filter((candidate) => candidate.score >= 40);
  if (explicit.length > 0) {
    return unique(explicit.map((candidate) => candidate.url)).slice(0, 2);
  }
  // No explicit-signal logos. Fall back to whatever we have (favicons via
  // <link rel=icon>, og:image). Ordering: highest score first, which keeps
  // the scoring function's existing preferences intact (e.g. og beats
  // favicon when both are present and both lack an explicit signal).
  return unique(sorted.map((candidate) => candidate.url)).slice(0, 3);
}

function likelyCtas(html: string): string[] {
  const texts = [
    ...extractTextByTag(html, 'button'),
    ...extractTextByTag(html, 'a'),
  ]
    .map((text) => normalizeWhitespace(text))
    .filter((text) => text.length > 1 && text.length <= 90);

  return unique(
    texts.filter((text) => includesKeywordPhrase(text, CTA_KEYWORDS)).slice(0, 4),
  );
}

function deriveBrandVoiceSummary(html: string): string | null {
  const metaDescription = cleanSentenceCandidate(
    extractMetaContent(html, 'name', 'description') || extractMetaContent(html, 'property', 'og:description'),
  );
  const headings = [
    ...extractTextByTag(html, 'h1'),
    ...extractTextByTag(html, 'h2'),
  ].filter(Boolean);
  const hero = cleanSentenceCandidate(headings[0] || null, 140);
  const ctas = likelyCtas(html);

  if (!metaDescription && !hero) {
    return null;
  }

  const parts = [metaDescription, hero].filter((part, index, array) => !!part && array.indexOf(part) === index) as string[];
  if (ctas.length > 0) {
    parts.push(`Calls to action include ${ctas.slice(0, 3).join(', ')}.`);
  }
  return parts.join(' ').trim() || null;
}

function deriveOfferSummary(html: string): string | null {
  const descriptiveCandidates = [
    extractMetaContent(html, 'name', 'description'),
    extractMetaContent(html, 'property', 'og:description'),
    ...extractTextByTag(html, 'h1'),
    ...extractTextByTag(html, 'h2'),
    ...extractTextByTag(html, 'p'),
  ]
    .map((candidate) => cleanSentenceCandidate(candidate, 200))
    .filter((candidate): candidate is string => !!candidate);

  const descriptiveMatch =
    descriptiveCandidates.find(
      (candidate) =>
        includesKeywordPhrase(candidate, OFFER_KEYWORDS) &&
        (candidate.length >= 24 || candidate.split(/\s+/).length >= 4),
    ) || null;

  if (descriptiveMatch) {
    return descriptiveMatch;
  }

  const ctaCandidates = [...extractTextByTag(html, 'a'), ...extractTextByTag(html, 'button')]
    .map((candidate) => cleanSentenceCandidate(candidate, 120))
    .filter((candidate): candidate is string => !!candidate);

  return (
    ctaCandidates.find(
      (candidate) =>
        includesKeywordPhrase(candidate, OFFER_KEYWORDS) &&
        candidate.length >= 18 &&
        candidate.split(/\s+/).length >= 3,
    ) || null
  );
}

async function fetchText(
  url: string,
  fetchImpl: typeof fetch,
  accept = 'text/html,application/xhtml+xml,text/css;q=0.9,*/*;q=0.8',
): Promise<string | null> {
  const response = await fetchImpl(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; AriesBot/1.0)',
      Accept: accept,
    },
  });
  if (!response.ok) {
    return null;
  }

  const contentType = response.headers.get('content-type') || '';
  if (!/text\/|application\/(json|xml|xhtml\+xml)/i.test(contentType)) {
    return null;
  }

  return response.text();
}

function normalizeLogoUrls(urls: string[]): string[] {
  const candidates = urls
    .map((url) => ({
      url,
      score: scoreLogoCandidate({
        url,
        source: url.startsWith('data:image/svg') ? 'svg' : 'img',
        className: url.startsWith('data:image/svg') ? 'logo' : undefined,
      }),
    }))
    .sort((left, right) => right.score - left.score);
  const explicit = candidates.filter((candidate) => candidate.score >= 40);
  if (explicit.length > 0) {
    return unique(explicit.map((candidate) => candidate.url)).slice(0, 2);
  }
  // No explicit-signal logos — keep the fallback candidates (og:image,
  // favicons, generic <img>) so the frontend has something to render.
  // Mirror extractLogoUrls: highest score first, cap at 3.
  return unique(candidates.map((candidate) => candidate.url)).slice(0, 3);
}

function normalizeBrandColors(colors: Partial<TenantBrandColors> | null | undefined): TenantBrandColors {
  const palette = unique([
    normalizeColor(colors?.primary || '') || '',
    normalizeColor(colors?.secondary || '') || '',
    normalizeColor(colors?.accent || '') || '',
    ...((colors?.palette || []).map((value) => normalizeColor(value) || '')),
  ].filter(Boolean)).slice(0, 6);

  return {
    primary: palette[0] ?? null,
    secondary: palette[1] ?? null,
    accent: palette[2] ?? null,
    palette,
  };
}

function normalizeFontFamilies(families: string[]): string[] {
  return unique(families.map((value) => normalizeFontFamilyCandidate(value) || '').filter(Boolean)).slice(0, 4);
}

export function normalizeBrandKitSignals(input: BrandKitSignalsInput | null | undefined): {
  logo_urls: string[];
  colors: TenantBrandColors;
  font_families: string[];
} {
  return {
    logo_urls: normalizeLogoUrls(input?.logo_urls || []),
    colors: normalizeBrandColors(input?.colors),
    font_families: normalizeFontFamilies(input?.font_families || []),
  };
}

function normalizePersistedBrandKit(brandKit: TenantBrandKit): TenantBrandKit {
  const normalizedSignals = normalizeBrandKitSignals(brandKit);
  // Re-sanitize brand_name on load so brand-kit.json files written before
  // the HTML-stripping fix don't keep rendering raw markup in the preview.
  // Fall back to the original trimmed value if sanitization would empty it —
  // assertTenantBrandKit rejects empty brand names.
  const sanitizedBrandName =
    cleanBrandNameCandidate(brandKit.brand_name || '', brandKit.source_url || '') ||
    normalizeWhitespace(brandKit.brand_name || '');
  return {
    tenant_id: brandKit.tenant_id,
    source_url: brandKit.source_url,
    canonical_url: brandKit.canonical_url ?? null,
    brand_name: sanitizedBrandName,
    logo_urls: normalizedSignals.logo_urls,
    colors: normalizedSignals.colors,
    font_families: normalizedSignals.font_families,
    external_links: Array.isArray(brandKit.external_links) ? brandKit.external_links : [],
    extracted_at: brandKit.extracted_at,
    brand_voice_summary: cleanSentenceCandidate((brandKit as TenantBrandKit).brand_voice_summary || null),
    offer_summary: cleanSentenceCandidate((brandKit as TenantBrandKit).offer_summary || null),
  };
}

function hasExtractedSignals(brandKit: TenantBrandKit): boolean {
  return (
    brandKit.logo_urls.length > 0 ||
    brandKit.font_families.length > 0 ||
    brandKit.external_links.length > 0 ||
    brandKit.colors.palette.length > 0 ||
    !!brandKit.brand_voice_summary ||
    !!brandKit.offer_summary
  );
}

function hasLowQualitySignals(brandKit: TenantBrandKit): boolean {
  const hueBuckets = new Set(
    brandKit.colors.palette
      .map((value) => colorHueBucket(value))
      .filter((value): value is number => Number.isInteger(value)),
  );

  return (
    /[|•]/.test(brandKit.brand_name) ||
    brandKit.colors.palette.some((value) => !normalizeColor(value)) ||
    brandKit.font_families.some((value) => !normalizeFontFamilyCandidate(value)) ||
    (brandKit.colors.palette.length >= 5 && hueBuckets.size >= 4)
  );
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

  let html: string | null = null;
  try {
    html = await fetchText(input.brandUrl, fetchImpl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`brand_kit_fetch_failed:${message}`);
  }

  if (!html) {
    throw new Error('brand_kit_fetch_failed:site_unavailable');
  }

  const stylesheetUrls = extractStylesheetUrls(html, input.brandUrl);
  const stylesheetTexts = (
    await Promise.all(
      stylesheetUrls.map(async (url) => {
        try {
          return await fetchText(url, fetchImpl, 'text/css,*/*;q=0.8');
        } catch {
          return null;
        }
      }),
    )
  ).filter((entry): entry is string => !!entry);
  const cssBlocks = [...extractInlineCss(html), ...stylesheetTexts];
  const canonicalUrl = extractCanonicalUrl(html, input.brandUrl) || input.brandUrl;
  const brandName = chooseBrandName(
    [
      extractMetaContent(html, 'property', 'og:site_name'),
      extractTitle(html),
      extractTextByTag(html, 'h1')[0] || null,
      ...extractImageCandidates(html).map((image) => image.alt || null),
    ],
    canonicalUrl,
  );

  if (!brandName) {
    throw new Error('brand_kit_insufficient_source_data:brand_name');
  }

  const brandKit: TenantBrandKit = {
    tenant_id: input.tenantId,
    source_url: input.brandUrl,
    canonical_url: canonicalUrl,
    brand_name: brandName,
    logo_urls: extractLogoUrls(html, input.brandUrl),
    colors: extractBrandColors(html, cssBlocks),
    font_families: extractFontFamilies(cssBlocks),
    external_links: extractExternalLinks(html, input.brandUrl),
    extracted_at: nowIso(),
    brand_voice_summary: deriveBrandVoiceSummary(html),
    offer_summary: deriveOfferSummary(html),
  };

  const normalizedBrandKit = normalizePersistedBrandKit(brandKit);
  assertTenantBrandKit(normalizedBrandKit);
  return normalizedBrandKit;
}

export function tenantBrandKitPath(tenantId: string): string {
  return resolveDataPath('generated', 'validated', tenantId, 'brand-kit.json');
}

export function loadTenantBrandKit(tenantId: string): TenantBrandKit | null {
  const filePath = tenantBrandKitPath(tenantId);
  if (!existsSync(filePath)) {
    return null;
  }

  const brandKit = normalizePersistedBrandKit(JSON.parse(readFileSync(filePath, 'utf8')) as TenantBrandKit);
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

  if (!hasExtractedSignals(brandKit) || hasLowQualitySignals(brandKit)) {
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
    saveTenantBrandKit(input.tenantId, existing);
    return {
      brandKit: existing,
      filePath: tenantBrandKitPath(input.tenantId),
    };
  }

  const brandKit = await extractBrandKitFromWebsite(input);
  const filePath = saveTenantBrandKit(input.tenantId, brandKit);
  return { brandKit, filePath };
}
