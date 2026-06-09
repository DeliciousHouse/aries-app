import {
  extractEnrichAndSaveTenantBrandKit,
  tenantBrandKitPath,
} from '@/backend/marketing/brand-kit';
import {
  marketingBrandKitReferenceFromTenantBrandKit,
  type SocialContentJobRuntimeDocument,
} from '@/backend/marketing/runtime-state';
import {
  clampWeeklyWindowDays,
  redactTokenLikeString,
  sanitizeWeeklySocialContentPayload,
} from '@/backend/social-content/payload';
import {
  buildBrandKitPayload,
  type SocialContentBrandPayload,
  type SocialContentObjectivePayload,
} from '@/backend/social-content/brand-kit-payload';

import {
  resolveDominantImageChannel,
  resolveSocialContentAspectRatio,
  type SocialContentAspectRatio,
} from './aspect-matrix';
import { isFeedLogoCompositeEnabled } from './feed-logo-composite-env';
import { isTasteBriefInjectionEnabled } from '@/backend/marketing/taste-brief-injection-env';
import type { TasteDimensions } from '@/backend/marketing/taste-profile-store';
import {
  SOCIAL_CONTENT_DEFAULT_SCOPE,
  SOCIAL_CONTENT_FORBIDDEN_VISUAL_PATTERNS,
  SOCIAL_CONTENT_MAX_IMAGE_CREATIVE_COUNT,
  SOCIAL_CONTENT_MAX_VIDEO_RENDER_COUNT,
  SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY,
  SOCIAL_CONTENT_WEEKLY_WORKFLOW_VERSION,
} from './defaults';

type UnknownRecord = Record<string, unknown>;
const MAX_IMAGE_CREATIVE_COUNT = SOCIAL_CONTENT_MAX_IMAGE_CREATIVE_COUNT;
const MAX_VIDEO_RENDER_COUNT = SOCIAL_CONTENT_MAX_VIDEO_RENDER_COUNT;

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

function requestRecord(doc: SocialContentJobRuntimeDocument): UnknownRecord {
  const value = doc.inputs.request;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? sanitizeWeeklySocialContentPayload(value as UnknownRecord)
    : {};
}

export type SocialContentWeeklyBrandPayload = SocialContentBrandPayload;

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
    objective: SocialContentObjectivePayload;
    competitor: {
      url: string;
      brand: string;
      facebook_page_url: string;
      ad_library_url: string;
    };
    scope: {
      window_days: number;
      static_post_count: number;
      story_count: number;
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

export function buildSocialContentWeeklyRequest(input: {
  doc: SocialContentJobRuntimeDocument;
  ariesRunId: string;
  callbackUrl: string;
  regenerateCreative?: SocialContentRegenerateCreativeContext;
}): SocialContentWeeklyRequest {
  const req = requestRecord(input.doc);
  const brandKit = input.doc.brand_kit ?? null;
  const configuredChannels = stringArray(req.channels);
  const imageTargetChannels = weeklySocialChannels(configuredChannels);
  const brandKitPayload = buildBrandKitPayload(input.doc, brandKit, req);
  const requestedWindowDays = clampWeeklyWindowDays(
    req.windowDays ?? req.postWindowDays ?? SOCIAL_CONTENT_DEFAULT_SCOPE.window_days,
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
  const resolvedOffer = brandKitPayload.objective.offer;

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
      brand: brandKitPayload.brand,
      objective: brandKitPayload.objective,
      competitor: {
        url: stringValue(input.doc.inputs.competitor_url),
        brand: stringValue(input.doc.inputs.competitor_brand),
        facebook_page_url: stringValue(input.doc.inputs.facebook_page_url),
        ad_library_url: stringValue(input.doc.inputs.ad_library_url),
      },
      scope: {
        window_days: requestedWindowDays,
        static_post_count: integerValue(req.staticPostCount, SOCIAL_CONTENT_DEFAULT_SCOPE.static_post_count),
        story_count: integerValue(req.storyCount ?? req.storiesCount, SOCIAL_CONTENT_DEFAULT_SCOPE.story_count),
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
/**
 * Append learned style/voice descriptors as a `; `-joined suffix on a brand
 * field, returning the base unchanged when there is nothing to add — so a
 * null/empty projection produces byte-identical output.
 */
function appendDescriptorSuffix(base: string, extra: string[]): string {
  const clean = extra.map((s) => s.trim()).filter(Boolean);
  if (clean.length === 0) return base;
  const suffix = clean.join('; ');
  return base ? `${base}; ${suffix}` : suffix;
}

/**
 * Merge learned descriptors into a brand string[] (e.g. must-avoid), deduped
 * case-insensitively against existing entries. Returns the base array reference
 * unchanged when there is nothing to add — so a null/empty projection produces
 * byte-identical output.
 */
function mergeDedupeDescriptors(base: string[], extra: string[]): string[] {
  const clean = extra.map((s) => s.trim()).filter(Boolean);
  if (clean.length === 0) return base;
  const seen = new Set(base.map((s) => s.trim().toLowerCase()));
  const merged = [...base];
  for (const e of clean) {
    const key = e.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(e);
    }
  }
  return merged;
}

export function buildProductionResumeContext(input: {
  doc: SocialContentJobRuntimeDocument;
  /** raw primary_output from doc.stages.research */
  researchOutput: Record<string, unknown> | null | undefined;
  /** raw primary_output from doc.stages.strategy */
  strategyOutput: Record<string, unknown> | null | undefined;
  /**
   * Pre-loaded per-tenant taste projection (loadTasteForBriefByTenant), preloaded
   * upstream in the async port so this synchronous builder does no DB read. When
   * null/undefined or every bucket is empty — or the brief-injection flag is OFF —
   * the produced prompts are byte-identical to today.
   */
  tasteProjection?: TasteDimensions | null;
}): ProductionResumeContext {
  const req = requestRecord(input.doc);
  const brandKit = input.doc.brand_kit ?? null;

  // --- brand profile (static, always available) ---
  const brandKitPayload = buildBrandKitPayload(input.doc, brandKit, req);
  const brandName = brandKitPayload.brand.name || 'the brand';
  const brandVoice = brandKitPayload.brand.voice;
  const styleVibe = brandKitPayload.brand.style_vibe;
  const offer = brandKitPayload.objective.offer;
  const palette = brandKitPayload.brand.colors.palette;
  const brandBackground = brandKitPayload.brand.colors.background;
  const brandMode = brandKitPayload.brand.colors.mode;
  const brandLogoUrl = brandKitPayload.brand.logo_urls.find((url) => !url.startsWith('data:'))
    ?? brandKitPayload.brand.logo_urls[0]
    ?? null;
  // When ON, Aries composites the real logo onto the rendered image afterward,
  // so the model must NOT draw one (else the final image carries two logos).
  const feedLogoComposite = isFeedLogoCompositeEnabled();
  const mustAvoid = brandKitPayload.brand.must_avoid_aesthetics;

  // PR2: fold learned per-tenant taste descriptors into the brand block when the
  // brief-injection flag is ON. Every merge is append-only and a no-op on empty,
  // so a null/empty projection (or flag OFF) leaves the prompt byte-identical.
  const tasteProjection = isTasteBriefInjectionEnabled() ? (input.tasteProjection ?? null) : null;
  const effectiveBrandVoice = appendDescriptorSuffix(brandVoice, tasteProjection?.voice_descriptors ?? []);
  const effectiveStyleVibe = appendDescriptorSuffix(styleVibe, tasteProjection?.style_descriptors ?? []);
  // Cap the base must-avoid to 6 FIRST (preserving today's exact output), then
  // append learned avoids uncapped — so a tenant's safety/forbidden defaults are
  // never dropped to make room, and a learned avoid is never silently truncated.
  const effectiveMustAvoid = mergeDedupeDescriptors(mustAvoid.slice(0, 6), tasteProjection?.avoid ?? []);
  const tasteAudience = (tasteProjection?.audience_descriptors ?? []).map((s) => s.trim()).filter(Boolean);
  const tasteAudienceLine = tasteAudience.length > 0
    ? `Audience focus (learned): ${tasteAudience.join('; ')}`
    : '';
  const configuredChannels = stringArray(req.channels);
  const imageTargetChannels = weeklySocialChannels(configuredChannels);
  const primaryChannel = resolveDominantImageChannel(imageTargetChannels);
  const aspectRatio = resolveSocialContentAspectRatio({ channel: primaryChannel, postType: 'single_image' });
  const windowDays = clampWeeklyWindowDays(
    req.windowDays ?? req.postWindowDays ?? SOCIAL_CONTENT_DEFAULT_SCOPE.window_days,
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
    if (effectiveBrandVoice) lines.push(`Brand voice: ${effectiveBrandVoice.slice(0, 200)}`);
    if (effectiveStyleVibe) lines.push(`Style and vibe: ${effectiveStyleVibe}`);
    if (palette.length > 0) lines.push(`Brand palette: ${palette.join(', ')}`);
    if (tasteAudienceLine) lines.push(tasteAudienceLine);
    if (brandMode === 'dark') {
      const bg = brandBackground || '#050505';
      lines.push(
        `CRITICAL BRAND REQUIREMENT — this is a DARK-themed brand. The image MUST have a dark, near-black background (${bg}). When you write this image's visual_prompt, it MUST explicitly describe a dark/near-black background and MUST NOT contain the words "bright", "white background", "light background", "soft white", or "studio". Use the brand's dark aesthetic; apply the brand palette as glowing accents on the dark background, not as a light backdrop.`,
      );
    } else if (brandMode === 'light') {
      lines.push(
        `Brand theme: light. Render on a light background${brandBackground ? ` (${brandBackground})` : ''} consistent with the brand.`,
      );
    } else if (brandBackground) {
      lines.push(`Brand background: ${brandBackground} — keep backgrounds consistent with this brand color.`);
    }
    if (feedLogoComposite) {
      lines.push(
        `Do NOT render, draw, or include any logo, wordmark, or brand mark in this image — the brand logo is added separately afterward. Keep the lower-right corner clean and uncluttered so a small logo can be placed there.`,
      );
    } else if (brandLogoUrl) {
      lines.push(
        `Brand logo: ${brandLogoUrl} — use the actual brand logo when a mark is shown; do NOT invent, redraw, or substitute a different logo.`,
      );
    }
    if (effectiveMustAvoid.length > 0) lines.push(`Must avoid: ${effectiveMustAvoid.join(', ')}`);

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
  contextLines.push('Return your results in this EXACT JSON shape. You MUST include BOTH content_package[] AND artifacts.creative_assets[]. One without the other is incomplete — content_package carries the post COPY (caption text, hooks, hashtags); creative_assets carries the rendered IMAGES. The Nth creative_asset corresponds to the Nth content_package entry via post_number.');
  contextLines.push('');
  contextLines.push('Required: include content_package[] with one entry per post:');
  contextLines.push('{');
  contextLines.push('  "post_number": 1,');
  contextLines.push('  "theme": "<short theme label>",');
  contextLines.push('  "hook": "<opening hook sentence — grabs attention>",');
  contextLines.push('  "body": "<2-4 sentence post body>",');
  contextLines.push('  "cta": "<call to action>",');
  contextLines.push('  "hashtags": ["#tag1", "#tag2", "#tag3"],');
  contextLines.push('  "platforms": ["instagram", "facebook"],');
  contextLines.push('  "format": "single_image",');
  contextLines.push(
    brandMode === 'dark'
      ? `  "visual_prompt": "<the image prompt — MUST describe a dark/near-black ${brandBackground || '#050505'} background with the brand palette as accents; NEVER bright/white/light/studio for this dark brand>"`
      : '  "visual_prompt": "<the image prompt used for this post>"',
  );
  contextLines.push('}');
  contextLines.push('');
  if (brandMode === 'dark') {
    contextLines.push(
      `NON-NEGOTIABLE: this brand is DARK. Every image you generate MUST have a dark, near-black background (${brandBackground || '#050505'}). Do NOT produce bright, white, light, or "soft white studio" backgrounds — a light background is a brand violation and will be rejected.`,
    );
    contextLines.push('');
  }
  contextLines.push('Required: when you finish image_generate, place the results in your final response under `artifacts.creative_assets[]` with this shape per item:');
  contextLines.push('{');
  contextLines.push('  "assetId": "img_1",');
  contextLines.push('  "type": "generated_image",');
  contextLines.push('  "path": "<absolute path returned by image_generate>",');
  contextLines.push('  "placement": "<which post number>",');
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
  doc: SocialContentJobRuntimeDocument;
  fetchImpl?: typeof fetch;
}): Promise<{ refreshed: boolean; enriched: boolean }> {
  const brandUrl = typeof input.doc.inputs.brand_url === 'string' ? input.doc.inputs.brand_url.trim() : '';
  if (!brandUrl) {
    throw new Error('needs_brand_kit:brand_url_missing');
  }

  const beforeExtractedAt = input.doc.brand_kit?.extracted_at ?? null;
  const beforeSourceUrl = input.doc.brand_kit?.source_url ?? null;

  // Extract operator-supplied brand overrides from the campaign request so that
  // enrichment fills gaps only and never overwrites explicit operator values.
  const docReq = requestRecord(input.doc);
  const opStyleVibe = typeof docReq.styleVibe === 'string' && docReq.styleVibe.trim()
    ? docReq.styleVibe.trim()
    : null;
  const opBrandVoice = typeof docReq.brandVoice === 'string' && docReq.brandVoice.trim()
    ? docReq.brandVoice.trim()
    : null;

  let result;
  try {
    result = await extractEnrichAndSaveTenantBrandKit({
      tenantId: input.doc.tenant_id,
      brandUrl,
      fetchImpl: input.fetchImpl,
      operatorOverrides: (opStyleVibe || opBrandVoice)
        ? { styleVibe: opStyleVibe, brandVoice: opBrandVoice }
        : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`needs_brand_kit:${message}`);
  }

  const filePath = result.filePath || tenantBrandKitPath(input.doc.tenant_id);
  input.doc.brand_kit = marketingBrandKitReferenceFromTenantBrandKit(result.brandKit, filePath);

  const refreshed =
    beforeExtractedAt !== result.brandKit.extracted_at || beforeSourceUrl !== result.brandKit.source_url;

  return { refreshed, enriched: result.enriched };
}
