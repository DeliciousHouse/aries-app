import type { MarketingJobRuntimeDocument } from '@/backend/marketing/runtime-state';
import {
  clampWeeklyWindowDays,
  redactTokenLikeString,
  sanitizeWeeklySocialContentPayload,
} from '@/backend/social-content/payload';

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

export type SocialContentWeeklyRequest = {
  workflow_key: string;
  workflow_version: string;
  aries_run_id: string;
  tenant_id: string;
  job_id: string;
  callback_url: string;
  input: {
    brand: {
      url: string;
      name: string;
      business_type: string;
      voice: string;
      style_vibe: string;
      visual_references: string[];
    };
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
          aspect_ratio: '4:5';
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

export function buildSocialContentWeeklyRequest(input: {
  doc: MarketingJobRuntimeDocument;
  ariesRunId: string;
  callbackUrl: string;
}): SocialContentWeeklyRequest {
  const req = requestRecord(input.doc);
  const configuredChannels = stringArray(req.channels);
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
    mediaRequests.push({
      type: 'image.generate',
      aspect_ratio: '4:5',
      count: imageCreativeCount,
      target_channels: configuredChannels.length > 0 ? [...configuredChannels] : [...SOCIAL_CONTENT_DEFAULT_SCOPE.channels],
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
        name: stringValue(req.businessName) || stringValue(input.doc.brand_kit?.brand_name),
        business_type: stringValue(req.businessType),
        voice: stringValue(req.brandVoice),
        style_vibe: stringValue(req.styleVibe),
        visual_references: visualReferences,
      },
      objective: {
        primary_goal: stringValue(req.primaryGoal) || stringValue(req.goal),
        offer: stringValue(req.offer),
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
    },
  };
}
