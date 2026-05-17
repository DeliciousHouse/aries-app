import {
  extractAndSaveTenantBrandKit,
  repairStaleMarketingOffer,
  tenantBrandKitPath,
} from '@/backend/marketing/brand-kit';
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
const MAX_IMAGE_CREATIVE_COUNT = 3;
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
  notes: string;
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

// repairedOffer is the already-repaired offer string (from resolveBrandOffer).
// It must be passed in here so that stale product copy (e.g. leather-goods text)
// cannot leak into creative_briefs via the raw req.offer fallback — Copilot
// flagged this gap: the offer repair ran after mediaRequests was built, so the
// raw req.offer was still being used for creative_briefs construction.
function resolveCreativeBriefs(req: UnknownRecord, repairedOffer: string): string[] {
  const configured = stringArray(req.creativeBriefs ?? req.creative_briefs);
  if (configured.length > 0) {
    return configured.slice(0, MAX_IMAGE_CREATIVE_COUNT);
  }
  const fallback = [
    stringValue(req.primaryGoal) || stringValue(req.goal),
    repairedOffer,
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

function resolveBusinessName(req: UnknownRecord, brandKit: MarketingBrandKitReference | null | undefined): string {
  const operatorName = stringValue(req.businessName);
  if (operatorName) return operatorName;
  const brandKitName = brandKit?.brand_name;
  return typeof brandKitName === 'string' ? stringValue(brandKitName) : '';
}

const NOTES_FALLBACK_BUDGET = 300;

function resolveNotes(req: UnknownRecord, brandKit: MarketingBrandKitReference | null | undefined): string {
  const operatorNotes = stringValue(req.notes);
  if (operatorNotes) return operatorNotes;
  const summary = brandKit?.brand_voice_summary;
  if (typeof summary !== 'string') return '';
  const trimmed = stringValue(summary);
  if (!trimmed) return '';
  if (trimmed.length <= NOTES_FALLBACK_BUDGET) return trimmed;
  return `${trimmed.slice(0, NOTES_FALLBACK_BUDGET)}…`;
}

function resolveBrandOffer(req: UnknownRecord, brandKit: MarketingBrandKitReference | null | undefined): string {
  return (
    repairStaleMarketingOffer({
      offer: stringValue(req.offer) || brandKit?.offer_summary || null,
      brandName: stringValue(req.businessName) || brandKit?.brand_name || null,
      businessType: stringValue(req.businessType) || null,
      primaryGoal: stringValue(req.primaryGoal) || stringValue(req.goal) || null,
      brandVoice: stringValue(req.brandVoice) || brandKit?.brand_voice_summary || null,
      positioning: brandKit?.offer_summary || null,
      brandKitOfferSummary: brandKit?.offer_summary || null,
    }) || ''
  );
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
  // Resolve and repair the offer before building mediaRequests so that stale
  // product copy cannot leak into creative_briefs via the raw req.offer path.
  const resolvedOffer = resolveBrandOffer(req, brandKit);

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
      creative_briefs: resolveCreativeBriefs(req, resolvedOffer),
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
        name: resolveBusinessName(req, brandKit),
        business_type: stringValue(req.businessType),
        voice: resolveBrandVoice(req, brandKit),
        style_vibe: stringValue(req.styleVibe),
        visual_references: visualReferences,
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

export type ProductionResumeImagePrompt = {
  imageIndex: number; // 1-based
  totalImages: number;
  prompt: string;
  aspectRatio: string;
  targetChannels: string[];
};

export type ProductionResumeContext = {
  imagePrompts: ProductionResumeImagePrompt[];
  /** Serialised block ready to append to the Hermes resume `input` string. */
  contextBlock: string;
};

/**
 * Builds per-image prompt context for the production-stage resume call.
 *
 * Called with the research and strategy primary_output blobs from the job's
 * runtime state. Produces a context block that Hermes receives as part of the
 * production-turn `input` string, so it has everything it needs at the moment
 * it decides to call `image_generate`.
 *
 * Falls back gracefully when research/strategy output is missing — the prompt
 * degrades to static brand profile data from the initial request.
 */
export function buildProductionResumeContext(input: {
  doc: MarketingJobRuntimeDocument;
  /** raw primary_output from doc.stages.research */
  researchOutput: Record<string, unknown> | null | undefined;
  /** raw primary_output from doc.stages.strategy */
  strategyOutput: Record<string, unknown> | null | undefined;
}): ProductionResumeContext {
  const req = requestRecord(input.doc);
  const brandKit = input.doc.brand_kit ?? null;

  // --- brand profile (static, always available) ---
  const brandName = stringValue(req.businessName) || stringValue(brandKit?.brand_name) || 'the brand';
  const brandVoice = resolveBrandVoice(req, brandKit);
  const styleVibe = stringValue(req.styleVibe);
  const offer = resolveBrandOffer(req, brandKit);
  const palette = brandKitColors(brandKit).palette;
  const mustAvoid = resolveMustAvoidAesthetics(req);
  const configuredChannels = stringArray(req.channels);
  const imageTargetChannels = weeklySocialChannels(configuredChannels);
  const primaryChannel = resolveDominantImageChannel(imageTargetChannels);
  const aspectRatio = resolveSocialContentAspectRatio({ channel: primaryChannel, postType: 'single_image' });
  const windowDays = clampWeeklyWindowDays(
    req.windowDays ?? req.campaignWindowDays ?? SOCIAL_CONTENT_DEFAULT_SCOPE.window_days,
  );
  const imageCreativeCount = clampCount(
    req.imageCreativeCount ?? req.imageCreativesCount,
    SOCIAL_CONTENT_DEFAULT_SCOPE.image_creative_count,
    MAX_IMAGE_CREATIVE_COUNT,
  );
  const totalImages = Math.max(1, imageCreativeCount);

  // --- channel aspect-ratio human hint ---
  const aspectHintByChannel: Record<string, string> = {
    instagram: 'portrait 4:5',
    meta: 'square 1:1 or landscape 1.91:1',
  };
  const channelAspectHints = imageTargetChannels
    .map((ch) => `${ch}: ${aspectHintByChannel[ch] ?? aspectRatio}`)
    .join(', ');

  // --- research signal (best-effort) ---
  const researchLines: string[] = [];
  if (input.researchOutput && typeof input.researchOutput === 'object') {
    const ro = input.researchOutput as Record<string, unknown>;
    const positioning = typeof ro.positioning === 'string' ? ro.positioning.trim() : '';
    if (positioning) researchLines.push(`Brand positioning: ${positioning}`);
    const audience = ro.audience_insights;
    if (audience && typeof audience === 'object' && !Array.isArray(audience)) {
      const primary = (audience as Record<string, unknown>).primary;
      if (Array.isArray(primary) && primary.length > 0) {
        researchLines.push(`Target audience: ${primary.slice(0, 2).join('; ')}`);
      }
      const painPoints = (audience as Record<string, unknown>).pain_points;
      if (Array.isArray(painPoints) && painPoints.length > 0) {
        researchLines.push(`Key pain points: ${painPoints.slice(0, 2).join('; ')}`);
      }
    }
    const channelNotes = ro.channel_notes;
    if (channelNotes && typeof channelNotes === 'object' && !Array.isArray(channelNotes)) {
      const cn = channelNotes as Record<string, unknown>;
      for (const ch of imageTargetChannels) {
        if (typeof cn[ch] === 'string') {
          researchLines.push(`${ch} creative direction: ${(cn[ch] as string).slice(0, 200)}`);
        }
      }
    }
    const conclusion = typeof ro.recommended_research_conclusion === 'string'
      ? ro.recommended_research_conclusion.trim().slice(0, 300)
      : '';
    if (conclusion) researchLines.push(`Research conclusion: ${conclusion}`);
  }

  // --- strategy signal (best-effort) ---
  const strategyLines: string[] = [];
  if (input.strategyOutput && typeof input.strategyOutput === 'object') {
    const so = input.strategyOutput as Record<string, unknown>;
    const summary = typeof so.strategySummary === 'string' ? so.strategySummary.trim().slice(0, 300) : '';
    if (summary) strategyLines.push(`Strategy summary: ${summary}`);
    const creative = so.creativeDirection;
    if (creative && typeof creative === 'object' && !Array.isArray(creative)) {
      const cd = creative as Record<string, unknown>;
      const visualStyle = typeof cd.visualStyle === 'string' ? cd.visualStyle.trim() : '';
      if (visualStyle) strategyLines.push(`Visual style: ${visualStyle}`);
      const motifs = Array.isArray(cd.recommendedVisualMotifs) ? cd.recommendedVisualMotifs.slice(0, 4).join(', ') : '';
      if (motifs) strategyLines.push(`Recommended visual motifs: ${motifs}`);
      const avoid = Array.isArray(cd.avoid) ? cd.avoid.slice(0, 4).join(', ') : '';
      if (avoid) strategyLines.push(`Visuals to avoid: ${avoid}`);
    }
    const channelAdapt = so.channelAdaptation;
    if (channelAdapt && typeof channelAdapt === 'object' && !Array.isArray(channelAdapt)) {
      const ca = channelAdapt as Record<string, unknown>;
      for (const ch of imageTargetChannels) {
        if (typeof ca[ch] === 'string') {
          strategyLines.push(`${ch} channel adaptation: ${(ca[ch] as string).slice(0, 200)}`);
        }
      }
    }
  }

  // --- per-image prompt construction ---
  const imagePrompts: ProductionResumeImagePrompt[] = [];
  for (let i = 0; i < totalImages; i++) {
    const imageIndex = i + 1;
    const lines: string[] = [
      `Generate an image to use for social media content.`,
      `This is part of a ${windowDays}-day collection of posts to publish throughout the week.`,
      `This is image ${imageIndex} of ${totalImages}.`,
      ``,
      `Brand: ${brandName}`,
    ];
    if (offer) lines.push(`Offer: ${offer}`);
    if (brandVoice) lines.push(`Brand voice: ${brandVoice.slice(0, 200)}`);
    if (styleVibe) lines.push(`Style and vibe: ${styleVibe}`);
    if (palette.length > 0) lines.push(`Brand palette: ${palette.join(', ')}`);
    if (mustAvoid.length > 0) lines.push(`Must avoid: ${mustAvoid.slice(0, 6).join(', ')}`);

    if (researchLines.length > 0) {
      lines.push('');
      lines.push('Brand and audience research:');
      lines.push(...researchLines);
    }

    if (strategyLines.length > 0) {
      lines.push('');
      lines.push('Creative strategy:');
      lines.push(...strategyLines);
    }

    lines.push('');
    lines.push(`Target platforms: ${imageTargetChannels.join(', ')}`);
    lines.push(`Aspect ratio: ${aspectRatio} (${channelAspectHints})`);
    lines.push(`Use ${aspectRatio} framing to maximise visual impact on these platforms.`);

    imagePrompts.push({
      imageIndex,
      totalImages,
      prompt: lines.filter((l) => l !== '' || lines[lines.indexOf(l) - 1] !== '').join('\n'),
      aspectRatio,
      targetChannels: [...imageTargetChannels],
    });
  }

  // --- serialised context block ---
  const contextLines: string[] = [
    `Production context (${totalImages} image${totalImages === 1 ? '' : 's'} requested):`,
  ];
  for (const img of imagePrompts) {
    contextLines.push(`--- Image ${img.imageIndex} of ${img.totalImages} ---`);
    contextLines.push(img.prompt);
  }
  contextLines.push('');
  contextLines.push('Return your results in this EXACT JSON shape:');
  contextLines.push('');
  contextLines.push('When you finish image_generate, place the results in your final response under `artifacts.creative_assets[]` with this shape per item:');
  contextLines.push('');
  contextLines.push('{');
  contextLines.push('  "assetId": "img_0",');
  contextLines.push('  "type": "generated_image",');
  contextLines.push('  "path": "<absolute path returned by image_generate>",');
  contextLines.push('  "placement": "<which post>",');
  contextLines.push('  "prompt": "<the rendered prompt>"');
  contextLines.push('}');
  contextLines.push('');
  contextLines.push('The bridge will also accept `artifacts.images[]` with `{index, status:"generated", filePath, prompt, intendedUse}`, but `creative_assets` is preferred.');

  return {
    imagePrompts,
    contextBlock: contextLines.join('\n'),
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
