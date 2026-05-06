import { extractAndSaveTenantBrandKit, tenantBrandKitPath } from '@/backend/marketing/brand-kit';
import type {
  MarketingBrandKitReference,
  MarketingJobRuntimeDocument,
} from '@/backend/marketing/runtime-state';
import {
  clampWeeklyWindowDays,
  redactTokenLikeString,
  sanitizeWeeklySocialContentPayload,
} from '@/backend/social-content/payload';

import {
  resolveDominantImageChannel,
  resolveSocialContentAspectRatio,
  type SocialContentAspectRatio,
} from './aspect-matrix';
import {
  SOCIAL_CONTENT_DEFAULT_SCOPE,
  SOCIAL_CONTENT_FORBIDDEN_VISUAL_PATTERNS,
  SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY,
  SOCIAL_CONTENT_WEEKLY_WORKFLOW_VERSION,
} from './defaults';

type UnknownRecord = Record<string, unknown>;
const MAX_IMAGE_CREATIVE_COUNT = 2;
const MAX_VIDEO_RENDER_COUNT = 1;

function stringValue(value: unknown): string {
  return typeof value === 'string' ? redactTokenLikeString(value).trim() : '';
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

function integerValue(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return fallback;
}

function clampCount(value: unknown, fallback: number, max: number): number {
  return Math.min(max, integerValue(value, fallback));
}

function requestRecord(doc: MarketingJobRuntimeDocument): UnknownRecord {
  const value = doc.inputs.request;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? sanitizeWeeklySocialContentPayload(value as UnknownRecord)
    : {};
}

export type SocialContentWeeklyBrandPayload = {
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
  };
  font_families: string[];
  offer: string;
  must_avoid_aesthetics: string[];
};

export type SocialContentRegenerateCreativeContext = {
  source_run_id: string;
  source_creative_id: string;
};

export type SocialContentWeeklyRequest = {
  workflow_key: string;
  workflow_version: string;
  aries_run_id: string;
  tenant_id: string;
  job_id: string;
  callback_url: string;
  input: {
    brand: SocialContentWeeklyBrandPayload;
    objective: {
      primary_goal: string;
      offer: string;
      audience: string;
    };
    competitor: {
      url: string;
      brand: string;
      facebook_page_url: string;
      ad_library_url: string;
    };
    scope: {
      window_days: number;
      static_post_count: number;
      image_creative_count: number;
      video_script_count: number;
      video_render_count: number;
      channels: string[];
    };
    constraints: {
      must_use_copy: string;
      must_avoid_aesthetics: string;
      forbidden_visual_patterns: string[];
    };
    media_requests?: Array<
      | {
          type: 'image.generate';
          aspect_ratio: SocialContentAspectRatio;
          count: number;
          target_channels: string[];
          creative_briefs: string[];
        }
      | {
          type: 'video.generate';
          aspect_ratio: '9:16';
          count: number;
          requires_human_approval: true;
          script_id: string;
        }
    >;
    regenerate_creative?: SocialContentRegenerateCreativeContext;
  };
};

function resolveCreativeBriefs(req: UnknownRecord): string[] {
  const configured = stringArray(req.creativeBriefs ?? req.creative_briefs);
  if (configured.length > 0) {
    return configured.slice(0, MAX_IMAGE_CREATIVE_COUNT);
  }
  const fallback = [
    stringValue(req.primaryGoal) || stringValue(req.goal),
    stringValue(req.offer),
    stringValue(req.styleVibe),
    stringValue(req.audience),
  ].filter((entry) => entry.length > 0);
  if (fallback.length > 0) {
    return fallback.slice(0, MAX_IMAGE_CREATIVE_COUNT);
  }
  return ['Create on-brand weekly social image creative.'];
}

function weeklySocialChannels(value: string[]): string[] {
  const allowedChannels = new Set<string>(SOCIAL_CONTENT_DEFAULT_SCOPE.channels);
  const channels = value.filter((channel) => allowedChannels.has(channel));
  return channels.length > 0 ? channels : [...SOCIAL_CONTENT_DEFAULT_SCOPE.channels];
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

function brandKitColors(brandKit: MarketingBrandKitReference | null | undefined): {
  primary: string | null;
  secondary: string | null;
  accent: string | null;
  palette: string[];
} {
  return {
    primary: brandKit?.colors?.primary ?? null,
    secondary: brandKit?.colors?.secondary ?? null,
    accent: brandKit?.colors?.accent ?? null,
    palette: Array.isArray(brandKit?.colors?.palette) ? [...brandKit.colors.palette] : [],
  };
}

function brandKitLogoUrls(brandKit: MarketingBrandKitReference | null | undefined): string[] {
  if (!Array.isArray(brandKit?.logo_urls)) return [];
  // sanitizeReference rejects data: URIs (inline SVG logos) by URL-parse
  // failure, so we pass them through verbatim and only sanitize http(s) URLs.
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
  const operatorVoice = stringValue(req.brandVoice);
  if (operatorVoice) return operatorVoice;
  const summary = brandKit?.brand_voice_summary;
  return typeof summary === 'string' ? stringValue(summary) : '';
}

function resolveBrandOffer(req: UnknownRecord, brandKit: MarketingBrandKitReference | null | undefined): string {
  const operatorOffer = stringValue(req.offer);
  if (operatorOffer) return operatorOffer;
  const summary = brandKit?.offer_summary;
  return typeof summary === 'string' ? stringValue(summary) : '';
}

function resolveMustAvoidAesthetics(req: UnknownRecord): string[] {
  const operatorRaw = typeof req.mustAvoidAesthetics === 'string' ? req.mustAvoidAesthetics : '';
  const operatorEntries = operatorRaw
    .split(/[\n;,]/)
    .map((entry) => stringValue(entry))
    .filter((entry) => entry.length > 0);
  return dedupeStrings([...operatorEntries, ...SOCIAL_CONTENT_FORBIDDEN_VISUAL_PATTERNS]);
}

export function buildSocialContentWeeklyRequest(input: {
  doc: MarketingJobRuntimeDocument;
  ariesRunId: string;
  callbackUrl: string;
  regenerateCreative?: SocialContentRegenerateCreativeContext;
}): SocialContentWeeklyRequest {
  const req = requestRecord(input.doc);
  const brandKit = input.doc.brand_kit ?? null;
  const configuredChannels = stringArray(req.channels);
  const imageTargetChannels = weeklySocialChannels(configuredChannels);
  const visualReferences = stringArray(req.visualReferences)
    .map(sanitizeReference)
    .filter((entry) => entry.length > 0);
  const requestedWindowDays = clampWeeklyWindowDays(
    req.windowDays ?? req.campaignWindowDays ?? SOCIAL_CONTENT_DEFAULT_SCOPE.window_days,
  );
  const imageCreativeCount = clampCount(
    req.imageCreativeCount ?? req.imageCreativesCount,
    SOCIAL_CONTENT_DEFAULT_SCOPE.image_creative_count,
    MAX_IMAGE_CREATIVE_COUNT,
  );
  const videoRenderCount = clampCount(
    req.videoRenderCount ?? req.renderVideoCount,
    SOCIAL_CONTENT_DEFAULT_SCOPE.video_render_count,
    MAX_VIDEO_RENDER_COUNT,
  );
  const mediaRequests: NonNullable<SocialContentWeeklyRequest['input']['media_requests']> = [];
  if (imageCreativeCount > 0) {
    const imageChannel = resolveDominantImageChannel(imageTargetChannels);
    mediaRequests.push({
      type: 'image.generate',
      aspect_ratio: resolveSocialContentAspectRatio({
        channel: imageChannel,
        postType: 'single_image',
      }),
      count: imageCreativeCount,
      target_channels: imageTargetChannels,
      creative_briefs: resolveCreativeBriefs(req),
    });
  }
  if (videoRenderCount > 0) {
    mediaRequests.push({
      type: 'video.generate',
      aspect_ratio: '9:16',
      count: videoRenderCount,
      requires_human_approval: true,
      script_id: stringValue(req.videoScriptId) || 'weekly_primary',
    });
  }

  const resolvedOffer = resolveBrandOffer(req, brandKit);

  return {
    workflow_key: SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY,
    workflow_version: SOCIAL_CONTENT_WEEKLY_WORKFLOW_VERSION,
    aries_run_id: input.ariesRunId,
    tenant_id: input.doc.tenant_id,
    job_id: input.doc.job_id,
    callback_url: input.callbackUrl,
    input: {
      brand: {
        url: stringValue(input.doc.inputs.brand_url),
        name: stringValue(req.businessName) || stringValue(brandKit?.brand_name),
        business_type: stringValue(req.businessType),
        voice: resolveBrandVoice(req, brandKit),
        style_vibe: stringValue(req.styleVibe),
        visual_references: visualReferences,
        logo_urls: brandKitLogoUrls(brandKit),
        colors: brandKitColors(brandKit),
        font_families: brandKitFontFamilies(brandKit),
        offer: resolvedOffer,
        must_avoid_aesthetics: resolveMustAvoidAesthetics(req),
      },
      objective: {
        primary_goal: stringValue(req.primaryGoal) || stringValue(req.goal),
        offer: resolvedOffer,
        audience: stringValue(req.audience),
      },
      competitor: {
        url: stringValue(input.doc.inputs.competitor_url),
        brand: stringValue(input.doc.inputs.competitor_brand),
        facebook_page_url: stringValue(input.doc.inputs.facebook_page_url),
        ad_library_url: stringValue(input.doc.inputs.ad_library_url),
      },
      scope: {
        window_days: requestedWindowDays,
        static_post_count: integerValue(req.staticPostCount, SOCIAL_CONTENT_DEFAULT_SCOPE.static_post_count),
        image_creative_count: imageCreativeCount,
        video_script_count: integerValue(req.videoScriptCount, SOCIAL_CONTENT_DEFAULT_SCOPE.video_script_count),
        video_render_count: videoRenderCount,
        channels: configuredChannels.length > 0 ? configuredChannels : [...SOCIAL_CONTENT_DEFAULT_SCOPE.channels],
      },
      constraints: {
        must_use_copy: stringValue(req.mustUseCopy),
        must_avoid_aesthetics: stringValue(req.mustAvoidAesthetics),
        forbidden_visual_patterns: Array.isArray(req.forbiddenVisualPatterns) && req.forbiddenVisualPatterns.length > 0
          ? [...req.forbiddenVisualPatterns]
          : [...SOCIAL_CONTENT_FORBIDDEN_VISUAL_PATTERNS],
      },
      ...(mediaRequests.length > 0 ? { media_requests: mediaRequests } : {}),
      ...(input.regenerateCreative
        ? {
            regenerate_creative: {
              source_run_id: input.regenerateCreative.source_run_id,
              source_creative_id: input.regenerateCreative.source_creative_id,
            },
          }
        : {}),
    },
  };
}

// Refresh the tenant brand kit before weekly submission. Mutates doc.brand_kit
// in place. Throws Error('needs_brand_kit:<reason>') on any failure so the port
// surfaces an operator-actionable error instead of crashing the run.
export async function ensureFreshBrandKitForWeeklyRun(input: {
  doc: MarketingJobRuntimeDocument;
  fetchImpl?: typeof fetch;
}): Promise<{ refreshed: boolean }> {
  const brandUrl = typeof input.doc.inputs.brand_url === 'string' ? input.doc.inputs.brand_url.trim() : '';
  if (!brandUrl) {
    throw new Error('needs_brand_kit:brand_url_missing');
  }

  const beforeExtractedAt = input.doc.brand_kit?.extracted_at ?? null;
  const beforeSourceUrl = input.doc.brand_kit?.source_url ?? null;

  let result;
  try {
    result = await extractAndSaveTenantBrandKit({
      tenantId: input.doc.tenant_id,
      brandUrl,
      fetchImpl: input.fetchImpl,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`needs_brand_kit:${message}`);
  }

  const filePath = result.filePath || tenantBrandKitPath(input.doc.tenant_id);
  input.doc.brand_kit = {
    path: filePath,
    source_url: result.brandKit.source_url,
    canonical_url: result.brandKit.canonical_url,
    brand_name: result.brandKit.brand_name,
    logo_urls: [...result.brandKit.logo_urls],
    colors: {
      primary: result.brandKit.colors.primary,
      secondary: result.brandKit.colors.secondary,
      accent: result.brandKit.colors.accent,
      palette: [...result.brandKit.colors.palette],
    },
    font_families: [...result.brandKit.font_families],
    external_links: result.brandKit.external_links.map((entry) => ({ ...entry })),
    extracted_at: result.brandKit.extracted_at,
    brand_voice_summary: result.brandKit.brand_voice_summary,
    offer_summary: result.brandKit.offer_summary,
  };

  const refreshed =
    beforeExtractedAt !== result.brandKit.extracted_at || beforeSourceUrl !== result.brandKit.source_url;

  return { refreshed };
}
