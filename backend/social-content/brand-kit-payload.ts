import { repairStaleMarketingOffer } from '@/backend/marketing/brand-kit';
import { stripLeadingDanglingArticleFragment } from '@/backend/marketing/brand-kit-enrich';
import type {
  MarketingBrandKitReference,
  SocialContentJobRuntimeDocument,
} from '@/backend/marketing/runtime-state';
import {
  redactTokenLikeString,
  sanitizeWeeklySocialContentPayload,
} from '@/backend/social-content/payload';
import { SOCIAL_CONTENT_FORBIDDEN_VISUAL_PATTERNS } from './defaults';

type UnknownRecord = Record<string, unknown>;

export type SocialContentBrandPayload = {
  url: string;
  name: string;
  business_type: string;
  voice: string;
  style_vibe: string;
  visual_references: string[];
  logo_urls: string[];
  colors: {
    primary: string | null;
    secondary: string | null;
    accent: string | null;
    palette: string[];
    background: string | null;
    mode: 'light' | 'dark' | null;
  };
  font_families: string[];
  offer: string;
  notes: string;
  must_avoid_aesthetics: string[];
};

export type SocialContentObjectivePayload = {
  primary_goal: string;
  offer: string;
  audience: string;
};

const NOTES_FALLBACK_BUDGET = 300;

function stringValue(value: unknown): string {
  return typeof value === 'string' ? redactTokenLikeString(value).trim() : '';
}

function brandKitStringValue(value: unknown): string {
  if (typeof value !== 'string') return '';
  return stripLeadingDanglingArticleFragment(redactTokenLikeString(value)) ?? '';
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => redactTokenLikeString(entry).trim())
    .filter((entry) => entry.length > 0);
}

function sanitizeReference(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    const sensitiveParams = [
      'token',
      'access_token',
      'refresh_token',
      'id_token',
      'client_secret',
      'api_key',
      'key',
      'signature',
      'sig',
    ];
    for (const param of sensitiveParams) {
      url.searchParams.delete(param);
    }
    return url.toString();
  } catch {
    return redactTokenLikeString(trimmed);
  }
}

function dedupeStrings(values: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function resolvedOnboarding(
  doc: SocialContentJobRuntimeDocument,
  onboarding: UnknownRecord | null | undefined,
): UnknownRecord {
  if (onboarding && typeof onboarding === 'object' && !Array.isArray(onboarding)) {
    return sanitizeWeeklySocialContentPayload(onboarding);
  }
  const value = doc.inputs.request;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? sanitizeWeeklySocialContentPayload(value as UnknownRecord)
    : {};
}

function brandKitColors(brandKit: MarketingBrandKitReference | null | undefined): SocialContentBrandPayload['colors'] {
  const mode = brandKit?.colors?.mode;
  return {
    primary: brandKit?.colors?.primary ?? null,
    secondary: brandKit?.colors?.secondary ?? null,
    accent: brandKit?.colors?.accent ?? null,
    palette: Array.isArray(brandKit?.colors?.palette) ? [...brandKit.colors.palette] : [],
    background: brandKit?.colors?.background ?? null,
    mode: mode === 'light' || mode === 'dark' ? mode : null,
  };
}

function brandKitLogoUrls(brandKit: MarketingBrandKitReference | null | undefined): string[] {
  if (!Array.isArray(brandKit?.logo_urls)) return [];
  return brandKit.logo_urls
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0)
    .map((entry) => (entry.startsWith('data:') ? entry : sanitizeReference(entry)))
    .filter((entry) => entry.length > 0);
}

function brandKitFontFamilies(brandKit: MarketingBrandKitReference | null | undefined): string[] {
  if (!Array.isArray(brandKit?.font_families)) return [];
  return dedupeStrings(brandKit.font_families);
}

function resolveBrandVoice(req: UnknownRecord, brandKit: MarketingBrandKitReference | null | undefined): string {
  const summary = brandKitStringValue(brandKit?.brand_voice_summary);
  const tone = brandKitStringValue(brandKit?.tone_of_voice);
  const operatorVoice = stringValue(req.brandVoice);
  const base = summary || operatorVoice;
  if (base && tone) return `${base} Tone: ${tone}.`;
  if (base) return base;
  if (tone) return `Tone: ${tone}.`;
  return '';
}

function resolveBusinessName(req: UnknownRecord, brandKit: MarketingBrandKitReference | null | undefined): string {
  const operatorName = stringValue(req.businessName);
  if (operatorName) return operatorName;
  const brandKitName = brandKit?.brand_name;
  return typeof brandKitName === 'string' ? stringValue(brandKitName) : '';
}

function resolveNotes(req: UnknownRecord, brandKit: MarketingBrandKitReference | null | undefined): string {
  const operatorNotes = stringValue(req.notes);
  if (operatorNotes) return operatorNotes;
  const summary = brandKit?.brand_voice_summary;
  if (typeof summary !== 'string') return '';
  const trimmed = brandKitStringValue(summary);
  if (!trimmed) return '';
  if (trimmed.length <= NOTES_FALLBACK_BUDGET) return trimmed;
  return `${trimmed.slice(0, NOTES_FALLBACK_BUDGET)}…`;
}

function resolveBrandOffer(req: UnknownRecord, brandKit: MarketingBrandKitReference | null | undefined): string {
  return (
    repairStaleMarketingOffer({
      offer: stringValue(req.offer) || brandKitStringValue(brandKit?.offer_summary) || null,
      brandName: stringValue(req.businessName) || brandKit?.brand_name || null,
      businessType: stringValue(req.businessType) || null,
      primaryGoal: stringValue(req.primaryGoal) || stringValue(req.goal) || null,
      brandVoice: stringValue(req.brandVoice) || brandKitStringValue(brandKit?.brand_voice_summary) || null,
      positioning: brandKitStringValue(brandKit?.positioning) || brandKitStringValue(brandKit?.offer_summary) || null,
      brandKitOfferSummary: brandKitStringValue(brandKit?.offer_summary) || null,
    }) || ''
  );
}

function resolveBrandStyleVibe(req: UnknownRecord, brandKit: MarketingBrandKitReference | null | undefined): string {
  const enriched = brandKitStringValue(brandKit?.style_vibe);
  if (enriched) return enriched;
  return stringValue(req.styleVibe) || '';
}

function resolveBrandAudience(req: UnknownRecord, brandKit: MarketingBrandKitReference | null | undefined): string {
  return stringValue(req.audience) || brandKitStringValue(brandKit?.audience) || '';
}

function resolveMustAvoidAesthetics(req: UnknownRecord): string[] {
  const operatorRaw = typeof req.mustAvoidAesthetics === 'string' ? req.mustAvoidAesthetics : '';
  const operatorEntries = operatorRaw
    .split(/[\n;,]/)
    .map((entry) => stringValue(entry))
    .filter((entry) => entry.length > 0);
  return dedupeStrings([...operatorEntries, ...SOCIAL_CONTENT_FORBIDDEN_VISUAL_PATTERNS]);
}

export function buildBrandKitPayload(
  doc: SocialContentJobRuntimeDocument,
  brandKit: MarketingBrandKitReference | null | undefined,
  onboarding: UnknownRecord | null | undefined,
): {
  brand: SocialContentBrandPayload;
  objective: SocialContentObjectivePayload;
} {
  const req = resolvedOnboarding(doc, onboarding);
  const resolvedOffer = resolveBrandOffer(req, brandKit);

  return {
    brand: {
      url: stringValue(doc.inputs.brand_url),
      name: resolveBusinessName(req, brandKit),
      business_type: stringValue(req.businessType),
      voice: resolveBrandVoice(req, brandKit),
      style_vibe: resolveBrandStyleVibe(req, brandKit),
      visual_references: stringArray(req.visualReferences)
        .map(sanitizeReference)
        .filter((entry) => entry.length > 0),
      logo_urls: brandKitLogoUrls(brandKit),
      colors: brandKitColors(brandKit),
      font_families: brandKitFontFamilies(brandKit),
      offer: resolvedOffer,
      notes: resolveNotes(req, brandKit),
      must_avoid_aesthetics: resolveMustAvoidAesthetics(req),
    },
    objective: {
      primary_goal: stringValue(req.primaryGoal) || stringValue(req.goal),
      offer: resolvedOffer,
      audience: resolveBrandAudience(req, brandKit),
    },
  };
}
