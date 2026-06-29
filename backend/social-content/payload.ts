import {
  SOCIAL_CONTENT_MAX_IMAGE_CREATIVE_COUNT,
  SOCIAL_CONTENT_MAX_VIDEO_RENDER_COUNT,
} from '@/backend/social-content/defaults';
import {
  DEFAULT_SOCIAL_CONTENT_CHANNELS,
  DEFAULT_SOCIAL_CONTENT_COUNTS,
  DEFAULT_SOCIAL_CONTENT_FORBIDDEN_PATTERNS,
} from '@/backend/social-content/types';
import { parseReelAudioMode } from '@/backend/marketing/reel-audio-mode';

const MIN_WEEKLY_WINDOW_DAYS = 1;
const MAX_WEEKLY_WINDOW_DAYS = 14;
const WINDOW_DAYS_MIN_ENV_KEY = 'ARIES_SOCIAL_CONTENT_WINDOW_DAYS_MIN';
const WINDOW_DAYS_MAX_ENV_KEY = 'ARIES_SOCIAL_CONTENT_WINDOW_DAYS_MAX';
const MAX_IMAGE_CREATIVE_COUNT = SOCIAL_CONTENT_MAX_IMAGE_CREATIVE_COUNT;
const MAX_VIDEO_RENDER_COUNT = SOCIAL_CONTENT_MAX_VIDEO_RENDER_COUNT;
const REDACTED_VALUE = '[redacted]';
const SENSITIVE_QUERY_PARAMS = [
  'access_token',
  'refresh_token',
  'id_token',
  'client_secret',
  'api_key',
  'token',
  'key',
  'signature',
  'sig',
];
const SENSITIVE_ASSIGNMENT_PATTERN =
  /\b(access_token|refresh_token|id_token|client_secret|api_key|api-key|authorization)\b\s*[:=]\s*(Bearer\s+)?[^\s&;,'"<>]+/gi;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const OPENAI_SECRET_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{8,}\b/g;
const COMMON_TOKEN_PATTERN =
  /\b(?:ya29\.[A-Za-z0-9._-]+|xox[baprs]-[A-Za-z0-9-]+|gh[pousr]_[A-Za-z0-9_]{20,})\b/g;

function sensitivePayloadKey(key: string): boolean {
  const segments = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const compact = segments.join('');

  return (
    segments.includes('token') ||
    segments.includes('secret') ||
    segments.includes('auth') ||
    segments.includes('authorization') ||
    segments.includes('oauth') ||
    compact === 'apikey' ||
    (segments.includes('api') && segments.includes('key'))
  );
}

function redactSensitiveUrlParams(value: string): string {
  try {
    const url = new URL(value);
    for (const param of SENSITIVE_QUERY_PARAMS) {
      url.searchParams.delete(param);
    }
    return url.toString();
  } catch {
    return value;
  }
}

export function redactTokenLikeString(value: string): string {
  const withoutUrlSecrets = redactSensitiveUrlParams(value);
  return withoutUrlSecrets
    .replace(SENSITIVE_ASSIGNMENT_PATTERN, (_match, key: string) => `${key}=${REDACTED_VALUE}`)
    .replace(BEARER_TOKEN_PATTERN, `Bearer ${REDACTED_VALUE}`)
    .replace(OPENAI_SECRET_KEY_PATTERN, REDACTED_VALUE)
    .replace(COMMON_TOKEN_PATTERN, REDACTED_VALUE);
}

function sanitizePayloadValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizePayloadValue(entry));
  }
  if (typeof value === 'string') {
    return redactTokenLikeString(value);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (sensitivePayloadKey(key)) {
      continue;
    }
    sanitized[key] = sanitizePayloadValue(entry);
  }
  return sanitized;
}

function parseInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function configuredWindowDayBounds(): { min: number; max: number } {
  const configuredMin = parseInteger(process.env[WINDOW_DAYS_MIN_ENV_KEY]);
  const configuredMax = parseInteger(process.env[WINDOW_DAYS_MAX_ENV_KEY]);

  const min = Math.max(1, configuredMin ?? MIN_WEEKLY_WINDOW_DAYS);
  const max = Math.max(min, configuredMax ?? MAX_WEEKLY_WINDOW_DAYS);

  return { min, max };
}

export function clampWeeklyWindowDays(value: unknown): number {
  const requestedDays = parseInteger(value) ?? DEFAULT_SOCIAL_CONTENT_COUNTS.postWindowDays;
  const bounds = configuredWindowDayBounds();
  return Math.min(bounds.max, Math.max(bounds.min, requestedDays));
}

function parseBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
      return true;
    }
    if (normalized === 'false' || normalized === '0' || normalized === 'no') {
      return false;
    }
  }
  return null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean);
}

export function sanitizeWeeklySocialContentPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return sanitizePayloadValue(payload) as Record<string, unknown>;
}

export function normalizeWeeklySocialContentPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const nextPayload = sanitizeWeeklySocialContentPayload(payload);

  const staticPostCount =
    parseInteger(nextPayload.staticPostCount) ??
    parseInteger(nextPayload.staticPostsCount) ??
    DEFAULT_SOCIAL_CONTENT_COUNTS.staticPostCount;
  const storyCount =
    parseInteger(nextPayload.storyCount) ??
    parseInteger(nextPayload.storiesCount) ??
    DEFAULT_SOCIAL_CONTENT_COUNTS.storyCount;
  const imageCreativeCount =
    parseInteger(nextPayload.imageCreativeCount) ??
    parseInteger(nextPayload.imageCreativesCount) ??
    DEFAULT_SOCIAL_CONTENT_COUNTS.imageCreativeCount;
  const videoScriptCount =
    parseInteger(nextPayload.videoScriptCount) ??
    parseInteger(nextPayload.videoScriptsCount) ??
    DEFAULT_SOCIAL_CONTENT_COUNTS.videoScriptCount;
  const videoRenderCount =
    parseInteger(nextPayload.videoRenderCount) ??
    (() => {
      const renderFlag = parseBoolean(nextPayload.renderVideoAfterApproval);
      if (renderFlag === true) {
        return 1;
      }
      if (renderFlag === false) {
        return 0;
      }
      return null;
    })() ??
    DEFAULT_SOCIAL_CONTENT_COUNTS.videoRenderCount;

  const postWindowDays = clampWeeklyWindowDays(
    nextPayload.postWindowDays ?? nextPayload.windowDays,
  );

  const channels = asStringArray(nextPayload.channels);
  const normalizedChannels = channels.length > 0 ? channels : [...DEFAULT_SOCIAL_CONTENT_CHANNELS];

  const forbiddenPatterns = asStringArray(nextPayload.forbiddenVisualPatterns);
  const normalizedForbiddenPatterns =
    forbiddenPatterns.length > 0
      ? forbiddenPatterns
      : [...DEFAULT_SOCIAL_CONTENT_FORBIDDEN_PATTERNS];

  nextPayload.postWindowDays = postWindowDays;
  nextPayload.windowDays = postWindowDays;
  nextPayload.staticPostCount = Math.max(0, staticPostCount);
  nextPayload.storyCount = Math.max(0, storyCount);
  nextPayload.imageCreativeCount = Math.min(MAX_IMAGE_CREATIVE_COUNT, Math.max(0, imageCreativeCount));
  nextPayload.videoScriptCount = Math.max(0, videoScriptCount);
  nextPayload.videoRenderCount = Math.min(MAX_VIDEO_RENDER_COUNT, Math.max(0, videoRenderCount));
  nextPayload.channels = normalizedChannels;
  nextPayload.forbiddenVisualPatterns = normalizedForbiddenPatterns;

  // Optional per-job reel audio override (music | voiceover | both). Normalize
  // to a canonical value so it lands clean in doc.inputs.request.reelAudioMode;
  // an absent/unrecognized value is dropped so the per-tenant default applies.
  const reelAudioMode = parseReelAudioMode(nextPayload.reelAudioMode);
  if (reelAudioMode) {
    nextPayload.reelAudioMode = reelAudioMode;
  } else {
    delete nextPayload.reelAudioMode;
  }

  // Backwards-compatible fields consumed by existing marketing orchestrator.
  nextPayload.staticPostsCount = nextPayload.staticPostCount;
  nextPayload.storiesCount = nextPayload.storyCount;
  nextPayload.imageCreativesCount = nextPayload.imageCreativeCount;
  nextPayload.videoScriptsCount = nextPayload.videoScriptCount;
  nextPayload.renderVideoAfterApproval = Math.min(MAX_VIDEO_RENDER_COUNT, Math.max(0, videoRenderCount)) > 0;

  return nextPayload;
}
