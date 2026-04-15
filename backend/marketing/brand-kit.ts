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

function normalizeWhitespace(value: string): string {
  return decodeHtmlEntities(value).replace(/\s+/g, ' ').trim();
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
  return normalizeWhitespace(title) || null;
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
    html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi),
    (match) => match[1]?.trim() || '',
  ).filter(Boolean);
}

function extractTextByTag(html: string, tagName: string): string[] {
  return Array.from(
    html.matchAll(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'gi')),
    (match) => normalizeWhitespace(match[1] || ''),
  ).filter(Boolean);
}

function htmlToText(html: string): string {
  return normalizeWhitespace(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  );
}

function cleanSentenceCandidate(value: string | null | undefined, maxLength = 220): string | null {
  const normalized = normalizeWhitespace(
    (value || '')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
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

  return unique(discovered.map((entry) => JSON.stringify(entry))).map((entry) => JSON.parse(entry));
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
  const normalized = normalizeWhitespace(candidate);
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
  source: 'img' | 'link' | 'og';
}): number {
  const lowerUrl = input.url.toLowerCase();
  const alt = normalizeWhitespace(input.alt || '').toLowerCase();
  const explicitLogoSignal =
    /logo|wordmark|logotype|lockup|brandlogo|brand-logo|brandmark|logo-mark/.test(lowerUrl) ||
    /logo|wordmark|logotype|lockup|brandlogo|brand-logo|brandmark|logo mark/.test(alt);
  let score = 0;

  if (input.source === 'img') score += 20;
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

function extractLogoUrls(html: string, baseUrl: string): string[] {
  const candidates: LogoCandidate[] = [];
  const ogImage = extractMetaContent(html, 'property', 'og:image');
  const ogImageUrl = resolveAbsoluteUrl(baseUrl, ogImage || '');
  if (ogImageUrl) {
    candidates.push({
      url: ogImageUrl,
      score: scoreLogoCandidate({ url: ogImageUrl, source: 'og' }),
    });
  }

  for (const match of html.matchAll(/<link\b([^>]*)>/gi)) {
    const attributes = parseTagAttributes(match[1] || '');
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

  for (const image of extractImageCandidates(html)) {
    const href = resolveAbsoluteUrl(baseUrl, image.url);
    if (!href) {
      continue;
    }
    if (!isLikelyFirstPartyLogo(href, baseUrl)) {
      continue;
    }
    candidates.push({
      url: href,
      score: scoreLogoCandidate({ url: href, alt: image.alt, source: 'img' }),
    });
  }

  const sorted = candidates
    .filter((candidate) => candidate.score >= 0)
    .sort((left, right) => right.score - left.score);
  const explicit = sorted.filter((candidate) => candidate.score >= 40);

  return unique((explicit.length > 0 ? explicit : sorted).map((candidate) => candidate.url)).slice(0, explicit.length > 0 ? 2 : 1);
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
      score: scoreLogoCandidate({ url, source: 'img' }),
    }))
    .filter((candidate) => candidate.score >= 0)
    .sort((left, right) => right.score - left.score);
  const explicit = candidates.filter((candidate) => candidate.score >= 40);
  return unique((explicit.length > 0 ? explicit : candidates).map((candidate) => candidate.url)).slice(0, explicit.length > 0 ? 2 : 1);
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
  return {
    tenant_id: brandKit.tenant_id,
    source_url: brandKit.source_url,
    canonical_url: brandKit.canonical_url ?? null,
    brand_name: brandKit.brand_name,
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
