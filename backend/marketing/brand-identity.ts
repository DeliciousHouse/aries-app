import type { MarketingBrandIdentity } from '@/lib/api/marketing';
import { normalizeMarketingWebsiteUrl } from '@/lib/marketing-public-mode';

function stringValue(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((entry) => stringValue(entry))
        .filter((entry): entry is string => !!entry)
    : [];
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function joinReadableList(items: string[]): string | null {
  if (items.length === 0) {
    return null;
  }
  if (items.length === 1) {
    return items[0];
  }
  if (items.length === 2) {
    return `${items[0]} and ${items[1]}`;
  }
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

const HTML_FRAGMENT_PATTERN = /<\/?[a-z][^>]*>/gi;
const HTML_ENTITY_PATTERN = /&(?:nbsp|amp|lt|gt|quot|apos);/gi;
const ATTRIBUTE_PATTERN = /\b(?:class|className|style|id|href|src|data-[\w-]+)\s*=\s*["'][^"']*["']/gi;
const UTILITY_TOKEN_PATTERN =
  /\b(?:bg|text|font|tracking|max-w|min-w|min-h|max-h|from|via|to|px|py|pt|pr|pb|pl|mx|my|mt|mr|mb|ml|grid|flex|gap|items|justify|rounded|shadow|ring|border|leading|sm:|md:|lg:|xl:|2xl:|hover:|focus:|before:|after:|group-hover:)[^\s,;)]*/gi;
const CSS_REMNANT_PATTERN = /(?:^|\s)(?:[#.][a-z0-9_-]+|::?[a-z-]+|@media|var\(--[^)]+\)|theme\([^)]+\)|calc\([^)]+\))/gi;

export function normalizeBrandIdentityText(value: unknown): string | null {
  let text = stringValue(value);
  if (!text) {
    return null;
  }

  text = text
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(ATTRIBUTE_PATTERN, ' ')
    .replace(HTML_FRAGMENT_PATTERN, ' ')
    .replace(HTML_ENTITY_PATTERN, ' ')
    .replace(UTILITY_TOKEN_PATTERN, ' ')
    .replace(CSS_REMNANT_PATTERN, ' ')
    .replace(/[`*_#>{}[\]|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) {
    return null;
  }

  if (
    /(?:<|>|class=|classname=|bg-clip-text|bg-gradient|tracking-\[|from-\[#|via-\[#|to-\[#|var\(--|@media)/i.test(text)
  ) {
    return null;
  }

  return text;
}

function firstLandingHook(value: Record<string, unknown> | null): string | null {
  const hooks = recordValue(value?.hooks);
  if (!hooks) {
    return null;
  }

  const landingPageHooks = hooks['landing-page'];
  return normalizeBrandIdentityText(stringArray(landingPageHooks)[0]);
}

export function normalizeSourceFingerprint(value: unknown): string | null {
  return normalizeMarketingWebsiteUrl(stringValue(value));
}

export function sourceFingerprintFromRecord(record: Record<string, unknown> | null): string | null {
  if (!record) {
    return null;
  }

  const nestedBrandAnalysis = recordValue(record.brand_analysis);
  const nestedCreativeHandoff = recordValue(record.creative_handoff);
  const nestedCampaignPlan = recordValue(record.campaign_plan);
  const nestedReviewPacket = recordValue(record.review_packet);
  const nestedBrandProfilesRecord = recordValue(record.brand_profiles_record);
  const nestedProductionBrief = recordValue(record.production_brief);
  const nestedBrandIdentity = recordValue(record.brandIdentity || nestedProductionBrief?.brand_identity);
  const nestedProvenance = recordValue(nestedBrandIdentity?.provenance);

  return (
    normalizeSourceFingerprint(record.canonical_url) ||
    normalizeSourceFingerprint(record.source_url) ||
    normalizeSourceFingerprint(record.website_url) ||
    normalizeSourceFingerprint(record.brand_url) ||
    normalizeSourceFingerprint(nestedBrandAnalysis?.canonical_url) ||
    normalizeSourceFingerprint(nestedBrandAnalysis?.website_url) ||
    normalizeSourceFingerprint(nestedCreativeHandoff?.website_url) ||
    normalizeSourceFingerprint(nestedCampaignPlan?.canonical_url) ||
    normalizeSourceFingerprint(nestedCampaignPlan?.website_url) ||
    normalizeSourceFingerprint(nestedCampaignPlan?.brand_url) ||
    normalizeSourceFingerprint(nestedReviewPacket?.canonical_url) ||
    normalizeSourceFingerprint(nestedReviewPacket?.website_url) ||
    normalizeSourceFingerprint(nestedReviewPacket?.brand_url) ||
    normalizeSourceFingerprint(nestedBrandProfilesRecord?.canonical_url) ||
    normalizeSourceFingerprint(nestedBrandProfilesRecord?.website_url) ||
    normalizeSourceFingerprint(nestedBrandProfilesRecord?.brand_url) ||
    normalizeSourceFingerprint(nestedProvenance?.canonical_url) ||
    normalizeSourceFingerprint(nestedProvenance?.source_url) ||
    normalizeSourceFingerprint(nestedProvenance?.source_fingerprint)
  );
}

export function recordMatchesCurrentSource(
  record: Record<string, unknown> | null,
  currentSourceUrl?: string | null,
): boolean {
  const currentFingerprint = normalizeSourceFingerprint(currentSourceUrl);
  if (!record || !currentFingerprint) {
    return true;
  }

  const recordFingerprint = sourceFingerprintFromRecord(record);
  return !recordFingerprint || recordFingerprint === currentFingerprint;
}

type BuildBrandIdentityInput = {
  websiteUrl?: unknown;
  canonicalUrl?: unknown;
  audience?: unknown;
  positioning?: unknown;
  offer?: unknown;
  promise?: unknown;
  primaryCta?: unknown;
  proofPoints?: unknown;
  brandVoice?: unknown;
  styleVibe?: unknown;
  brandKit?: Record<string, unknown> | null;
  hooks?: Record<string, unknown> | null;
};

function parseHexLuminance(hex: string): number | null {
  const clean = hex.replace(/^#/, '');
  if (clean.length !== 3 && clean.length !== 6) return null;
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  if ([r, g, b].some((v) => Number.isNaN(v))) return null;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function parseHexHue(hex: string): number | null {
  const clean = hex.replace(/^#/, '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  if ([r, g, b].some((v) => Number.isNaN(v))) return null;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 0.05) return null; // achromatic
  let h = 0;
  const d = max - min;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return h * 360;
}

function colorMood(palette: string[]): string {
  const luminances = palette.map(parseHexLuminance).filter((v): v is number => v !== null);
  const hues = palette.map(parseHexHue).filter((v): v is number => v !== null);
  const avgLum = luminances.length > 0 ? luminances.reduce((a, b) => a + b, 0) / luminances.length : 0.5;
  const warmCount = hues.filter((h) => h < 60 || h > 300).length;
  const coolCount = hues.filter((h) => h >= 150 && h <= 270).length;
  const isWarm = warmCount > coolCount;
  const isDark = avgLum < 0.4;
  const isBright = avgLum > 0.65;

  if (isDark && isWarm) return 'Bold and warm with high-contrast depth';
  if (isDark && !isWarm) return 'Sleek and modern with cool undertones';
  if (isBright && isWarm) return 'Light and inviting with warm energy';
  if (isBright && !isWarm) return 'Bright and clean with a cool edge';
  if (isWarm) return 'Grounded and approachable with warm tones';
  return 'Balanced and professional with neutral clarity';
}

function fontMood(fonts: string[]): string | null {
  const lower = fonts.map((f) => f.toLowerCase()).join(' ');
  if (/serif(?!.*sans)/i.test(lower) && !/sans/i.test(lower)) return 'editorial typography';
  if (/mono|code|courier/i.test(lower)) return 'technical precision';
  if (/handwrit|script|cursive|brush/i.test(lower)) return 'handcrafted character';
  if (/display|playfair|dm\s?serif|lora|merriweather/i.test(lower)) return 'refined editorial type';
  return null;
}

function deriveStyleVibe(
  explicitStyleVibe: unknown,
  brandKit: Record<string, unknown> | null,
): string | null {
  const explicit = normalizeBrandIdentityText(explicitStyleVibe);
  if (explicit) {
    return explicit;
  }

  const colors = recordValue(brandKit?.colors);
  const palette = stringArray(colors?.palette);
  const fonts = stringArray(brandKit?.font_families);

  if (palette.length > 0 && fonts.length > 0) {
    const cm = colorMood(palette);
    const fm = fontMood(fonts);
    return fm ? `${cm} and ${fm}.` : `${cm}.`;
  }

  if (palette.length > 0) {
    return `${colorMood(palette)}.`;
  }

  if (fonts.length > 0) {
    const fm = fontMood(fonts);
    return fm ? `Typographic focus with ${fm}.` : 'Typographic and refined.';
  }

  return null;
}

function deriveToneOfVoice(brandVoice: unknown, brandKit: Record<string, unknown> | null): string | null {
  const explicitVoice = stringArray(brandVoice).map((entry) => normalizeBrandIdentityText(entry)).filter(Boolean) as string[];
  const readable = joinReadableList(explicitVoice);
  if (readable) {
    return readable.endsWith('.') ? readable : `${readable}.`;
  }

  return normalizeBrandIdentityText(brandKit?.brand_voice_summary);
}

export function buildMarketingBrandIdentity(input: BuildBrandIdentityInput): MarketingBrandIdentity | null {
  const websiteUrl = normalizeSourceFingerprint(input.websiteUrl);
  const canonicalUrl = normalizeSourceFingerprint(input.canonicalUrl) || websiteUrl;
  const audience = normalizeBrandIdentityText(input.audience);
  const positioning = normalizeBrandIdentityText(input.positioning);
  const offer = normalizeBrandIdentityText(input.offer);
  const promise =
    normalizeBrandIdentityText(input.promise) ||
    firstLandingHook(input.hooks || null) ||
    offer;
  const toneOfVoice = deriveToneOfVoice(input.brandVoice, input.brandKit || null);
  const styleVibe = deriveStyleVibe(input.styleVibe, input.brandKit || null);
  const primaryCta = normalizeBrandIdentityText(input.primaryCta);
  const proofPoints = stringArray(input.proofPoints).map((entry) => normalizeBrandIdentityText(entry)).filter(Boolean) as string[];
  const ctaStyle = primaryCta ? `Direct, action-oriented CTAs led by "${primaryCta}".` : null;
  const proofStyle = proofPoints.length > 0
    ? 'Proof-led messaging grounded in concrete outcomes and credibility signals.'
    : null;
  const summary = normalizeBrandIdentityText(
    [positioning, offer, promise]
      .filter((entry, index, values) => !!entry && values.indexOf(entry) === index)
      .join(' '),
  );

  if (!summary && !positioning && !audience && !offer && !promise && !toneOfVoice && !styleVibe && !ctaStyle && !proofStyle) {
    return null;
  }

  return {
    summary,
    positioning,
    audience,
    offer,
    promise,
    toneOfVoice,
    styleVibe,
    ctaStyle,
    proofStyle,
    provenance: {
      source_url: websiteUrl,
      canonical_url: canonicalUrl,
      source_fingerprint: canonicalUrl || websiteUrl,
    },
  };
}
